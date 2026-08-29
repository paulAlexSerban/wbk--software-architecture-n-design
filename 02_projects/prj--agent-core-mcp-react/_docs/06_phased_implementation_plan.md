# Agent-Core MCP + ReAct — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not an MCP hello-world.** Building ReAct against an uninventoried tool list is how you ship a loop that flags customer accounts. Phase 4 is ongoing operations, not a calendar day.

Rollback/kill criteria at the bottom apply at every phase. In particular: **never enable a write tool in an environment whose confirmation gate is off unless a named approver has signed the per-tool opt-out.** Never enable a third-party MCP origin that is not allowlisted with a recorded pin.

Calendar assumptions: one small team, sequential phases. Read-only MCP + budgeted ReAct (Phase 1) can ship in front of writes if the product can live as an investigator. Do not enable `create_issue` / `flag_account_for_review` until Phase 2's gate is green. Do not connect a vendor MCP until Phase 3's gate is green.

Stack reminder (implementation later, not this repo): TS or Python MCP SDK, LangGraph *inside* the runtime module only, Docker for server and runtime as **separate** images.

## Phase 0 — Inventory Blast Radius and Whether MCP Is Justified (Days 1–3)

**Objective**: Classify every tool, every credential, and the third-party origin (or explicitly defer it). Guessing that "Jira creates are idempotent" is how attempt 2 is born. Guessing that "we need MCP because the prompt said so" is how you add a protocol for one client.

