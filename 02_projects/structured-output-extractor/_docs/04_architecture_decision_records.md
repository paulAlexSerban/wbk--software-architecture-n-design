# Architecture Decision Records

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Layered Validation (Parse / Schema / Semantic) Is Not One Boolean `valid`

**Status**: Accepted

**Context**: The default extractor treats "JSON parsed" or "JSON Schema passed" as done. Those are different events. Parse success with schema failure is Class H. Schema success with `total != subtotal + tax` is Class B. Schema success with an invented `order_id` is Class C and will **not** appear in either of the first two layers. A single `valid` flag — or a dashboard whose only plot is parse success — is how Class C becomes "99% reliable." JSON Schema is also the wrong tool for cross-field arithmetic; stuffing that into `pattern` or `oneOf` produces unmaintainable contracts and a false sense of semantic coverage.

**Decision**: Every attempt records **three layer statuses** (`parse_status`, `schema_status`, `semantic_status`) plus optional grounding flags. `primary_class` is assigned from the first failing layer (P → H → B). Metrics, alerts, and retry policy key off **layer and `rule_id`**, not a boolean. Semantic rules live in a versioned rule pack **beside** the JSON Schema, not inside it. See [Scenario — ASR 1](./01_scenario_and_requirements.md#architecturally-significant-requirements) and [System Design §2](./03_system_design.md#2-the-validationretry-contract).

**Consequences**:
- (+) Retry policy can be class-specific. Shape failures retry; totals do not by default.
- (+) A spike in schema-fail vs semantic-fail vs grounding-flag tells you whether to fix the prompt/constraint, the rules, or the schema's `required` list.
- (–) More instrumentation than `try json.loads`. Teams will want to collapse the dashboard; the headline must remain multi-layer or this ADR is theater.
- (–) Semantic rules are code that must be tested. That is real engineering, not a schema annotation.
- **Alternative rejected**: "schema only." Leaves Class B/C invisible.
- **Alternative rejected**: "one LLM-as-judge instead of layers." Correlated errors, cost on 100% of traffic, uncalibrated. Same objection as [flaky-output triage ADR-005](../../prj--llm-flaky-output-triage/_docs/04_architecture_decision_records.md#adr-005).
- **Revisit trigger**: a document type whose semantic rules cannot be made deterministic (pure judgment fields). Then those fields are not Class B; they are Class C / human. Do not invent fake arithmetic for them.

## ADR-002: Retry Budget Is Finite and Repair-Shaped; Blind Resubmit Is Not a Policy

**Status**: Accepted

**Context**: "Retry on invalid" is the roadmap's architecture angle and the teammate's entire design. Unbounded `while not valid` livelocks on Class U, multiplies p99, and — when the repair is "make it valid" — teaches the model to **satisfy the checker** rather than re-read the source (the totals incident). Blind resubmission (same prompt, hope the next sample parses) is Class S sampling with a parser in the loop; it sometimes works for Class P and teaches nothing.

**Decision**: Default `validation_retry_budget = 2` (three attempts with bodies). Each validation retry **must** inject the structured error list, keep temperature at 0, and stay in-bounds per [System Design §2.2](./03_system_design.md#22-retry-triggers-in-bounds). Class B retries are **deny-by-default**; allowlist only rules that cannot be gamed by invention, or that have an `inconsistent_source`-style escape. Truncation does not consume retries in a loop at the same `max_tokens`. Transport retries are a **separate** counter. Raising the budget because "this invoice is important" is forbidden; importance goes to review priority, not extra samples.

**Consequences**:
- (+) p99 and cost are bounded and publishable. Exhaustion is a first-class outcome.
- (+) Repair context actually moves Class P/H more often than luck sampling.
- (+) Totals cannot be laundered into internal consistency by default.
- (–) Some Class H documents that would have parsed on attempt 7 will go to review. That is accepted. Attempt 7 is also where invention thrives.
- (–) Allowlist maintenance is a schema-owner job. If everything gets allowlisted, this ADR is dead.
- **Alternative rejected**: unbounded retry until timeout. Outage-as-a-service.
- **Alternative rejected**: N=0 (no retry) as the universal policy. Leaves cheap Class P/H on the table; constrained decoding should reduce this, but fallback providers still need one or two repairs.
- **Alternative rejected**: majority vote of k samples on every document. k× cost; this is a Class S mitigation from [flaky-output triage](../../prj--llm-flaky-output-triage/README.md), not an extraction default. Temperature is already 0.
- **Revisit trigger**: measured data that attempt 3 (budget 2) still recovers a large *exact-match-to-source* gain on a held-out set **without** increasing Class C on semantic rules. Then budget may move to 3. Do not raise it from a parse-fail dashboard alone.

## ADR-003: Provider-Native Structured Output Preferred Over Prompt-Plus-Regex

**Status**: Accepted

**Context**: Class P (preamble, fences) is the failure "please return JSON" was invented for. Most providers now expose JSON mode, function/tool calling, or JSON-Schema-constrained decoding. Those enforce shape at decode time. Prompting plus regex salvage plus retry *suggests* shape and bills for failures. Few-shot examples of valid JSON are a legitimate reinforcement and a permanent token tax; they rot when the schema moves (see [flaky-output triage ADR-002/003](../../prj--llm-flaky-output-triage/_docs/04_architecture_decision_records.md#adr-003)). Native constraint is not universal: some schema keywords are unsupported; some models still emit illegal JSON; some "JSON modes" only guarantee an object, not *your* schema.

**Decision**: When the serving provider can constrain output to the registry schema, that is the **default** extraction path (`constraint_mode = native_structured`). Retry remains the backstop, not the control. When the provider cannot, the path is `json_object` or unconstrained + salvage + schema validate + repair-retry, then a *small* versioned few-shot if Class P/H remain expensive. Mode downgrade on provider 400 (unsupported keyword) is allowed **once** per request. Do not invent a local constrained decoder in v1 unless serving already planned it. See [Architecture — Extraction Client](./02_architecture_document.md#3-extraction-client).

**Consequences**:
- (+) Lower Class P rate; often lower completion tokens (no preamble).
- (+) Schema version in the API call is a real artifact, which [schema-drift forensics](../../prj--llm-schema-drift-forensics/README.md) can fingerprint later.
- (–) Constrained decoding can increase fluent wrong *values* in required fields (the model must emit a number, so it does). Watch Class B/C and field exact-match when enabling it — not only parse-fail.
- (–) Teams on a provider without this feature will see this ADR as unusable. The fallback is written. Do not block Phase 1 on a vendor capability.
- **Alternative rejected**: "few-shot first, structured output later." Examples will still be there later. Default to the control that does not rot.
- **Alternative rejected**: regex-only extraction for invoices. Brittle on real documents; this scenario is LLM extraction. Hybrid (regex for `invoice_id` if a line matches, LLM for the rest) is a **future** optimization, not v1 architecture, and must still run the semantic layer.
- **Revisit trigger**: native constraint measurably worse on field exact-match (not just slower) than unconstrained+retry on a labeled set. Then JSON mode + schema validate becomes default and this preference is documented as blocked for that provider.

## ADR-004: Exhausted Retry Never Becomes Silent Success

**Status**: Accepted

**Context**: Downstream systems (ATS, AP, ticketing) will ingest whatever you hand them if the type matches. Returning the last invalid object, a coerced `"N/A"` → `0`, or a defaulted `order_id` with `ok: true` is how the pipeline's exception rate goes to zero and the finance incident appears next quarter. A "warning header" that nobody checks is the same bug. Human review is the honest residual path; an empty review queue with bulk-accept at SLA is the dishonest one.

**Decision**: Terminal outcomes are exactly `accepted` | `retried_then_accepted` | `failed_to_human_review` | `rejected`. `accepted_object` is populated only on the first two. Coercion to satisfy the schema in application code is forbidden; type repair is the model's job on a retry or a reviewer's job. If review is not staffed, the deployment mode is **reject**, not "queue into the void" and not "accept anyway." Review SLA breach expires to `rejected` or pages ops — never `bulk_accept`. A `partial_object` for UX is allowed only as a separately named field. See [System Design §2.5](./03_system_design.md#25-terminal-fallback) and [Scenario — ASR 4](./01_scenario_and_requirements.md#architecturally-significant-requirements).

**Consequences**:
- (+) Downstream can fail closed. Systems of record do not see exhausted attempts.
- (+) `retried_then_accepted` remains auditable (retry-shaped success).
- (–) Callers must handle non-accept. If they refuse, they will wrap this service in a client that treats any JSON as success — that wrapper is a policy violation, not a flexibility feature.
- (–) Review labor is real. Organizations that will not pay it must accept higher `rejected` rates. Document that; do not hide it in coerced defaults.
- **Alternative rejected**: "return best-effort plus confidence." Uncalibrated confidence becomes a threshold someone sets to 0 so everything flows.
- **Alternative rejected**: auto-accept `retried_then_accepted` only if schema-valid after retry — that is already the accept path; the forbidden part is auto-accepting **invalid** or **rule-failed** objects.
- **Revisit trigger**: none for "must not silently succeed." Review vs reject is a staffing choice, not a waiver of the enum.

## ADR-005: Few-Shot Examples Are Format Reinforcement Versioned With the Schema

**Status**: Accepted

**Context**: Few-shot is the default patch for "the JSON was messy." It is a real tool for Class P/H *shape*. It is a bad tool for Class C (examples of correct invoices do not put missing line items on the page) and a dangerous tool for Class B (examples of balanced totals teach the model to emit arithmetic-looking numbers). Unversioned examples rot when `required` fields change — the stale-enum incident in [flaky-output triage](../../prj--llm-flaky-output-triage/_docs/01_scenario_and_requirements.md). This project will not re-litigate that taxonomy; it **imports** the scoping rule.

**Decision**: Few-shot, if present, is 1–2 **synthetic** shape examples, stored with `schema_version`, token count, and expiry after the next labeled eval. They are not added in the repair-retry panic path. They are not built from reviewer `edited_accept` objects without a PII review and an eval-set promotion process. They are candidates for **deletion** once native structured output drops Class P/H enough. They are out of bounds as the primary control for B/C/U. See [flaky-output triage ADR-002](../../prj--llm-flaky-output-triage/_docs/04_architecture_decision_records.md#adr-002) and [ADR-003](#adr-003) here.

**Consequences**:
- (+) Aligns with the sibling playbook; interview answers stay consistent across projects.
- (+) Example rot becomes a budget, not a prompt graveyard of real resumes.
- (–) A rare case where a domain few-shot *does* lift field exact-match must go through eval, not a Friday paste.
- **Alternative rejected**: ban few-shot entirely. Incorrect on providers without structured output and residual style issues (key order a picky parser demands).
- **Alternative rejected**: few-shot zoo of production documents. PII, rot, and Class C camouflage.
- **Revisit trigger**: same as triage — documented lift on a held-out **content** metric after schema/tools were already in place. Narrow exception, still not a default.
