# Keystroke Spell-Checker Cost Redesign: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

A text editor used by **10 million daily active users** wants an LLM-based spell-checker. The first design that appears in a design-doc comment, a product brief, or a whiteboard is: *call the model on every keystroke*. The design must answer, concretely:

1. What is the monthly GPU cost of that naive design, as a Fermi estimate with named assumptions — not a gut number.
2. How the system is redesigned so the bill falls by **~100x** without materially hurting UX.
3. What that redesign costs in complexity, coverage, and privacy.

This is the LLM-per-keystroke trap. The naive answer — buy more GPUs, distill a smaller model, switch to a cheaper SKU — is the failure. It treats a structural volume problem as a unit-cost problem. Unit cost matters. It is not the 100x lever. The 100x lever is **not issuing the call**.

The correct shape is: **instant client-side spelling for the common case; a shared cache of common typo→correction pairs; a batched LLM only after a pause, only for the residual that the first two tiers cannot resolve.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true under debounce feel, cache poisoning, on-device CPU/battery, and "the suggestion arrived after the user already moved on."

## The Trap, Stated Directly

No production editor calls a hosted LLM on every keystroke. Word, Google Docs, Chrome's spellcheck, and Grammarly's local layer do not. The ones that use models do so *after* a pause, *after* a word boundary, *after* a local dictionary miss, or *after* a user-invoked "rewrite this." The scenario as stated is a strawman that real products already rejected. That is the first honest finding, not a footnote.

The strawman is still worth costing, because the same arithmetic kills slower variants: "every 3 keystrokes," "every character in the current word," "every keystroke but a tiny model." At 10M DAU, keystroke-rate traffic is a supercomputer workload disguised as a feature. Distilling a 7B model to 1B and serving it at 5x the QPS per GPU is a 5x win. The bill is still tens of millions. You cannot unit-cost your way from "one inference per physical key event" to a product budget.

The "without materially hurting UX" clause is load-bearing. Users already have Hunspell-class underlines that appear as they type. If the redesign makes *those* wait on a network round-trip, the feature is a regression even if the LLM suggestions are smarter. Instant feedback for ordinary typos is a constraint, not a nice-to-have. The LLM is allowed to be late. The red underline is not.

## Fermi Estimate: Naive Per-Keystroke LLM

Every number below is an assumption. The point of a Fermi estimate is to be wrong in public, with the error bars visible, so a later measurement can replace the guess. Phase 0 exists to do that. Until then, this is the working cost of the naive design.

### Assumption table

| Symbol | Quantity | Working value | Why this, not a rounder number |
| --- | --- | --- | --- |
| \(N\) | Daily active users | \(10^{7}\) | Given. |
| \(k\) | Keystrokes per DAU per day | \(4{,}000\) | ~800 words × ~5 characters. A heavy writer is 10k+; a casual DAU is a few hundred. 4,000 is a mid-weight editor user, not a novelist and not a person who opened the app and typed a title. If real \(k\) is 800, the whole estimate drops 5x. If it is 12,000, it rises 3x. |
| \(D\) | Days per month | \(30\) | Calendar. |
| \(p\) | Peak-hour share of daily keystrokes | \(0.15\) | Consumer-app diurnal: the busiest hour is typically 10–20% of the day, not \(1/24 \approx 4\%\). Global timezone spread pulls this down; a US-heavy user base pushes it up. 15% is the middle. |
| \(L\) | Tokens in + out per keystroke call | ~150 in, ~20 out | A few dozen tokens of left context, the current word, a short instruction, a short completion. This is already a *small* prompt. A "whole document" prompt is 10–50x worse and is excluded from the naive estimate on purpose — if you send the document, the bill is not this document's problem, it is a different disaster. |
| \(q\) | Achievable QPS per GPU at interactive latency | \(50\) | Interactive = p95 well under 100 ms, **no meaningful batching**. A 7B-class model on a modern inference GPU (A100 / L40S / H100 class) can do hundreds of QPS *if you batch and wait*. Keystroke UX forbids that wait. 50 is pessimistic-to-mid for a small model with tiny sequences; 200 is optimistic. Sensitivity is called out below. |
| \(c\) | Fully loaded GPU-hour | \(\$2\) | Order-of-magnitude cloud inference GPU, not a reserved H100 cluster and not a hobby GPU. On-demand A100/L40S often sits $1.5–$4. Spot is cheaper and you will not run a typing SLO on spot. |

