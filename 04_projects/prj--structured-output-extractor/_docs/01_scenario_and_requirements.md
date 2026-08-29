# Structured-Output Extractor: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

A teammate (or a roadmap bullet) says the design for extracting structured data from unstructured text is: prompt the model for JSON, validate against a schema, retry on invalid. The design must answer, concretely:

1. **In under two minutes**, why "retry until it parses" is a necessary backstop and a dangerous product if it is the whole contract — not as a vibe, as a statement about which failures retry can move.
2. What "invalid" decomposes into: parse failure vs. schema/shape failure vs. checkable business-rule failure vs. schema-valid-but-wrong content vs. a field the source never contained. These are **different defects**. They do not share a retry policy.
3. What you would actually do: layered validation, a **finite** repair-retry that feeds the specific error back, a temperature drop, and a terminal fallback that is an explicit failure or a human-review queue — never a silent default presented as success.

This is the retry-until-it-parses trap. The naive answer — `while not valid: call_llm()` until JSON.parse succeeds, then `INSERT` — is the failure. It treats five unrelated failure modes as one prompting problem. Sometimes the JSON even appears, because the model learned to emit braces. The downstream payroll, AP, or ticketing system then stores a plausible, typed, **wrong** object.

The correct shape is: **validate in named layers, retry only the layers retry can repair, and make every terminal outcome machine-checkable — accepted, retried-then-accepted, failed-to-human-review, or rejected — never "best effort JSON."**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true under provider-shaped structured-output APIs, schemas that cannot express the rules you care about, and a caller who would rather have *some* object than a queue.

## The 2-Minute Answer

Say this, then stop talking until they object to a specific sentence.

> Asking the model for JSON is not a contract. A contract is: parse, then schema-validate, then check the rules the schema cannot express, then either accept or fail loudly. Retry is a bounded repair of *shape*. It is not a search for truth.
>
> If the model wraps JSON in `Sure, here you go`, retry (or constrained decoding) will usually fix it. If a required key is missing or `total` is a string, a repair prompt that names the validator error will often fix it. If `line_items` sum to 100 and `total` is 10,000, that is not a schema error — JSON Schema does not do arithmetic — and retrying "make it valid" will frequently invent a total that *does* sum. You have converted a detectable lie into an undetectable one.
>
> Schema-valid JSON with a hallucinated invoice total, a fabricated employment date, or a confident-wrong ticket `order_id` is a successful parse and a failed extraction. Constrained decoding eliminates most preambles. It does not know whether the date was on the page.
>
> So we do not retry until it parses. We retry **parse and schema failures**, at most twice, with the specific validator error injected and temperature toward 0. We retry a *named subset* of semantic failures only when the check is deterministic and the feedback cannot be satisfied by invention (missing-but-required when the source has it; type/enum). We never silently coerce `"N/A"` to `0`. When the budget is exhausted, the object goes to a human-review queue with the error trail attached, or it is rejected. The caller is not allowed to receive a typed object whose status is success unless it passed every layer we claim to run.

That is two minutes. The rest of this document is what you do when they say "okay, then what."

## The Trap, Stated Directly

Standard LLM-extraction culture treats **the first parseable object** as the extraction. If the response had a markdown fence, strip it. If a field is missing, default it. If types do not match, coerce. If it still fails, call the model again with "please return valid JSON." After two or three tries someone always gets braces. Quality is inferred from "the pipeline didn't throw."

That version fails for structural reasons, not prompt-quality reasons:

| What the teammate thinks retry does | What it can actually do |
| --- | --- |
| Make extraction reliable | Repair **shape**: fences, missing keys, wrong JSON types, enum typos the model will correct when named |
| Make extraction *correct* | Nothing, for values. The model can emit a different wrong `total` that now type-checks |
| Be equivalent to constrained decoding | Constrained decoding prevents illegal tokens. Retry *samples again*. They are not the same control. Prefer the constraint; keep retry as backstop |
| Be free | Each attempt is a full generation: tokens, latency, rate-limit budget. Worst case is `(1 + retry_budget) ×` cost and p99 |
| Be bounded by "we'll stop eventually" | Unbounded `while not valid` livelocks on a document the model cannot represent, or burns the quota on a scanned PDF that is actually empty |
| Handle "N/A" / "see above" / "$—" | Only if you **model absence**. Coercing to `0` or `null` silently is a data bug with a JSON costume |
| Catch invented facts | JSON Schema cannot. A semantic layer can catch *some* (totals, date order, required-id format). Faithfulness to the source is a different problem — sibling of [hallucination detection](../../prj--llm-hallucination-detection/README.md), not a retry knob |

