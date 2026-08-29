# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This is the document that answers the scenario's questions without theater. The other docs exist so those answers are implementable. If you only read one file after the [Scenario](./01_scenario_and_requirements.md), read this one.

## 1. Direct answers

### 1.1 Why "just retry until it parses" is necessary but insufficient

Retry (with a repair prompt) is a legitimate **shape** control: fences, missing keys, enum typos, `"USD $"`. Constrained decoding is a better shape control when the provider has it ([ADR-003](./04_architecture_decision_records.md#adr-003)). Together they cap Class P and Class H.

They do not cap:

- **Truth** (Class C). There is no validator error to feed back. A second sample is another draw, not a retrieval of the page.
- **Checkable consistency that can be gamed** (Class B totals). "Make it valid" is satisfied by changing the number. You have optimized for the checker.
- **Missing source** (Class U). Retry cannot ingest page 2.
- **Cost**. Worst case is `(1 + budget) ×` generation. Unbounded retry is a runaway bill and a p99 disaster.

If the teammate's evidence is "after three tries we always get JSON," that is the expected Class P signature. It is not an accuracy result. Schema-valid JSON with a hallucinated total is the system working as they specified and failing as a product.

### 1.2 What you actually do

Layer the validator, retry only in-bounds classes with the error list and T=0, budget 2, terminate in an outcome enum, pin the schema, prefer native structured output, allow nulls so you do not order hallucinations, staff review or fail closed. The [contract](./03_system_design.md#2-the-validationretry-contract) is the short form. The [2-minute answer](./01_scenario_and_requirements.md#the-2-minute-answer) is the spoken form. They are the same design.

### 1.3 This rejects more documents than their loop. That is the trade-off.

Their loop: almost every document becomes a typed object; some fraction are lies; exceptions look rare. This design: accept rate drops; review or reject appears; lies that *would* have parsed still exist (Class C) but the checkable ones (P/H/B) stop looking like success. **If the actual distribution is 90% clean emails with a fence, they were faster and locally correct** — enable JSON mode, strip fences, stop. If invoices move money, the extra rejects are the product.

## 2. When a thin extractor *is* the right call

Say this out loud or the architecture becomes religion and people will ignore it until they rewrite it as a 20-line script anyway.

| Situation | Why thin is OK | Still do |
| --- | --- | --- |
| One document type, internal, you read every output | Review is you | Schema validate; no silent coerce |
| Prototype / twenty documents | Process overhead exceeds risk | Native JSON if available; delete the notebook |
| Provider has tight structured output **and** fields are all verbatim spans (invoice_id regex-able) | Class P/H already dead | Semantic rules for totals still; do not skip B because parse is green |
| Enum extraction from a short, closed form | Mapping is the task | Schema + T=0; retry 1 is plenty |
| Caller already has a human in the UX (recruiter edits every field) | Model is a draft | Return `partial_object`; do not mark `accepted` as system-of-record |

**Not** on the OK list: AP automation; required fields that often are absent; unbounded retry; `"N/A"` → `0`; calling accept rate "accuracy."

## 3. Cost comparison: retry budget vs. accuracy gained

Illustrative arithmetic — replace with your tokens, QPS, and labeled exact-match in Phase 3. The *shape* is the point. **No fabricated benchmark pretending to be a paper.**

Assume: majority of documents pass on attempt 0 once native structured output is on. Residual Class P/H is a small percent. Each retry is ~1× the generation cost of attempt 0.

| Policy | Model spend | What it moves | What it does not move |
| --- | --- | --- | --- |
| N=0, prompt-only | 1.0× | Nothing on Class P | Fences fail the job |
| N=0, native structured | ~1.0× (often shorter completions) | Most Class P, much of H | Class B/C/U |
| Budget 2, repair, in-bounds only | ~1.0× + (fail_rate × extra attempts). If 8% fail once and 2% fail twice: about **1.12×**, not 3× | Residual P/H | C; unallowlisted B |
| Unbounded / budget 8 | Approaches 3–8× on hard docs; p99 explodes | Diminishing P/H; increasing C as the model "tries to please" | U |
| k-way majority vote, T>0 | k× always | Class S (you should not have; T is 0) | C (voters can share a hallucination) |
| Second LLM as judge on 100% | +~1× always | Uncalibrated vibes | Correlated C |

**Diminishing returns after ~2 retries:** if attempt 0 failed schema, attempt 1 with a JSON pointer often fixes local enum/type issues. Attempt 2 catches a leftover required key. Attempt 5 is the model inventing keys to shut the validator up — especially if `required` is aggressive. That is why the budget is 2 and why B totals are not in the loop.

**Human cost of this design:** review hours, schema-owner time, caller handling of `rejected`. **Human cost of the status quo:** exception-free pipelines that post the wrong payment; hours of "data cleanup"; nobody knowing which rows were third-attempt fiction.

If volume is 50/week, tokens are rounding error and review process dominates — see §1.3. If volume is 50k/night and retry rate is 15%, you are paying a second pipeline. Measure `validation_retry` **before** arguing about models.

## 4. What this system cannot promise

1. **Factual correctness.** Residual Class C after every layer. Constrained decoding can make it *look* cleaner. The system **names** the residual (flags, review on strict fields, labeled exact-match). It does not delete it.
2. **Multi-page table / line-item reconstruction.** If OCR dropped page 2, this is Class U. A layout model or better ingestion is a different project. Pretending a retry will "find" the lines is the trap.
3. **Zero human review.** If you need zero humans, you need either a document type simple enough for rules/regex, or a reject rate the business will eat. "We'll review later" without a queue owner is ADR-004 theater.
4. **Calibrated per-field confidence in v1.** Asking the model "how sure" is not calibration. Phase 5 only, against human edits.
5. **Provider-agnostic identical behavior.** JSON Schema keywords, date formats, and constraint quality differ. Phase 0 measures *your* schema on *your* provider. A blog post about "structured outputs are solved" is not a test.
6. **That accept rate will stay flat when you add `required` fields.** It may go up (more invention) or down (more H). Watch field exact-match and grounding flags, not accept rate alone.
7. **That this is cheaper than a specialist IDP vendor** for invoices at scale. Those vendors exist because line items are hard. This design is the honest in-house contract for LLM extraction, not a claim you should never buy a box.

## 5. Fuzzy cases — operational rules

| Mess | What not to do | What to do |
| --- | --- | --- |
| Missing field: H vs U | Retry until it appears | Open the source. Not there → allow null / Class U. There → Class H retry |
| Totals fail: B vs U vs source-inconsistent | "Fix the math" retry | Review; `totals_inconsistent` escape if you must extract the page as-is |
| Schema valid, weird value | Call it success | Grounding flag on strict fields; else live with Class C until labeled eval |
| Truncation vs huge schema | Retry 3× | Raise output tokens once or split; then reject |
| `"N/A"` / `"see PDF"` | Coerce to 0/null silently | Type error (H) or explicit `absent` enum in schema |
| Reviewer always accepts last JSON | Celebrate queue throughput | Measure `edited_accept` vs `accepted_as_is`; sample for rubber-stamping |
| Native constraint fills garbage numbers | Turn it off in panic | Keep constraint for shape; tighten `required`; add B rules and review |

## 6. Complexity vs. payoff (be adult about this)

| Investment | Complexity | Payoff | Verdict |
| --- | --- | --- | --- |
| One frozen JSON Schema + T=0 + parse/schema validate | Low | Kills casual fence failures if paired with JSON mode | Mandatory if you extract at all |
| Native structured output | Low–medium (provider) | Best Class P/H control | Default when available |
| Repair-retry budget 2 with error injection | Low | Recovers residual shape fails | Phase 2; do |
| Semantic rule pack (totals, dates) | Low–medium | Makes Class B visible | Phase 3; do if money/dates exist |
| Human review queue with SLA | Medium (ops, not code) | Makes ADR-004 real | Mandatory for system-of-record; else reject |
| Schema registry for 3 types | Medium | Stops prompt-embedded schema drift | Phase 4; git files until then |
| Grounding heuristic on ids | Low | Cheap Class C flags, noisy | Phase 3+ on strict fields only |
| Per-field confidence / second-model judge | High | Maybe; often correlated | Phase 5, **conditional** |
| Auto document-type classifier | Medium | Caller convenience | After misroute cost is known; easy way to generate confident garbage |
| Unbounded retry / k-vote on 100% | High $ | Ego | Rejected as default |
| Full IDP / layout ML for invoices | High | Might be the actual solution | Kill criterion: if review rate stays intolerable |

## 7. Relationship to sibling projects (do not duplicate them)

- **[prj--llm-flaky-output-triage](../../prj--llm-flaky-output-triage/README.md)** owns the failure-mode playbook (few-shot is for format; schema constraint beats examples; T=0 for extraction). This project **is** the Class F control plus a retry contract. It does not relitigate R/G/S except to refuse retries that are actually those classes.
- **[prj--llm-schema-drift-forensics](../../prj--llm-schema-drift-forensics/README.md)** dates *provider* key changes from retained bodies. This project **emits** pinned `schema_version`, raw outputs, and fingerprints. It does not bisect last week.
- **[prj--llm-hallucination-detection](../../prj--llm-hallucination-detection/README.md)** scores faithfulness. Class C **routes** toward that concern. This project does not ship an ensemble detector.
- **[prj--support-bot-eval-harness](../../prj--support-bot-eval-harness/README.md)** is the place for frozen labeled sets and paired gates. This project specifies field-level exact-match and layer rates as the metrics. It does not rebuild a harness.
- If those projects are not built, this one still works at Phase 1–3 (schema, layers, budget, reject-or-inbox). Claiming "we don't hallucinate because we retry JSON" is a lie.

## 8. Kill criteria

Stop calling this a reliability contract (keep the 2-minute answer as a teaching doc if you want) if:

1. Callers wrap the API and treat any JSON as `accepted` (including `failed_to_human_review` payloads).
2. Review is unstaffed and items bulk-accept at SLA, or the queue is infinite with no reject path.
3. Retry budget grows every incident; `invoice.totals_balance` gets allowlisted "temporarily" forever.
4. Accept rate is the only KPI; nobody will label a 30-item exact-match sample.
5. `"N/A"` → `0` (or equivalent coercion) is reintroduced to "unblock" downstream.
6. Phase 5 judges are demanded before Phase 0's schema and sample exist.
7. After Phase 3 tuning, **human-review + reject rate stays above 30%** on a document type that was supposed to be automated (order of magnitude — pick your number from labor cost, but pick it). Then the type is not an LLM-extraction candidate with this architecture. Buy an IDP, add humans up front, or narrow the schema to fields the source actually contains. Continuing to add retries is how you pay LLM rates for a human process with extra steps.

Those are not moral failures. They are a decision that typed-object-at-any-cost is the actual process. Document it and stop spending architecture on a contract you will not enforce.
