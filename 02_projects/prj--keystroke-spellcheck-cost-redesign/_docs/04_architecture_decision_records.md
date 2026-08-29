# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Tiered Correction Pipeline over Per-Keystroke LLM

**Status**: Accepted

**Context**: The naive design is one model inference per keystroke for 10M DAU. The Fermi estimate in [Scenario](./01_scenario_and_requirements.md) puts that at ~1.7M QPS at peak interactive latency, ~34,000 GPUs, **~$30–50M/month**. Unit-cost knobs (smaller model, quantization, reserved SKUs) stack to maybe 10–20x. They do not reach 100x. No production editor actually runs this design; the ones that use models already tier.

The expected redesign, and the one this project commits to, is a **three-tier pipeline**: client dictionary / local candidates first, shared cache second, batched LLM last. The GPU is residual-only.

**Decision**: Do not put a language model on the keystroke path. Classify on-device; network only for residuals after a trigger; cache; then a small batched model. A "temporary" flag that calls the LLM on `keydown` for a percentage of users is the naive design and is forbidden, including as a debug switch in production.

**Consequences**:
- (+) GPU fleet shrinks by two to three orders of magnitude before serving tricks are applied.
- (+) Ordinary typos stay as fast as today's Hunspell-class checkers.
- (+) Offline and degraded networks still spell-check.
- (–) Contextual / long-range errors the model *could* have caught mid-keystroke are delayed to pause, or missed if they never become residual.
- (–) Three tiers to operate, version, and explain in a review. A single "just call GPT" diagram is easier to sell and more expensive to run.
- **Alternative rejected**: "Buy more GPUs / a cheaper SKU." Arithmetic does not close. See Fermi sensitivity: a 5x miss on QPS/GPU still leaves tens of millions.
- **Alternative rejected**: Vendor API per keystroke. Rate limits fire before the invoice does. Cheap-model token dollars are still ~$28M/month *if* the volume were accepted, which it will not be.
- **Alternative rejected**: A 70B "quality" model on the residual. That recreates unit-cost disaster on a smaller stream and destroys batching density. Residual quality comes from a *task* model, not a general chatbot.
- **Revisit trigger**: DAU or \(k\) drops so far that naive peak QPS fits in a handful of GPUs *and* product demands mid-keystroke model opinions in writing. Then this ADR is overkill, not wrong. Do not revisit because a demo looked cooler streaming tokens.

## ADR-002: Debounce / Pause-Triggered Invocation over Per-Keystroke Invocation

**Status**: Accepted

**Context**: Even a tiny model cannot batch at keystroke SLO. The user-visible unit of spelling is the *word*, not the grapheme. Existing desktop and browser spell-checkers already wait for word boundary. Mid-word underlines (`t` → `te` → `teh`) are flicker, not quality.

Idle timeout covers "user is staring at `seperate`." Word boundary covers the common case. Per-keystroke is the remaining option and is the cost explosion.

**Decision**: Residual network work fires on **word boundary, punctuation, idle \(T_{idle}\) (working 400 ms), or blur** — never on `keydown`. Coalesce by token span and buffer generation. Per-session residual cap. Paste is a windowed event, not a fan-out.

**Consequences**:
- (+) ~5–6x call reduction before client triage, from geometry of words vs keys.
- (+) Batching becomes possible; QPS/GPU can move from ~50 to hundreds.
- (+) Matches user expectation from every spell-checker they already use. "Materially hurting UX" is not "we didn't underline on the third letter of the word."
- (–) Contextual suggestion arrives after pause. If product defines UX as "model opinion on every character," they are buying ADR-001's rejected alternative.
- (–) \(T_{idle}\) is a knob that will be bikeshedded. Tune with Phase 0 histograms; do not resolve the argument by going to zero.
- **Alternative rejected**: "Every 3 keystrokes" or "every character of the current word." Still O(keystroke). Still forbids batching. A constant factor of 3 is not 100x.
- **Alternative rejected**: Only word boundary, no idle. Misses the user who stops mid-typo and waits for the machine to notice. Idle is cheap; it is not a second architecture.
- **Not in v1**: Predictive "as you type" rewrite of the rest of the sentence. That is a different product with a different SLO and a different bill.

## ADR-003: Global Shared Cache over Per-User Cache or No Cache

**Status**: Accepted

**Context**: Residual errors are Zipf. `teh`, `recieve`, `seperate`, a few thousand confusable neighborhoods, account for a large share of misses. A per-user cache helps a single heavy typer and does nothing for the next 9,999,999 people who make the same typo. No cache leaves the entire residual on the GPU. A global cache is how you buy ~2–3x on the tail — and how you ship a wrong correction to everyone.

**Decision**: Cache-aside, **global** KV, key = `model_version | lang | normalized_token | left_ctx | right_ctx` (≤2 neighbors). TTL hours to a day. Confidence floor on write. No user id in key or value. No write-from-single-user-accept into the global map in v1. Confusables may be excluded from cache if poison risk dominates hit-rate gain. Kill switch: prefix and namespace delete.

