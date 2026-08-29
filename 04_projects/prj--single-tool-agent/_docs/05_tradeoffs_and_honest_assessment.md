# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This is the document that answers the scenario's questions without theater. The other docs exist so those answers are implementable. If you only read one file after the [Scenario](./01_scenario_and_requirements.md), read this one.

## 1. Direct answers

### 1.1 Why "just function calling" is necessary but insufficient

Function calling is a legitimate **shape** control for the planner: named tool, typed arguments, fewer "please output JSON" preambles. Constrained decoding of the *call* is real progress over regexing a fake DSL out of prose.

It does not:

- **Make the model look things up** (Class G). It *offers* a tool. Skip is allowed by `tool_choice=auto`.
- **Make arguments authorized** (Class A). Schema-valid `order_id` is not "this caller may see this row."
- **Make the user-facing sentence true** (Class T). A timeout plus a fluent paragraph is the system working as the cookbook specified.
- **Bound cost or load** (Class L). `while tool_calls` is not an SLO.
- **Make tool JSON trusted** (Class I). You concatenated untrusted data into a prompt.

If the teammate's evidence is "the model invoked the function in the demo," that is the expected happy path. It is not an authorization result, not a grounding result, and not a termination proof.

### 1.2 What you actually do

Gate arguments and authz server-side, cap the loop, type the tool outcomes, allowlist observations, refuse `grounded_answer` without `ok`, show `structured_status` in the UI. The [loop contract](./03_system_design.md#2-the-loop-contract) is the short form. The [2-minute answer](./01_scenario_and_requirements.md#the-2-minute-answer) is the spoken form. They are the same design.

### 1.3 This says "I couldn't check" more often than their loop. That is the trade-off.

Their loop: almost every message gets a paragraph; some fraction are unauthorized lookups or invented ETAs; exceptions look rare. This design: grounded rate drops; templates appear; the checkable failures (A, T, G-on-labeled-intents) stop looking like success. **If the actual distribution is you querying your own weather API**, they were faster and locally correct — call the API, print JSON, stop. If the tool reads customer orders, the extra refusals are the product.

## 2. When a bare function-call wrapper *is* the right call

Say this out loud or the architecture becomes religion and people will ignore it until they rewrite it as a 20-line script anyway.

| Situation | Why thin is OK | Still do |
| --- | --- | --- |
| Personal weather / public API, one user (you) | No Class A; leak is your own forecast | Timeout; don't loop unbounded |
| Prototype / hackathon, mock DB | Incident cost is zero | Don't paste the mock into production |
| Form with a required order-id field, then generate a gloss | You don't need an agent to *decide* to look up | Just call the API; skip the planner |
| Internal CLI, same identity as the DB role, read-only, no PII | Confused deputy is you | Cap turns at 1–2 |
| The "agent" is a teaching notebook for SDK syntax | Pedagogy | Do not put it on a public chat surface |

**Not** on the OK list: multi-customer support chat; any tool that can read another tenant's row; unbounded `while`; "we're logged in so authz is done"; stuffing `notes` into the prompt because the demo looked richer.

## 3. Cost comparison: loop budget vs. safety gained

Illustrative arithmetic — replace with your tokens, QPS, and skip rate in Phase 1. The *shape* is the point. **No fabricated benchmark pretending to be a paper.**

Assume: majority of status questions call correctly on turn 0 once the schema is advertised. Residual skip is a small-to-medium percent depending on the provider. Each extra turn is ~1× the generation cost of turn 0.

| Policy | Model spend | What it moves | What it does not move |
| --- | --- | --- | --- |
| No tool, prompt-only | 1.0× | Nothing on truth | Invented ETAs |
| Function calling, no gate, unbounded | 1.0× + unbounded tail | Shape of calls | Authz, skip, timeout narration |
| Gate + cap 4 / 3, no forced grounding | ~1.0–1.3× | Class A, L | Residual G |
| + skip-recovery once | +skip_rate × 1 turn | Labeled Class G | Unlabeled phrasing |
| `tool_choice=required` always | ~1× extra call even on "hi" | Skip on status | Chitchat quality; Class L if left on |
| Second LLM "is this grounded" on 100% | +~1× always | Uncalibrated vibes | Correlated lies |
| Full agent platform (MCP, 8 tools) | 2.2's bill | Multi-tool | This warm-up's learning goals |

**The expensive part is not tokens.** It is wiring authz correctly, keeping the UI honest (`structured_status`), and not adding a cancel-order tool because a PM sat in the demo. Tokens for 50k status chats/day at 1–2 turns are rounding error next to one cross-customer leak.

**Diminishing returns after skip-recovery:** if the model skipped, one `required` shot often produces the call. Turn 3–4 on the same invalid id is Class L, not quality.

## 4. What this system cannot promise

1. **That the model will always choose to call the tool** on unlabeled intents. Forced grounding catches the cases you detect. Residual Class G remains. Measure it; do not claim 0% skip.
2. **General prompt-injection immunity.** Class I here is tool-output → prompt, closed in v1 by omitting `notes`. User-prompt injection ("ignore policy") is a different vector. Write tools would make it worse — they are out of scope.
3. **That `structured_status` will match the warehouse.** The tool can be wrong if the orders DB is stale. This is a lookup, not a TMS.
4. **A complete support agent.** One read-only tool cannot cancel, refund, or re-route. Completeness is 2.2+ and 2.4 (HITL). Shipping those inside this repo is how the warm-up dies.
5. **Provider-identical `tool_choice`.** Some models ignore `required`, hallucinate tool names, or parallel-call. Phase 0 measures *your* provider. A blog post about "native tool use" is not a test.
6. **That identical user copy for `not_found` and `authz_denied` will satisfy all PMs.** Existence leaks vs. "tell them it's not theirs" is a security vs. UX fight. This design picks leak-avoidance. Document it.
7. **That this is cheaper than a non-LLM order-status page.** A form that looks up by id is simpler, faster, and easier to authz. The agent is justified when the *channel* is already chat and you are adding lookup, not when you invent chat to look up orders.

## 5. Fuzzy cases — operational rules

| Mess | What not to do | What to do |
| --- | --- | --- |
| User pastes someone else's id | Execute then hope the model redacts | Gate deny; identical not-on-account copy |
| Skip on "where's my stuff" with no id | `required` lookup with a guessed id | `needs_clarification` — ask for the id |
| Timeout | Let the model "be helpful" | Template `tool_unavailable` |
| Model gloss contradicts row | Show the gloss | UI: `structured_status`; drop gloss or fail closed |
| Same id called twice | Re-query "for freshness" | `duplicate_call`; 8s freshness is enough |
| Support wants notes in the answer | Add `notes` to the schema on Friday | Human console; ADR-004 revisit |
| PM wants cancel-order | "It's just one more function" | Stop this project; start 2.2/2.4 with HITL |
| Provider has no `tool_choice` | Drop compose-time block | Keep block; measure skip; consider not using this provider for agents |

## 6. Complexity vs. payoff (be adult about this)

| Investment | Complexity | Payoff | Verdict |
| --- | --- | --- | --- |
| One tool schema + one LLM turn | Low | Teaches the SDK | Mandatory to learn 2.1 |
| Session identity on the request | Low | Makes Class A discussable | Mandatory if any customer data |
| Tool-call gate (schema + authz) | Low–medium | The actual security control | Phase 2; do |
| DB query scoped by `customer_id` | Low | Defense in depth | Do, even with a gate |
| Turn/execution cap + duplicates | Low | Bounds cost and DB load | Phase 2; do |
| Typed outcomes + templates | Low | Kills narrated timeouts | Phase 2–3; do |
| Observation allowlist | Low | Closes notes injection in v1 | Phase 3; do |
| Forced grounding + skip-recovery | Low–medium | Catches labeled Class G | Phase 3; do |
| Fancy intent classifier LLM | Medium | Maybe fewer false `must_ground` | After skip metrics exist |
| Multi-tool MCP runtime | High | That's 2.2 | **Not here** |
| Judge LLM on every reply | High $ | Ego | Rejected as default |
| Write tools without HITL | High risk | Demo wow | Forbidden in this project |

## 7. Relationship to sibling / later projects (do not duplicate them)

- **Roadmap 2.2 `agent-core`** owns MCP, multi-tool ReAct, transport vs policy vs runtime as *layers*. This project is the smallest policy+runtime that makes those layers worth building. If you add a tool registry here, you have started 2.2.
- **Roadmap 2.4 Human-in-the-loop** owns irreversible actions. This tool is read-only so 2.1 can exist without an approval node.
- **Roadmap 3.x harness / observability** will want turn traces. This project **emits** the turn/call/result shape; it does not build Jaeger.
- **[prj--structured-output-extractor](../../prj--structured-output-extractor/README.md)** owns schema-valid ≠ true for *extraction*. This project is the cousin for *tool use*: schema-valid call ≠ authorized or grounded.
- If 2.2 is not built, this one still works as a chat lookup with a gate. Claiming "we have agents" because function calling is on is a lie.

## 8. Kill criteria

Stop calling this an agent runtime (keep the 2-minute answer as a teaching doc if you want) if:

1. The executor runs before the gate, or the DB credential can read arbitrary orders.
2. Callers display model prose as status when `outcome != grounded_answer` (including `tool_unavailable` payloads).
3. The turn cap grows every demo; `tool_choice=required` is left on globally.
4. `notes` (or address, full tracking) is added to the prompt without an ADR-004 revisit and an injection fixture.
5. A write tool (cancel, refund, email) ships in this repo "temporarily."
6. Phase 3 judges / extra LLMs are demanded before Phase 0's authz rule and cap exist.
7. After Phase 3, **ungrounded_blocked + skip on labeled status questions stays above ~20%** (order of magnitude — pick your number from CSAT, but pick it) *and* you refuse a form-based lookup. Then this channel is a bad fit for LLM tool use with this provider. Continuing to add turns is how you pay LLM rates for a worse order-status page.

Those are not moral failures. They are a decision that fluent paragraphs-at-any-cost is the actual process. Document it and stop spending architecture on a contract you will not enforce.

This is a **warm-up**. The success criterion is not "best support bot." It is: you can explain the loop, the gate, and the five classes without pretending the SDK was the runtime — and then you are allowed to start 2.2.