A pipeline that retries until `json.loads` succeeds is not a reliability system. It is an unbounded sampler with a parser in the loop, and the parser is the only critic.

## Failure-Mode Taxonomy

These five classes are the load-bearing ontology of the project. If a failure does not fit, that is a taxonomy defect (version the taxonomy) — not permission to skip naming it. Worked incidents below are illustrative; they are the same shape as production tickets.

Retry policy is **per class**, not global. That is the architecture angle the roadmap asked for.

### Class P — Parse failure

**What's actually wrong:** the model did not emit a JSON value the runtime can parse. Preamble, trailing prose, markdown fences, truncated output, single quotes, trailing commas, concatenated JSON+JSON.

**Worked incident:** a resume extractor is supposed to return one object. About 6% of calls come back as `Here is the extracted resume:\n```json\n{...}\n````. `json.loads` throws. The teammate adds `retry=5` and a strip-fences helper. Parse-fail rate drops. A week later a long resume truncates at `max_tokens`; retries reproduce the truncation; the fifth attempt is still truncated; the job marks it success because a sloppy regex captured a partial object missing `experience[-1]`.

**Does retry fix it?** Often, for fences and preamble — especially with a repair prompt or a fence-strip **before** counting an attempt. Not for truncation: retrying the same `max_tokens` is the same failure. The lever is output-token budget, a shorter schema, or splitting the document.