**Consequences**:
- (+) Residual GPU QPS tracks *unique hot keys*, not DAU, once warm.
- (+) `ok` results are cached too, which is most of the win on confusables that are actually correct.
- (–) Blast radius of a bad entry is the fleet. Mitigation is TTL, version, no auto-apply, and a kill switch — not "we will notice."
- (–) Key design is a privacy surface. Too much context → PII and unique keys (misses). Too little → poison. This will take iteration in Phase 3.
- (–) Cache QPS is the residual rate, not the keystroke rate, but it is still a real system. Budget it. A laptop Redis is not the design at 10M DAU.
- **Alternative rejected**: No cache, "the residual is already 100x." True only if client+debounce hit the conservative 50–80x and serving stays cheap. Cache is the margin that makes 100x robust when residual rate is worse than the Fermi. Skipping it in v1 is allowed *only* if Phase 2 already lands inside the $500k/month cap with headroom. See Phase 3 gate.
- **Alternative rejected**: Per-user cache on device only. That is the client dictionary. It does not share Zipf across users. Keep personal dictionary on-device; do not confuse it with this component.
- **Alternative rejected**: Cache forever, no version. A model upgrade then serves stale wrongness indefinitely.
- **Revisit trigger**: measured hit rate <30% after key-tuning. Then stop paying for the cache; put the engineering into client coverage instead.

## ADR-004: Small Distilled / On-Device Model for Common-Case Triage over Always Using the Large Hosted LLM

**Status**: Accepted

**Context**: The common case is not "needs GPT-class reasoning." It is dictionary membership and 1–2 edit-distance. Hunspell-class tools have done this for decades at zero GPU. A large hosted model on that case is a very expensive `in_dictionary()` .

A tiny on-device neural model can pick up some real-word confusables without a network. It also has a CPU, battery, download-size, and eval cost. Many products will hit the coverage bar with dictionary + confusable list + hosted residual only.

**Decision**:
- **Required in v1:** on-device dictionary + edit-distance + a closed confusable list that marks `residual` (or local-suggest if a deterministic rule exists).
- **Optional:** tiny on-device neural (tens of MB class), behind a gate, with a kill for thermal/battery/input-hitch SLOs.
- **Required for residual miss:** small **task-distilled** hosted model (≤7B class working), not a general 70B chat model.
- The large general LLM is out of this path. If product wants it, that is an explicit rewrite/invoke feature, not spell-check.

**Consequences**:
- (+) Client tier can carry ~10–20x of the 100x without a cluster.
- (+) Residual model stays batchable and small; QPS/GPU stays in the hundreds.
- (–) Dictionary quality *is* the product bar for ordinary typos. Garbage language packs cannot be rescued by a smarter GPU.
- (–) Distillation is real ML work (data, eval, drift). Budget it. "We'll just prompt Llama 70B" is the rejected alternative wearing a hoodie.
- (–) On-device neural may never ship. That is a successful ADR if Hunspell + cache + small hosted model meet coverage.
- **Alternative rejected**: Always the largest hosted model, "quality first." Violates the cost requirement and the latency budget. Quality on *spell-check* is eval'd against a typo corpus, not an LMSYS arena score.
- **Alternative rejected**: Client-only forever, no hosted model. Cheapest. Misses real-word errors that product sold as the point of "LLM spell-check." If Phase 0 shows product only needed Hunspell, **stop this project after Phase 1**. That is a win, not a failure.
- **Alternative rejected**: Ship a 7B to every laptop. Download size, RAM, and thermal kill low-end DAU. That is not "client triage"; that is a second naive design on the edge.

## ADR-005: Fail-Open to Client-Only Spelling; Never Block Typing

**Status**: Accepted

**Context**: After the pivot, cache and inference are accelerators for a minority class. The editor's job is to accept keys. A 250 ms inference timeout is a missed upgrade, not an outage. Coupling caret progress to GPU health recreates a worse version of the naive design: not only expensive, but fragile.

**Decision**: Typing, local underlines, and local suggestions never wait on network. Cache/inference failure → no upgrade. Shed under load rather than queue. No modal, no retry-storm, no "spell-check unavailable" that eats keystrokes. Auto-replace from cache or model is off in v1 so a fail-open wrong guess cannot mutate the buffer.

**Consequences**:
- (+) GPU incidents are quality blips, not SEVs for "the editor is down."
- (+) Matches the cost model: we provision a small always-on inference floor, not a 34k-GPU HA pair.
- (–) During an inference outage, contextual coverage disappears. Product must accept that in writing. If they do not, they are asking for naive-scale HA, which is naive-scale cost.
- (–) Fail-open plus a poisoned cache is a bad combination (wrong suggestion, still shown). Mitigation: no auto-apply; client underline is separate; poison kill switch. Fail-open does *not* mean "trust the cache blindly."
- **Alternative rejected**: Fail-closed (block input or freeze underlines until the model returns). Turns a GPU blip into a typing outage. Unacceptable in an editor.
- **Alternative rejected**: Fail-open by sending *everything* to a backup vendor API. That is a surprise $28M bill during an incident. Shed to client-only.
- **Revisit trigger**: none for blocking typing. Revisit auto-apply only with a reviewed allow-list of local dictionary replacements (`teh` → `the`), never from live cache/model output.
