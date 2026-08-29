# LLM Schema Drift Forensics: Business Overview
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Product Vision
A way to answer, from **only the request/response data already on disk**, two questions that a silent LLM-API schema change leaves behind: **what keys changed**, and **when**. And a permanent contract monitor so the next change is a same-day alert instead of another week-later mystery.

This is not an observability platform. It is not a vendor-changelog scraper. It is **forensic analysis under incomplete information**, followed by the smallest monitor that makes the forensics unnecessary next time. The first half cannot create evidence that was never captured. The second half exists because pretending the first half will work again is how the same incident happens twice.

## Business Context
- **The incident**: about a week ago, an LLM API you call started returning slightly different JSON keys. Downstream parsers that keyed on the old names began failing, filling, or silently dropping fields. Nobody has a log line that says "the vendor changed the schema." The vendor may not even agree a change occurred.
- **The constraint that makes this hard**: you have **current** traffic and **whatever history already exists**. You do not have a time machine, a vendor deploy log, or a right to demand last week's raw bodies from a provider who does not retain them for you. Adding better logging *now* answers next month's incident. It does not answer this one.
- **The consumer of the answer**: an engineer who has to patch parsers, a product owner who has to decide whether last week's outputs are trustworthy, and (sometimes) a vendor TAM who will only investigate if you can show a before/after with timestamps. "It feels like it broke recently" is not a ticket they will pick up.
- **Organizational reality**: the serving path was built to *call the model and parse the JSON*, not to *preserve the contract*. Structured-output keys were treated as stable because they looked like an API. They are not. Model aliases named `"latest"`, `"gpt-4o"`, or `"claude-3-5-sonnet"` are **moving pointers**. A JSON schema you described in a prompt is a suggestion the model approximately follows, not a wire contract.

## The question this is actually answering

The prompt is not "how do we prevent schema drift." Prevention is the second half, and it is the easy half. The prompt is:

> Using only current + historical request/response data you already have, what changed, and when?

That sentence has a load-bearing clause — **already have** — that every optimistic design tries to delete. Three common non-answers, and why they fail the question as asked:

| Non-answer | Why it feels useful | Why it does not answer the question |
| --- | --- | --- |
| **Ask the vendor** | They caused it | They may deny it, not know which canary hit your account, or refuse to date a "minor" key rename. Even a yes does not reconstruct *your* blast radius from *your* data. The scenario forbids treating their changelog as an input you have. |
| **Add request/response logging now** | Correct, for next time | Does not recover last week. Retroactive instrumentation is a category error. |
| **Diff this week's payloads against last week's** | Sounds like the job | Values change on every call. A raw payload diff is a diff of *answers*, not of *shape*. You will "find" that every response changed. That is the model working as designed. |

The actual job is to extract a **schema** from each historical response (keys, paths, types — not values), place those schemas on a timeline, and read the timeline. How sharp the reading can be is a function of the evidence inventory, not of the cleverness of the algorithm.

## The evidence ladder (the actual requirement)

Precision is not a design choice. It is a property of what was retained. This table is the architecture. Everything else is how you climb it as high as the existing data allows, and stop when it ends.