**Correct lever:** provider-native structured output / function-calling / JSON mode so preamble is hard to emit ([ADR-003](./04_architecture_decision_records.md#adr-003)). Cheap deterministic salvage (fence strip, trailing-comma trim) **before** a billed retry. Then bounded repair-retry. Truncation is a separate sub-case: increase output budget or fail Class P as `truncated`, do not loop.

### Class H — Schema / shape failure

**What's actually wrong:** it parsed as JSON and does not satisfy the schema: missing required key, wrong type, additionalProperties when forbidden, enum mismatch, array-instead-of-object.

**Worked incident:** invoice schema requires `currency` as `ISO-4217` enum. The model returns `"USD $"` or `"dollars"`. Retry with "must be a three-letter code" usually yields `USD`. A later schema version adds `tax_id`; old few-shot examples (and old repair messages) still show the previous shape; the model faithfully omits `tax_id` or invents one to satisfy `required`.

**Does retry fix it?** Often, when the error is local and nameable (`currency: expected enum, got "USD $"`). Unreliably, when the schema is huge, nested, or the model is being asked to invent a required field the source does not contain (that is Class U wearing an H costume).

**Correct lever:** constrained decoding to the schema as the **control**; repair-retry as backstop with the **validator's** error list injected, not "please follow the schema"; schema versioned with prompts and examples ([ADR-003](./04_architecture_decision_records.md#adr-003), [ADR-005](./04_architecture_decision_records.md#adr-005)). Do not grow `required` to bully the model into filling gaps.

### Class B — Business-rule / semantic-check failure

**What's actually wrong:** the object is schema-valid and fails a deterministic rule the schema cannot (or should not) express: `sum(line_items.amount) == subtotal`, `subtotal + tax == total`, `end_date >= start_date`, `priority` consistent with SLA tags, invoice `due_date` not before `issue_date`.

**Worked incident:** line items 40 + 60, `subtotal` 100, `tax` 10, `total` 10,000. Schema is happy (all numbers). A rule `total == subtotal + tax` fails. The teammate retries with "fix the totals." The model sets `total` to 110 **without looking at the page**. The page said 10,000 because of a scanned "1" that OCR read as noise next to a handwritten total — or because the source total really is 10,000 and the line items were incomplete. Both cases now look internally consistent. The AP system pays 110 or 10,000 with equal confidence.

**Does retry fix it?** Sometimes, when the source is clear and the model mis-copied a digit. Dangerously, when the rule can be satisfied by **mutating values** instead of re-reading the source. A repair prompt that says "make the totals consistent" is an invitation to invent.

**Correct lever:** run the rule. On failure, retry **once** with feedback that says "re-read the source; do not invent; if the source is inconsistent, set `totals_inconsistent: true` and leave values as on the page" — only if the schema has that escape hatch. Otherwise **do not retry Class B by default**; route to review. See [ADR-002](./04_architecture_decision_records.md#adr-002). Adding more JSON Schema `minimum` constraints will not save you; arithmetic across fields is not what that tool is for.

### Class C — Content / faithfulness failure

**What's actually wrong:** schema-valid, rules-pass, and the values are not what the source says — or are not in the source at all. Hallucinated employer, invented `order_id`, a plausible email that belongs to a different candidate, a "High" priority the ticket never implied.

**Worked incident:** support ticket body never mentions an order. Schema requires `order_id` (string). The model emits `ORD-00000` or a pattern it saw in few-shot. Validator passes. Retry never fires. Downstream refunds a random order or no-ops against a fake id. The pipeline's success metric is 99% schema-valid.

**Does retry fix it?** No. There is no validator error to feed back. Retrying "please be accurate" is a vibe. A second sample may differ (Class S in [flaky-output triage](../../prj--llm-flaky-output-triage/README.md)) without being truer.

**Correct lever:** do not make ungroundable fields `required`. Allow `null` + `absent_from_source`. Optional groundedness/span checks (quote a source excerpt per critical field) where the document type warrants it — invoices and order ids more than resume "summary." Human review on low-confidence or high-stakes fields. This class **routes toward** faithfulness concerns in [prj--llm-hallucination-detection](../../prj--llm-hallucination-detection/README.md); this project does not re-implement a detector. Retry is not the lever.

### Class U — Unextractable / underspecified source

**What's actually wrong:** the field is not in the text (or the text is garbage: empty OCR, wrong document type, mixed language, a resume that is a scan of a photograph). The model must either omit, null, or invent. If your schema forbids omit/null, you have forced Class C.

**Worked incident:** invoice PDF OCR returns the letterhead and "Page 1 of 2"; line items were on page 2, never ingested. The extractor fills three plausible SKUs. Schema and totals may even be internally consistent (Class B passes by construction).

**Does retry fix it?** No. The information is not in the prompt. Retrying is Class G from [flaky-output triage](../../prj--llm-flaky-output-triage/README.md) wearing an extraction hat: no example and no retry supplies a missing page.

**Correct lever:** document-type check; `source_insufficient` outcome; nulls permitted; do not retry for completeness. Fix ingestion (OCR, page assembly) upstream. This project **assumes text is already extracted** (non-goal: OCR). If the text is empty, fail closed.

### Class boundaries are fuzzy — that is a requirement, not a footnote

A missing `order_id` can be **H** (schema required it, model omitted), **U** (not in the ticket), or **C** (model invented one to satisfy `required`). Totals that don't add can be **B** (model arithmetic) or **U** (incomplete line items) or a **source that is itself inconsistent**. Truncated JSON is **P** until you raise `max_tokens` and it becomes **H** or **C**.

The architecture requires a **primary class** on every validation failure, optional **secondary tags**, and a recorded **layer** (`parse` | `schema` | `semantic` | `grounding_heuristic`). Misdiagnosis is expected; it must be visible. See [ADR-001](./04_architecture_decision_records.md#adr-001) and [System Design](./03_system_design.md).

## Document Types in Scope

Three types, three schemas, one extraction service. The types exist so the design cannot hide behind a single toy object.

| Type | Typical fields | Stakes if silently wrong | Semantic checks that are actually cheap | Faithfulness that is not cheap |
| --- | --- | --- | --- | --- |
| **Resume** | name, emails, phones, skills[], experience[{employer, title, start, end}] | Recruiter search is wrong; compliance risk if you store invented PII | date order; email regex; "Present" vs date | Whether they *worked* at the employer; implied seniority |
| **Invoice** | vendor, invoice_id, issue_date, line_items[], subtotal, tax, total, currency | You pay the wrong amount or the wrong vendor | arithmetic; currency enum; date sanity | Whether line items match the page; handwritten totals; tax-included vs plus-tax |
| **Support ticket** | customer_ref, intent enum, priority enum, order_id?, product, next_action | Wrong routing, wrong refund, GDPR if you invent an email | enum membership; order_id format if present | Intent/priority are judgments; `order_id` absent-vs-invented |

Caller **supplies** `document_type` in v1. Auto-detecting type is a later, error-multiplying feature (a resume run through the invoice schema will yield confident garbage). See [Architecture](./02_architecture_document.md).

## Current State (Assumed Starting Point)

A typical first version of "we extract JSON now" looks like:

1. A prompt: "Extract the following fields as JSON." Schema pasted as prose, or a Pydantic model dumped into the system message.
2. `response_format=json_object` or nothing. Temperature 0.3 "for a bit of robustness."
3. `json.loads` in a `try`, maybe a fence strip. On failure, the same prompt again, up to N times.
4. On success, the dict is stored. Missing keys become `None` or `""` depending on who wrote the helper. `"N/A"` becomes `0` for amounts because Postgres wanted a numeric.
5. There is no layer distinction, no outcome enum, no review queue. Failures that parse are invisible. Failures that don't parse are retried until they do or the job times out.

That version will appear to work for a prototype whose only defect is markdown fences on short, clean emails. It will fail the first time an invoice total is invented, a required field is not on the page, or a retry "fixes" arithmetic by changing the source-of-truth number. It will also fail slowly: p99 latency is N generations, cost tracks retry rate, and nobody can answer "what fraction of accepted objects were never true."

This project documents the replacement, not a prettier prompt.

## Target Users

- **Calling service / extracting engineer**: needs a hard contract — a typed object with `outcome=accepted` or an explicit failure. Needs not to write a one-off `while True` in every worker.
- **Schema owner per document type**: versions the JSON Schema (and the semantic rules that live *beside* it). Owns the fight over `required` vs `null`.
- **Review / ops**: owns the human-review queue for exhausted retries and Class B/C/U residuals. This role is not optional if the pipeline is allowed to say "reliable." If nobody will staff it, the contract must **reject** instead of queue — and the caller must handle reject. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- **Platform / serving owner**: owns structured-output support, temperature defaults, timeouts, provider fallback when function-calling is unavailable.
- **Downstream system owner** (ATS, AP, ticketing): consumes only `accepted` objects. Must not "helpfully" ingest `failed_to_human_review` payloads as if they were accepted.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (exact resume fields, which invoice OCR, which LLM) are out of scope except as the schemas and providers the contract sits on.

1. **Validation is layered, and the layers are separately named in the outcome.** Parse, schema, and semantic checks are not one boolean `valid`. A metric that only plots parse success is how Class C becomes "99% reliable." See [ADR-001](./04_architecture_decision_records.md#adr-001).
2. **Retry budget is finite and repair-shaped.** Default: **2 retries = 3 attempts total**. Blind resubmission of the same prompt does not count as a design. Each retry injects the specific validator errors, drops temperature toward 0, and does not raise the budget because "this document looks important." See [ADR-002](./04_architecture_decision_records.md#adr-002).
3. **Where the provider supports it, schema-constrained decoding / function-calling is the default shape control.** Prompt-only + regex is the fallback path, not the architecture. See [ADR-003](./04_architecture_decision_records.md#adr-003). This is the same Class F lever as [prj--llm-flaky-output-triage](../../prj--llm-flaky-output-triage/README.md); this project *is* that lever, operationalized as a service contract.
4. **Exhausted retries never become silent success.** Terminal outcomes: `accepted` | `retried_then_accepted` | `failed_to_human_review` | `rejected`. No defaulted numerics, no coerced `"N/A"` → `0`, no returning the last invalid object with `ok: true`. See [ADR-004](./04_architecture_decision_records.md#adr-004).
5. **Few-shot, if used, is format reinforcement versioned with the schema**, not a catalogue of correct invoices. Same scoping rule as triage ADR-002. See [ADR-005](./04_architecture_decision_records.md#adr-005).
6. **Absence is representable.** Critical fields that may not appear in source are `nullable` or omitted with an explicit `field_status: absent_from_source`. Making them `required` without a null path **forces Class C**.
7. **Caller supplies `document_type` and `schema_version`.** The service does not guess the type in v1. A mismatch is `rejected`, not a creative mapping onto the nearest schema.
8. **Every attempt is logged** with raw output, validator errors, layer, tokens, latency. Without this, [schema-drift forensics](../../prj--llm-schema-drift-forensics/README.md) has nothing to fingerprint next time the provider's structured-output shape moves.

## Success Criteria for the Design (Not Implementation Metrics)

1. Given a schema-invalid response, a trained teammate can name the layer (parse / schema / semantic) and whether retry is in-bounds, using the [cheatsheet](./03_system_design.md#8-worked-retry-cheatsheet), without inventing a fourth "just try again" policy.
2. A retry loop that would accept a Class B failure by mutating totals to satisfy arithmetic cannot merge as default policy — the playbook forbids "make the numbers consistent" without an `inconsistent_source` escape or a review route.
3. Constrained decoding (or JSON mode + schema validate) on a Class P/H held-out set reduces parse+schema fail rate vs. prompt-only; retry rate after that change is a published number, not a hope.
4. Outcomes are visible: accept rate, retried-then-accepted rate, human-review rate, reject rate, retry rate **by layer and document type**.
5. The 2-minute answer is consistent with the contract. If the contract says `while invalid: retry` with no layer and no budget, the design has failed its own scenario.
6. A document whose text does not contain `order_id` can complete as `accepted` with `order_id: null` (or review if policy requires), and cannot complete as `accepted` with a fabricated id unless a human signed that — the schema must allow the null path.

## Business Rules (Extraction-Scoped)

1. The first successful parse is **evidence**, not truth. `retried_then_accepted` is a different outcome from `accepted` so retry-shaped success can be audited.
2. Temperature for extraction defaults to **0** (or the provider's deterministic setting). Creativity is not a requirement of this scenario. If a later product wants "fuzzy skill synonyms," that is a different schema field with a different policy — not a reason to raise temperature on `total`.
3. Semantic rules run on the **parsed object**, never on the raw string. If parse failed, there is no Class B.
4. Human-review items include: original source text (or pointer + hash), schema version, every attempt's raw output, every validator error, the last parsed object if any. Reviewers who only see the last JSON will rubber-stamp it.
5. A change that increases retry budget, prompt tokens, or "required" fields must justify itself on **layer-specific fail rates and review rate**, not "feels more complete."
6. If the team will not staff a review queue **and** will not fail closed to `rejected`, they may still *talk* about layered validation (Phase 1). They may not claim a reliability contract. Returning invalid objects as accepted is the failure mode this rule exists to prevent.
7. PII in resumes and tickets is production data. Retention, access, and training-use restrictions inherit from the host product. Logging raw completions in an unbounded debug bucket is an incident.

## Non-Goals

- **Not an OCR / layout / table-vision pipeline.** Input is text (and optional cheap metadata: filename, page count). Multi-page invoices whose line items never made it into that text are Class U. Naming that residual is in scope; building Document AI is not.
- **Not a fine-tune or a custom extraction model.** Prompt + schema + validation + retry. If review rate stays intolerable after Phase 3, the honest conclusion may be "this document type is not an LLM-extraction candidate," not "train LoRA."
- **Not a general prompt playground.** No catalogue of personas. The prompt exists to bind the schema and the repair contract.
- **Not a second eval harness.** Golden-set scoring, paired stats, and CI gates live in [prj--support-bot-eval-harness](../../prj--support-bot-eval-harness/README.md) if they exist. This project specifies *what to measure* (layer fail rates, review rate, field-level exact match on a frozen labeled set).
- **Not a hallucination detector for free-form answers.** Class C overlap is acknowledged; production risk scoring stays in [prj--llm-hallucination-detection](../../prj--llm-hallucination-detection/README.md).
- **Not schema-drift forensics.** Provider key changes over time are [prj--llm-schema-drift-forensics](../../prj--llm-schema-drift-forensics/README.md). This project **emits** the bodies and schema versions that forensics needs; it does not bisect last week's logs.
- **Not an implementation.** No SDK, no Pydantic models, no Zod schemas, no worker YAML. Numbered steps and diagrams only.
- **Not a claim of 100% accuracy.** Residual Class C (fluent wrong values), residual Class U (missing pages), residual Class B (source itself inconsistent). The system makes those **named residuals** with a review/reject path, not a generic shrug and a parsed dict.
- **Not required for a one-off internal script you will delete on Friday.** Applying this whole machine to twenty messy notes in a notebook is the same costume as applying a webhook inbox to "user updated their avatar."