**Deliverables**:
- A table, one row per intended tool (AWS ×3, Jira ×4, DB ×2): side-effect class, IAM/Jira/DB principal used, human ACL mapping, idempotency support, lookup-by-key, timeout/5xx-may-have-applied behavior, typical latency, pagination/result-size cap, PII in results.
- Evidence, not vibes: redacted successful responses; a **double POST with the same key** to Jira (or the proxy); double POST with different keys (baseline duplicate); timeout test; Cost Explorer / EC2 describe cost sample.
- LLM provider notes: token reporting, abort behavior (for policy-call cancel). Not the load-bearing write path.
- Third-party MCP: name the origin or write **Phase 3 deferred**. If named: TLS, auth model, `tools/list` sample, whether any tool is write-shaped, whether schemas demand a context blob, a **golden hash** of today's list, a one-paragraph threat note (poisoning, exfil).
- Second-client question: who besides our runtime will call this server in 90 days? If nobody, document that MCP is speculative; still allowed to proceed (the server is the reuse bet) but do not start a gateway.
- Product/security asks sent in writing: confirmation default; DB row-level authz feasibility; whether `[agent-key:]` may appear in Jira descriptions; budget numbers. See [Trade-offs §3](./05_tradeoffs_and_honest_assessment.md#3-what-i-would-ask-for-even-though-i-expect-a-no-or-a-fight).
- Feasibility calls: if `flag_account_for_review` cannot be ACL'd to the human, **cut the tool**. If Jira has neither idempotency nor lookup, choose: (a) fingerprint comment + human recon, (b) keep writes off the agent, (c) confirm-only with extremely conservative unknown handling. Write down which.
- Kill/proceed: proceed to Phase 1 for **reads** regardless. Proceed to *enabling writes* only under Phase 2. Proceed to vendor MCP only under Phase 3.

**Exit Gate**:
- [ ] Inventory table exists with evidence links for AWS, Jira, DB.
- [ ] No arbitrary SQL, no mutating AWS, in the planned `tools/list`.
- [ ] Written choice for Jira no-idempotency case, if that is what was measured.
- [ ] `query_customer_account` ACL approach exists or the tool is cut.
- [ ] Third-party origin named **or** explicitly deferred.
- [ ] Asks to security/product/tool owners have been sent. Replies for **row-level ACL** are required before Phase 2 DB writes. Replies for finance-style budgets can wait; pick conservative defaults.
- [ ] Three-layer module skeleton named (even if empty) so Phase 1 cannot dump everything in `agent.py`.

## Phase 1 — First-Party Read-Only MCP Server + Budgeted ReAct (Days 4–9)

**Objective**: Prove MCP server interoperability for **reads**, and prove the runtime loop with hard budgets, **without write tools registered**. Prove the layer split. This is the first thing that can demo without lying.

**Deliverables**:
- `agent-core-mcp-server` Docker image: `describe_ec2_instances`, `get_s3_bucket_size`, `get_monthly_cost_by_service`, `search_issues`, `query_customer_account` (if ACL exists). JSON Schema, `x-side-effect: read`, `x-contract-version`, result caps.
- Authn: JWT or mTLS bound to `user_id` + `run_id`. Authz: human ∩ tool policy on `query_customer_account` and Jira project allowlist.
- Runtime: `runs` + `react_steps`; pin first-party `tools/list`; budgets ([System Design §1.6](./03_system_design.md#16-budget-defaults-starting-points-not-religion)); policy module with ReAct; transport module speaking MCP (Streamable HTTP in the Docker compose path; stdio allowed for local first-party only).
- Import-linter (or equivalent) : policy does not import MCP SDK; transport does not import prompts.
- LangGraph, if used, only inside runtime; **retry policies disabled** on tool nodes.
- Foreign client proof: MCP Inspector or a script **not** our runtime lists tools and calls one read with a valid token; a call with a token for the wrong user is denied on `query_customer_account`.
- Metrics: iterations, tool calls, budget stops, authz denials.

**Exit Gate**:
- [ ] Write tools are **not** in `tools/list`.
- [ ] Budget exhaustion test: a policy stub that always requests another read stops at the cap with `budget_exhausted` and **zero** extra LLM calls after the cap (or one only if `budget_summary` is explicitly on — default off, test default).
- [ ] Wrong-account `query_customer_account` denied at the **server**, even if policy asked.
- [ ] Foreign client can read; layer CI green.
- [ ] Kill runtime mid-read, restart: no write could have happened (none exist); run does not loop forever (lease + budget).
- [ ] Pagination/caps: a malicious `describe_ec2_instances` without filters does not dump the org; truncated flag set.
- [ ] Transport retry on a flaky **read** fake: bounded, then observation error — not infinite.

Do not start Phase 2 until the server deny test is green. That test is the confused-deputy rehearsal.

## Phase 2 — Write Tools, Dispatch Ledger, Confirmation Gate (Days 10–16)

**Objective**: Put `create_issue`, `add_comment`, `transition_issue`, `flag_account_for_review` on the path without autonomous apply and without retry-duplicates. The gate is the timeout-and-confirm tests, not a pretty token class.

**Deliverables**:
- Write tool schemas with required `idempotency_key` + `confirmation_token` (runtime-merged).
- Confirmation UI + `confirmations` table; canonical fingerprint spec shared with the server ([System Design §3.3](./03_system_design.md#33-confirmation-token)).
- Dispatch-first ([System Design §6](./03_system_design.md#6-write-tool-execution-first-party--load-bearing-path)).
- Server: refuse write without token/key; 409 on same key different body; replay same key same body returns original.
- Runtime: no auto-retry on writes; unknown on timeout; policy not invoked to "try again" on the same fingerprint while unknown.
- Tests with a fake Jira/DB: delay ACK; confirm then timeout; crash after dispatch commit; double confirm click; reject path (zero provider calls).
- Feature flag: writes off until this gate is green even if the code exists.

**Exit Gate**:
- [ ] Reject confirmation: zero Jira POSTs, zero DB UPDATEs.
- [ ] Confirm then fake 200: one POST, one key, observation has issue key / flag ack.
- [ ] Confirm while provider blocked: one POST; outcome succeeded or unknown; **never** a second key.
- [ ] Crash after `recorded` commit, restart: same key, at most one apply.
- [ ] Forged `confirmation_token` from policy args: discarded; server still rejects if runtime were buggy (test the server with a garbage token).
- [ ] Foreign client write without token: unauthorized.
- [ ] `flag_account_for_review` wrong account: unauthorized at server.
- [ ] Duplicate confirm: one apply.
- [ ] Expired confirm: no apply; new confirm required.
- [ ] If Jira failed Phase 0 double-POST-same-key: written recon procedure + product acknowledgement **before** prod flag on.

If security has not signed row-level ACL, `flag_account_for_review` and `query_customer_account` stay off. Jira writes can still proceed if project ACL exists.

## Phase 3 — Third-Party MCP Client, Pinning, Sandbox (Days 17–21)

**Objective**: Prove we are an MCP **client** of someone else's server without giving them our deputy powers. **Entry gate:** Phase 0 named an origin (not deferred). If deferred, skip this phase, mark N/A, do not fake it.

**Deliverables**:
- Allowlist config: origin, expected golden hash (or `accept_new_pin` operator action).
- Separate vendor credential.
- Pin at session start; refresh mismatch → `contract_drift`.
- PolicyView subset: strip write-shaped vendor tools.
- Outbound denylist: cannot pass customer DTO / secrets; test that a policy proposal stuffing `query_customer_account` output into vendor args is blocked.
- Size cap + injection heuristic + no write-confirm in the same step as a flagged observation ([System Design §7](./03_system_design.md#7-third-party-tool-execution)).
- No stdio third-party in the compose **prod-like** profile.

**Exit Gate**:
- [ ] Golden hash mismatch at init → no tools from vendor in PolicyView; run fails pin or waits for operator accept (tested both if both exist; default fail closed).
- [ ] Mid-run mutated `tools/list` (fake vendor) → `contract_drift`, new tool **not** callable.
- [ ] Vendor result containing `flag_account_for_review` / "ignore previous" → flagged; **no** write dispatch in that step; a later write still requires human confirm of the actual args.
- [ ] Vendor schema asking for free-form `context`: either blocked or filled with non-PII only — asserted by test, not by comment.
- [ ] First-party writes still work with vendor down (degraded).
- [ ] Vendor never receives AWS/Jira/DB credentials (traffic intercept in test).

If the real vendor cannot be allowlisted in time, **do not** substitute a second local MCP server and call the gate green. Lab exercise optional, labeled "not Phase 3."

## Phase 4 — Versioning Process, Auth Hardening, Recon, Alerts (ongoing)

**Objective**: Treat the server like an enterprise API. Close unknown writes without "retry create."

**Entry Gate**: Phase 1 green. Phase 2 green if writes are on. Phase 3 optional.

**Deliverables**:
- Contract change checklist: minor vs major ([ADR-006](./04_architecture_decision_records.md#adr-006)); deprecation window; pin impact on in-flight runs.
- Recon worker for unknown dispatches ([System Design §10](./03_system_design.md#10-reconciliation-of-unknown-writes)); **no** `inspect_idempotency_key` on `tools/list`.
- Support view: timeline, confirms, dispatches, pins. "Did we file?" reads dispatch.
- Alerts: unknown age; contract_drift; budget_exhausted rate; authz denial spikes; third-party flag rate; dispatch insert failures; dual-lease.
- Secret rotation drill for runtime JWT signing, vendor token, Jira bot, IAM role.
- Foreign-client read-only prod posture documented; any foreign **writer** is a written exception.
- Runbook line: **do not re-run the agent to "make sure the ticket exists."** Look at the dispatch row.

**Exit Gate** (re-checked):
- [ ] Chaos: kill runtime during `create_issue`; recon ends at most one issue (fake + one staging Jira).
- [ ] Unknown older than SLA pages a human, not a retry bot.
- [ ] A breaking schema change cannot ship without major/deprecation notes in the PR template.
- [ ] The debug "just call the adapter" bypass does not exist in prod images.

This phase has no calendar end. Unknown rate should fall as wait-out does its job. If `contract_drift` is common, the vendor is unstable or we re-list too often — pin harder, do not merge lists.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop and escalate — do not keep write flags green — if any of the following hold:

1. **A write applied without a confirmation row** (except a signed per-tool opt-out in that environment). Roll back the write flag.
2. **A retry or second worker issued a new idempotency key** for the same fingerprint. Kill the retry path.
3. **`AUTO_CONFIRM=true`** or a global skip appears in prod. Delete it.
4. **LangGraph or MCP SDK retries writes.** Disable; treat as sev.
5. **Arbitrary SQL / mutating AWS / shell tool** added "temporarily." Remove; new ADR required.
6. **Third-party origin not on the allowlist**, or stdio vendor in prod-like deploy. Disconnect.
7. **PII or first-party secrets in vendor `tools/call` args.** Disconnect vendor; review logs.
8. **Policy module imports MCP SDK** (layer breach). Fix before any other work.
9. **Pressure to skip Phase 0** because a demo is Friday. Demo Phase 1 reads only. Do not demo confirm+Jira until Phase 2 is green. Do not demo vendor MCP until Phase 3 is green.
10. **Unknown ignored** ("assume the ticket failed, create again"). That assumption is the duplicate. Treat as a sev.
11. **Server authz bypassed** because "the runtime already checked." The second check is the product.

Rollback is always to the last phase whose exit gate was honestly green, with writes and vendor flags off if those phases failed. After a kill, users may still get a read-only investigator. They do not get a confident autonomous deputy we could not defend.

## Suggested Test Matrix (bind to gates)

| # | Scenario | Phase gate | Expected terminal / outcome | Provider writes | Notes |
| --- | --- | --- | --- | --- | --- |
| T1 | Read-only question under budget | 1 | `completed` | 0 | |
| T2 | Policy stub infinite reads | 1 | `budget_exhausted` | 0 | No wrap-up LLM call |
| T3 | Wrong-account customer query | 1 | observation unauthorized | 0 | Denied at server |
| T4 | Foreign client read | 1 | ok | 0 | |
| T5 | Confirm reject `create_issue` | 2 | observation rejected | 0 | |
| T6 | Confirm accept, Jira 200 | 2 | succeeded + issue key | 1 | |
| T7 | Confirm accept, Jira timeout | 2 | `unknown`; no second key | 1 | |
| T8 | Crash after dispatch commit | 2+4 | same key; ≤1 issue | 1 | |
| T9 | Foreign client write, no token | 2 | unauthorized | 0 | |
| T10 | Double confirm click | 2 | one apply | 1 | |
| T11 | Vendor hash mismatch | 3 | `contract_drift` / fail pin | 0 | |
| T12 | Vendor result injects write name | 3 | flagged; no same-step write | 0 until later confirm | |
| T13 | Policy tries to send PII to vendor | 3 | blocked | 0 | |
| T14 | Vendor down, first-party read | 3 | completed degraded | 0 | |
| T15 | Late Jira 200 after unknown | 4 | recon succeeded; no second issue | 1 | |

T2, T3, T7, T8, T12 are the tests that decide whether the team understood the scenario. If they are missing, the rest is an MCP tutorial.