| Rung | What you have | What you can honestly claim | What you cannot claim |
| --- | --- | --- | --- |
| **0 — nothing** | No bodies, no parse errors, no metrics, no tickets | "We cannot date this change from our data." | A day, a key list, a confidence. Inventing any of those is the failure mode. |
| **1 — human reports** | Slack/tickets: "summaries look empty since ~last Tuesday" | A **coarse window** bounded by last-known-good anecdote and first complaint | Which keys, exact day, whether it was sudden or rolling |
| **2 — aggregate metrics** | parse-failure rate, null-rate on extracted fields, 4xx/5xx from *your* parser | A **window** around the metric inflection; possibly which *extracted field* went null | The replacement key name, whether it was a rename or a removal, sub-day timing |
| **3 — exception logs** | `KeyError: 'foo'`, JSON-schema validator failures, with timestamps | That `foo` disappeared (or changed type) **no later than** the first exception; a window from last success to first failure if successes were also logged | What replaced `foo`; whether `foo` was optional noise; the vendor's rollout shape |
| **4 — extracted fields in a DB** | You stored `response.foo` and `response.bar` as columns | Presence/null of *those* columns over time. A column that goes from 95% populated to 0% is a strong removal signal | Keys you never extracted. A new key `foo_v2` that you never stored is **invisible** in this rung. This is the most dangerous false confidence: the warehouse looks complete and is a projection of the old schema. |
| **5 — sampled bodies** | 1% of raw JSON retained, or only "interesting" traces | A **distribution** of fingerprints over time, with sampling error. A change that lasted four hours on a 1%/day sample may leave zero hits | Completeness. Bisection is usually not licensed; the sample is not a total order of all calls |
| **6 — near-full bodies + request metadata** | Request and response JSON, timestamp, model id, endpoint, region, headers (`system_fingerprint`, `x-request-id`, model version) | **What** changed (structural diff of fingerprints) and **when** to the resolution of the log clock — *if* the timeseries is a clean step. Correlation against model alias / fingerprint / region | The vendor's intent, whether other customers saw it, whether it was a bug or a launch. You still cannot see traffic that never hit you (other regions, other aliases) |
| **7 — golden probes, historically** | Fixed prompts sent on a schedule, bodies retained | The cleanest step-function you can get: same prompt, same params, schema-over-time. This is what the contract monitor creates **going forward**. If you did not have probes last week, you do not have this rung for *this* incident | — |

Most teams that "call an LLM API" live on rungs 2–4. They will want the answer from rung 6. The design's first honest act is to **inventory the rung before promising a date**.

## Why schema, not payload

LLM responses are supposed to differ. The useful invariant is the **shape**:

- key names at each path (`choices[0].message.content`, `output.citations[].url`, `usage.prompt_tokens`)
- JSON types at those paths (`string`, `number`, `array`, `object`, `null`, `boolean`)
- required vs optional presence (a key appearing in 40% of calls is not the same event as a key dropping from 98% to 0%)

A **schema fingerprint** is a canonical hash of that shape. Plot fingerprint (or fingerprint family) against time. A silent key change is a **change in the fingerprint distribution**, not a change in any one payload's text.

Two complications the business owner needs to hear before engineering looks clever:

1. **Optional keys are not a schema change.** Structured output from an LLM is sloppy even when the vendor did nothing. A field the prompt "requires" will be missing some percentage of the time. Fingerprinting the *full* key set of each body will look like constant drift. The signal is a **sustained shift in key-presence rates** (or in types), not a single missing key.
2. **A rename is not distinguishable from remove+add by structure alone.** If `summary` vanishes and `brief` appears in the same window, that is the working hypothesis of a rename. It is not a proof. The forensic report must say "consistent with rename" and show the complementary timeseries, not "they renamed summary to brief."

## Why bisection is a candidate, not the method

If you have an ordered replay log of bodies (rung 6) and the fingerprint timeseries looks like a **step** — all samples before T are fingerprint A, all after T are fingerprint B, no overlap — then the boundary can be found by **binary search** over the ordered log in O(log n) fingerprint comparisons. That is the interview-shaped answer, and it is correct **under that precondition**.

Vendor rollouts often violate the precondition:

- canary: 5% new schema mixed into old for days
- regional: us-east flipped Tuesday, eu-west Thursday
- alias: `"gpt-4o"` moved, the pinned snapshot id did not
- A/B or account-level flags
- prompt-dependent: the new key appears only on some task types

If both fingerprints coexist in the same time window, **bisection's monotonicity assumption is false**. Running it anyway returns a "T" that is an artifact of the search, not of the world. The fallback is a **full time-bucketed histogram** of fingerprints (and of per-key presence rates), sliced by the metadata you have (model, region, endpoint). That is slower, less interview-pretty, and the only honest algorithm for a noisy rollout.