### Volume

\[
N \times k = 10^{7} \times 4{,}000 = 4 \times 10^{10} \text{ keystrokes/day}
\]

Forty billion model calls per day. Monthly: \(1.2 \times 10^{12}\) calls.

Average QPS, 24h flat:

\[
\frac{4 \times 10^{10}}{86{,}400} \approx 4.6 \times 10^{5} \text{ QPS}
\]

Peak QPS (15% of the day in one hour):

\[
\frac{4 \times 10^{10} \times 0.15}{3{,}600} \approx 1.7 \times 10^{6} \text{ QPS}
\]

One point seven million inferences per second, each of which must return fast enough that the underline does not feel like a network feature.

### GPU fleet

You provision for **peak**, not average. A typing SLO that sheds load at 14:00 in the user's timezone is a broken spell-checker. Global timezone spread helps, but it does not turn 1.7M into 0.46M unless the user base is perfectly anti-correlated, which a 10M-DAU editor is not.

\[
\frac{1.7 \times 10^{6}}{50} \approx 3.4 \times 10^{4} \text{ GPUs}
\]

Thirty-four thousand GPUs, held up, because you cannot autoscale a 50 ms path through a cold start.

### Monthly dollars

\[
3.4 \times 10^{4} \times \$2/\text{h} \times 730 \text{ h} \approx \$50 \times 10^{6}
\]

**Working Fermi number: ~$30–50 million per month** at the assumptions above. Treat "$50M" as the headline; treat "thirty to fifty" as the honest range inside this assumption set.

If you (incorrectly) provisioned for *average* QPS: \(4.6 \times 10^{5} / 50 \approx 9{,}200\) GPUs → ~$13M/month. That number is a lower bound that violates the latency SLO at peak. Do not use it as the design cost. It is included so that "just autoscale" cannot hide: even the average-load fantasy is a nine-thousand-GPU product.

### API-metered alternative (why "just call the vendor" is worse)

Self-hosted GPU is the *optimistic* naive path. Token-metered APIs at 2026-class cheap-model prices:

| | Working value |
| --- | --- |
| Calls / day | \(4 \times 10^{10}\) |
| Input tokens / day | \(4 \times 10^{10} \times 150 = 6 \times 10^{12}\) |
| Output tokens / day | \(4 \times 10^{10} \times 20 = 8 \times 10^{11}\) |
| Cheap-model input | ~$0.10 / million tokens |
| Cheap-model output | ~$0.40 / million tokens |
| Input $ / day | \(6 \times 10^{12} \div 10^{6} = 6 \times 10^{6}\) million-token units × $0.10 = **$600k/day** |
| Output $ / day | \(8 \times 10^{11} \div 10^{6} = 8 \times 10^{5}\) million-token units × $0.40 = **$320k/day** |
| Token $ / month | $920k/day × 30 ≈ **$28M/month** |

Cheap-model *token* dollars land in the same order of magnitude as self-hosted GPUs. That is not a rescue. It is a coincidence of list prices, and it ignores the parts that actually kill the idea:

- **Rate limits.** 1.7M QPS is not a tier a vendor sells. You will be 429'd into a product outage long before the invoice arrives.
- **Per-request floors and HTTP overhead.** 40 billion HTTP calls/day is its own bill and its own connection table, even if tokens were free.
- **Frontier models.** Swap the $0.10/MTok SKU for a $2–$5/MTok SKU and the token bill becomes **$0.5–$1B+/month**. The cheap SKU is already the optimistic API path.

**Do not "just use the API" to avoid GPUs.** At this QPS you are not a customer; you are a denial-of-service. The rest of this project assumes self-hosted inference for the naive *and* the redesigned paths. After the 100x cut, a *residual* vendor API for the LLM tier becomes thinkable; before the cut, it is not.

### Sensitivity (the ±5–10x)

