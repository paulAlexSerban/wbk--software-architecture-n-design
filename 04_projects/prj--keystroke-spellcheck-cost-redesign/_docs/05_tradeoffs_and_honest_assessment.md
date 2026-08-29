# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone orders GPUs.

The expected answer is a Fermi number plus four words: **don't call the model**. Those four words are correct. They are not free. Calling an LLM on every keystroke is the anti-pattern; listing "H100 list price" is unit-cost theater, not design. This page is the cost of the design.

## 1. What I would build

A **three-tier correction pipeline** inside the existing editor, plus a small inference cluster that is allowed to be down.

- **Client speller**: Hunspell-class dictionary, edit-distance, closed confusable list. This is the product for 90%+ of tokens. [ADR-004](./04_architecture_decision_records.md#adr-004).
- **Debounce / trigger**: word boundary, punctuation, \(T_{idle}\) ~400 ms, blur. Per-session cap. Paste windowed. [ADR-002](./04_architecture_decision_records.md#adr-002).
- **Edge cache**: global, versioned, TTL, no user id, confidence floor, kill switch. [ADR-003](./04_architecture_decision_records.md#adr-003).
- **Batched small task model** on cache miss only. p95 ≤ 250 ms. Shed, don't crawl.
- **Mixer**: client underline is immediate; upgrades are late and droppable. No auto-apply from cache/model.
- **Metrics that replace the Fermi table**: classification mix, residual QPS, hit rate, GPU $, accept rate.

I would not start by distilling a 70B model. I would not file a capacity request for 34,000 GPUs. I would not put a "LLM on every key, 1% of users" flag in production.

If Phase 0 shows that \(k\) is small, DAU is not 10M, or the product only needed Hunspell, this whole hosted path is overkill. Ship Phase 1. Stop. The four-word answer is for when the naive arithmetic is actually the alternative.

## 2. What I would give up

Be explicit. These are not "later." They are not in v1, and some of them are never in this design.

**Mid-keystroke model opinions.** The LLM will not underline on the third letter of a word. Users of Word already live with that. If a PM's demo of streaming tokens on every key is the UX spec, they asked for the $50M system. Do not "meet in the middle" at every-character-of-current-word. That is the $50M system with extra flicker.

**Long-range, document-level reasoning.** Pronoun agreement with a noun two pages up, tone, "make this more legal." Out of scope. Putting the document in the prompt on every pause re-enters the Fermi estimate through tokens instead of through QPS. A separate, user-invoked rewrite action is the honest home for that.

**Coverage of the weird tail.** A per-keystroke 70B *might* have caught a one-in-a-million contextual misspelling. We will miss some of those. Spell-check quality is measured on a corpus of real typos, not on whether the model can write poetry about the user's buffer.

**Cache-induced sameness and poison.** A global map means a bad Tuesday in the model can become everyone's suggestion until TTL or kill. You give up "each call is independent." You buy Zipf. You must staff a kill switch. Auto-apply is how poison becomes data loss; that is why it is off.

**The simplicity of a single API call in the `input` handler.** That function plus a vendor SDK is a demo. The replacement is a client library, a trigger state machine, a KV, a batcher, a distilled model, privacy review, and dashboards. Most of the project is the client and the eval, not the GPU.

**Privacy naïveté.** Neighborhood tokens leave the device. That is new collection vs. a local-only Hunspell. Legal has to say yes. If they say no to any off-device context, you can still do client + (maybe) token-only residual without neighbors — weaker real-word detection, cheaper politically. Do not sneak full sentences into the key after they said no.

**Perfect cost numbers on day one.** The Fermi is ±5–10x on assumptions. The 100x is a design target with a conservative compounding (5×10×2). Working math looks more like ~$20k–$125k/month GPU after levers. I would not promise $22k to finance. I would promise "two to three orders of magnitude below $50M, with a kill if we regress," and then Phase 0.

**Cheapness, if DAU is not actually 10M.** This architecture is justified by arithmetic at this scale. It is a lot of moving parts for a 50k-user internal tool. See §5.

## 3. What I would ask for, even though I expect friction

Ask **once, in writing, in Phase 0**, in parallel with instrumentation. Silence must not block measurement.

Ask product:

1. **Is a 100–300 ms delay after pause acceptable for contextual suggestions, with instant local underlines for `teh`?** Expected: "yes, if the red squiggle still shows." If they say every character must be model-backed, the meeting is over and the Fermi is the proposal. Make them sign the sentence.
2. **Is auto-replace in scope?** Expected: they want it for "magic." Refuse for cache/model output. Local dictionary auto-replace of a tiny allow-list is a separate, boring feature.
3. **Is this actually spell-check, or did someone sell grammar/tone?** If tone, this project is the wrong design. Do not stretch it.

Ask legal / privacy:

4. **May a normalized token plus two neighbors leave the device, without user id, with TTL'd cache?** Expected: a fight about whether neighbors are "content." Bring the strip rules (digits, emails, URLs). If the answer is local-only, Phase 2–3 shrink or die; Phase 1 still ships.
5. **Is sampled accept/reject of shown suggestions allowed?** Needed for the "materially hurting UX" clause. Full keystroke logs are not asked for and must not appear as a "compromise."

Ask infra / FinOps:

6. **What is the actual monthly GPU (or inference) ceiling for this feature?** If the ceiling is $5k, you may not get a hosted model at 10M DAU even after 100x, depending on residual rate. Then Phase 1-only, or a much smaller flagged cohort.
7. **Is a global KV with a kill switch something we already operate?** If not, the cache is a new service. Price that in calendar time, not just dollars.

What I would **not** ask for: a 70B cluster "so we have headroom," a keystroke analytics warehouse, a multi-cloud inference abstraction, a new editor rewrite. Those asks spend the year that belongs to the dictionary, the trigger, and the eval set.

## 4. Complexity inventory (what those four words cost)

| You take on | You shed |
| --- | --- |
| Client tokenizer + dictionary + confusable list + mixer | GPU on `keydown` |
| Trigger state machine, caps, paste policy | Interactive-latency serving at 1.7M QPS |
| Global KV, key design, TTL, poison runbook | 34,000-GPU HA story |
| Distilled task model + eval corpus | Vendor API at keystroke rate (429s as architecture) |
| Privacy review of cache keys | "It's just an API call" |
| Dashboards that can prove 100x | Fermi-as-folklore next year |
| Fail-open product expectation | SEV when the model blips |

Net: **more parts, in the right places.** The old design was simple *and unaffordable at the stated scale.* The new design is how real spelling products already work, plus a residual model. It is still months of client + eval plus a small serving stack, not an afternoon wrapping OpenAI.

### What is not worth building

- Per-keystroke inference "for a 0.1% experiment" in production.
- A general chatbot on this path.
- Document-sized prompts on pause.
- Per-user server-side typing profiles.
- On-device 7B.
- Auto-apply from live model/cache.
- A custom language model from scratch when a distilled speller and Hunspell exist.
- Compiling the whole cache into the client on day one. Hot-N promotion is Phase 4, if hit rates justify it.

## 5. When I would not do this

- **DAU is 50k, or \(k\) is hundreds.** Naive peak might be tens of QPS. A pause-triggered vendor API with no cache may be cheaper in engineering than this pipeline. Do not build a 10M-DAU system for a departmental editor because the interview question said 10M.
- **Product only needed underlines for non-words.** Phase 1 (client dictionary) is the product. Stop. The LLM was résumé-driven.
- **Legal forbids any token leaving the device, and product still requires GPT-class context.** Those two sentences cannot be true together. Local-only + tiny on-device model is the remaining option; it will not match a hosted 7B on the tail. Pick.
- **Nobody will staff a poison kill switch or an eval set.** Then do not turn on a global cache or a model. A dictionary does not need those. A model without eval is how you gaslight 10M people.

When I **would** do this: the 10M DAU (or the trajectory to it) is real, someone has already prototyped per-keystroke LLM in a demo and wants to "just ship it," or FinOps has seen a prototype bill and is asking how to cut it 100x. Then the four words are the design, and this document is the bill.

## 6. Brutal summary

The clever design is not a cheaper GPU. The clever design is **refusing to enqueue the model from `keydown`**, measuring real residual rates so the Fermi table does not become folklore, and paying for a real client speller, a boring trigger, a dangerous-but-useful cache, and a small batched model that is allowed to fail.

"100x cheaper without hurting UX" is true **if** UX is defined as: instant local typos, contextual help shortly after pause, editor never stalls. It is **false** if UX is defined as: frontier-model judgment on every key, full-document context, auto-fix as you type. Those are different products. One of them costs $50M/month. Say which one you are in before you draw the second box on the whiteboard.

The honest 100x lever is not a smarter model. It is **not calling the model**. Debounce, client triage, and cache remove >99% of the naive volume. Cost-per-call optimization is what you do to the remainder, with a handful of GPUs, not a supercomputer. Phase 0 is the histograms — keystrokes, residual rate, dictionary coverage — before anyone opens a cloud console to request quota.