See [System Design §3](./03_system_design.md#3-timeline-reconstruction-bisection-and-its-kill-switch) and [ADR-002](./04_architecture_decision_records.md#adr-002).

## Two products, not one

| Product | When it runs | Question it answers | What success looks like |
| --- | --- | --- | --- |
| **Forensic Analysis Toolkit** | Once, now, against the evidence you already have | What changed, and when, *as tightly as this evidence allows* | A report: structural diff + a timestamp **or a window** + the rung you were on + the caveats. Shipping a fake exact time from rung 2 is a failed investigation. |
| **Schema Contract Monitor** | Forever, after the incident | Has the schema moved *today*? | An alert within one probe interval of a fingerprint or required-key change, plus enough retained samples that the next forensic exercise is a dashboard lookup, not a scavenger hunt. |

The forensic toolkit does not prevent the next incident. The monitor does not date the last one. A design that only builds the monitor has refused the question. A design that only builds the toolkit has guaranteed a sequel.

## Core Value Propositions
1. **A dated, scoped diff — or an explicit inability to date.** The deliverable is not "we investigated." It is either a structural diff plus a bound, or a written statement that the bound is "sometime before we noticed," which is still an answer.
2. **Stop treating prompt-specified JSON as a wire contract.** The monitor makes the contract *yours*: required keys validated at ingest, golden probes, pinned model versions where the vendor offers them.
3. **Retain fingerprints even when you cannot retain bodies.** Raw bodies are PII, cost, and a retention-policy fight. A schema fingerprint plus a timestamp plus model metadata is small, less sensitive, and is the actual forensic primitive. See [ADR-004](./04_architecture_decision_records.md#adr-004).
4. **Patch the parser independently of dating the change.** Downstream breakage is a production incident. Dating it is a postmortem. Phase 0 of the plan does the patch first. An exact Tuesday 14:03 does not unbreak Friday's users.

## Success Metrics
These are ceilings, not aspirations. Hitting a tighter number than the evidence rung allows is a bug.

1. **Bound quality**: the reported window is no wider than the evidence ladder permits, and no narrower. A rung-6 step function dated to the minute is success. A rung-2 metric inflection dated to the minute is failure (overclaim). A rung-6 step function reported as "sometime last week" is also failure (underclaim — you had better data than you used).
2. **Diff completeness on retained keys**: every required-key add/remove/type-change visible in the bodies you *do* have appears in the report. Missing a key that was never stored (rung 4) is not a miss; claiming you checked "the schema" when you only checked stored columns *is* a miss.
3. **Monotonicity honesty**: every use of bisection is preceded by a recorded pass of the overlap check. A T produced without that check is a defect.
4. **Time-to-detect, next incident** (monitor SLO, not forensic SLO): required-key breakage pages within one probe interval (illustrative: 15–60 minutes) plus whatever ingest-validation is on the hot path (that one is immediate).
5. **Phase 0 decoupling**: parser patch shipped without waiting for the forensic report. If dating the change blocked the patch, the process failed even if the date is perfect.

## Business Rules
1. **Do not invent evidence.** If bodies for 2026-08-20 were never stored, they do not exist in the analysis. Interpolating a fingerprint across a retention gap is how you publish a confident wrong day.
2. **The forensic report states its rung.** A number without a rung is not a finding.
3. **Bisection is forbidden until monotonicity is shown.** Histogram is the default; bisection is an optimization for the clean case. [ADR-002](./04_architecture_decision_records.md#adr-002).
4. **Parser patching does not wait for forensics.** [Phased Implementation Plan — Phase 0](./06_phased_implementation_plan.md#phase-0--stop-the-bleeding-hours-not-a-phase-you-skip).
5. **Golden probes are production traffic.** They cost tokens, they hit rate limits, they can leak probe content into logs. They are not "free monitoring." Budget them. [ADR-006](./04_architecture_decision_records.md#adr-006).
6. **Asks to the vendor are made, once, with the forensic report attached.** A no or a silence does not widen our bound. Their answer is corroboration, not a substitute for our data.

## Pipeline Consumers
This is internal investigative/platform infrastructure, not a product:

1. **Incident engineer**: needs the parser patch (Phase 0) and the structural diff (which keys to accept).
2. **Postmortem owner**: needs the bound, the rung, and the caveats — not a detective story.
3. **Serving/platform owner**: owns the contract monitor, model pinning, and retention policy going forward.
4. **Vendor TAM** (optional, uncooperative): receives the report; is not in the runtime path and not a dependency of the bound.