| If this assumption is wrong | Direction | Rough factor |
| --- | --- | --- |
| \(k = 800\) (casual DAU) | cheaper | ~5x |
| \(k = 12{,}000\) (writer-heavy) | dearer | ~3x |
| \(q = 200\) QPS/GPU (tiny model, still no batch) | cheaper | ~4x |
| \(q = 20\) QPS/GPU (larger model, or worse serving) | dearer | ~2.5x |
| \(p = 0.08\) (strong global spread) | cheaper | ~2x |
| \(p = 0.25\) (single-geo workday spike) | dearer | ~1.7x |
| \(c = \$1\) (aggressive reserved / smaller SKU) | cheaper | ~2x |
| \(c = \$4\) (H100 on-demand, no discount) | dearer | ~2x |
| Prompt is the whole document, not 150 tokens | dearer | 10–50x, and QPS/GPU collapses with it |

Inside the assumption set the estimate is a factor of a few. Across a plausible product it is a factor of ~5–10. It is **not** a factor of 100. A 5x miss still leaves you in the tens of millions. That is why this is an architecture problem, not a "we used the wrong GPU price" problem.

**What would have to be true for the naive design to be cheap.** \(k\) in the low hundreds *and* a model that does thousands of QPS at <50 ms *and* a user base with no peak. That is not a 10M-DAU editor. It is a demo.

## Where the 100x Has to Come From

Unit-cost knobs available *without* changing *when* you call the model:

| Knob | Realistic gain | Leaves you at |
| --- | --- | --- |
| Smaller model (7B → 1B) | 3–5x QPS | still ~$10M/month |
| Better serving (continuous batching, prefix cache) | 2–4x, *if you can wait to batch* | keystroke UX gives you nothing to wait for |
| Reserved capacity / cheaper SKU | ~2x | still tens of millions |
| Quantization | ~2x | same |

Stack them generously: 5 × 2 × 2 = 20x. You needed 100x. You are still at a few million a month *and* you spent the serving team's year. The remaining factor has to come from **fewer calls**, not cheaper calls.

Call-reduction levers that do not require a worse model:

| Lever | What it removes | Working factor | UX cost if done honestly |
| --- | --- | --- | --- |
| **Debounce / word-boundary** | Mid-word keystrokes. "t", "te", "teh" are one event, not three. | ~5–6x (\(k\) keystrokes → ~\(k/5\) words, plus idle coalescing) | Underline for the *current* word waits until pause or space. Users already experience this with every desktop spell-checker. |
| **Client triage** | Words the local dictionary already knows are correct, and non-word typos a local edit-distance model can fix. | ~15–20x on remaining events (most tokens are correctly spelled; most errors are `teh`/`recieve`, not "their/there") | None for the common case, if the client tier is as fast as today's Hunspell. |
| **Shared cache** | Repeated (typo, coarse context) → correction pairs. Typing errors are Zipf. | ~3x on the residual (50–70% hit is plausible; 90% is a hope, not a plan) | A wrong cached correction is a fleet-wide bug. See [ADR-003](./04_architecture_decision_records.md#adr-003). |

Compounded, not added: \(6 \times 16 \times 3 \approx 290\)x fewer model calls. That overshoots 100x on volume alone. Batching on the residual (now you *have* 100–300 ms to wait, because the user paused) is another ~5–10x on **QPS per GPU**, which is extra margin, not the thing you need to hit 100x.

A conservative compounding that still clears the bar: debounce 5x, client 10x, cache 2x → **100x** exactly, with no credit for batching. The architecture is designed so that if cache disappoints, client+debounce still hold a large fraction of the win. See [Architecture Document — Cost Analysis](./02_architecture_document.md#cost-analysis).

## Target Users

- **Owning engineer**: needs a cost model they can defend in a review, and a pipeline they can ship without standing up a 30,000-GPU fleet.
- **Product**: needs to know that "LLM spell-check" will not underline mid-grapheme, and that advanced (contextual) suggestions arrive after a pause, not on the key.
- **Infra / FinOps**: needs a GPU number that fits in an existing inference budget, and kill criteria if the call rate regresses toward the naive bound.
- **Privacy / legal**: needs to know what context leaves the device, because a cache of "word + neighbors" is a new data collection.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (underline color, dictionary language packs as SKUs) are out of scope.

1. **Basic typo feedback must remain locally instant.** Non-word errors (`teh`, `seperate`) must underline on a budget comparable to a current desktop spell-checker: on-device, no network, works offline. If this waits on the LLM, the redesign has failed the UX clause.
2. **Model calls must not be keyed off `keydown`.** The trigger is a completed word, punctuation, or an idle pause. Per-keystroke invocation is a bug, not a fallback. See [ADR-002](./04_architecture_decision_records.md#adr-002).
3. **Monthly GPU (or equivalent inference) cost must be ≤ 1% of the naive Fermi (~100x).** Working target: **≤ ~$500k/month** against a ~$50M naive headline, with a stretch of the low-five-figures if cache and client coverage land. The 100x is the *requirement*. Anything beyond it is margin, not a promise to finance.
4. **Correctness of ordinary spelling must not regress vs. a Hunspell-class baseline.** The LLM tier may add contextual / real-word error coverage. It must not *remove* `teh` → `the`. Client tier owns that bar.
5. **The editor must remain usable when the network, cache, or inference tier is down.** Typing never blocks. Suggestions degrade to client-only. See [ADR-005](./04_architecture_decision_records.md#adr-005).
6. **Context that leaves the device is minimized and not stored as a document.** Cache keys may use a normalized, truncated neighborhood around a word. Raw document bodies, user identifiers, and keystroke logs are not part of the inference or cache path. See [System Design](./03_system_design.md).
7. **A cached correction is a capability with a blast radius.** Poisoning, staleness, and "the model was having a bad day on Tuesday" must be containable (TTL, version, invalidation, allow-list of high-frequency entries). A global cache is how you get 3x; it is also how you misspell a word for 10M people.

## Success Criteria for the Design (Not Implementation Metrics)

1. Fermi naive cost is documented with an assumption table a skeptic can attack. Replacing an assumption in Phase 0 does not require a new architecture, only a new number.
2. A correctly spelled common word produces **zero** network traffic.
3. A common non-word typo (`teh`) is underlined from the client dictionary without a model call.
4. A residual contextual case (real-word error, or a misspelling the local model will not touch) may wait 100–300 ms after pause; it may not wait on a cold GPU autoscale of minutes.
5. Peak model QPS after all levers is two to three orders of magnitude below 1.7M, and the GPU fleet is tens of cards, not tens of thousands.
6. Cache miss + inference outage still leaves the user with client-tier spelling. The editor does not freeze, blank, or show a "spell-check unavailable" modal on every key.

## Business Rules (Spellcheck-Scoped)

1. The client is the only tier allowed to run on the keystroke path.
2. The cache and the LLM see **words (and a small normalized window)**, not keystrokes, and not the full buffer.
3. LLM suggestions are advisory. They do not auto-replace unless the product already auto-replaces today (it usually should not). Auto-replace of a cached LLM guess is how poisoning becomes data loss.
4. High-frequency cache entries that survive a confidence and popularity bar may be compiled *into* the client dictionary on a release cadence, so yesterday's residual becomes tomorrow's local hit. That is an optimization, not v1.
5. Languages other than the v1 pack are a new dictionary + a new model head or a new prompt, not a reason to send every keystroke "because multilingual is hard."

## Non-Goals

- **Not a general grammar, tone, or rewrite product.** "Make this paragraph more executive" is a different QPS, a different prompt, a different UX (explicit invoke). Do not smuggle it in to make the LLM look useful enough to justify the fleet. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- **Not full-document contextual reasoning on every pause.** A 10k-token document sent on every space bar re-creates the naive bill through the prompt side. The window is small. Long-range "this pronoun doesn't agree with the noun in paragraph 1" is a non-goal for v1.
- **Not multilingual parity in v1.** One language pack with a real dictionary. Additional languages are extra dictionaries and extra evaluation, not a reason to skip client triage.
- **Not an implementation.** No PyTorch serving config, no WASM build, no Terraform. Numbered steps and diagrams only.
- **Not a claim that 100x is "free quality."** You give up mid-keystroke LLM opinions, long-tail contextual coverage, and some freshness. If product wants GPT-class judgment on every token as it appears, they are asking for the $50M system. Make them say so. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- **Not a claim that this is worth building at 50k DAU.** The naive design is a monster *at 10M DAU*. At 50k DAU the same Fermi is ~$150k–250k/month at peak (linear), still ugly, but the 100x architecture may be more expensive in engineering than just calling a cheap API on pause with no cache. Scale is the reason this project exists.
