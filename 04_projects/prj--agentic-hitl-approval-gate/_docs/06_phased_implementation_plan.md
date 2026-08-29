# Agentic HITL Approval Gate — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not an n8n demo.** Building Approve against an uninventoried send path and an unnamed approver list is how you ship a button that emails people. Phase 5 is ongoing operations, not a calendar day.

Rollback/kill criteria at the bottom apply at every phase. In particular: **never enable the real mail API until Phase 4's gate is green, and never ship a timeout that continues into send.**

Calendar assumptions: one small team, sequential phases. Draft+guardrail (Phases 1–2) can ship in front of real humans if send is dry-run. Do not give the model a mail credential at any phase. Do not enable live send until Phase 4.

## Phase 0 — Inventory Actions, Approvers, Channels, and Policy (Days 1–2)

**Objective**: Write down what is irreversible, who may approve, where drafts may appear, and what "pass" means for guardrails. Guessing that "we'll use the Slack channel" is how spectators approve and how PII lands in the wrong tenant.

**Deliverables**:
- A table, one row per agent-reachable action: side-effect class (`read` | `irreversible`), whether it is in v1 scope, idempotency/lookup support if it is send. Start with research reads and `send_email`. Confirm research does not write.
- Approver directory source: role or explicit list; how joiners/leavers update `approver_bindings`; confirmation that requester ≠ approver will be enforced. Two real identities identified for later tests.
- Notification channel: Slack vs email vs in-app only. Written answer: **may the full draft body go to that channel?** If no, link-only. If Slack, how Slack identities map to `actor_id`.
- Guardrail rule list signed off enough to implement Phase 2: from-identities, recipient allowlist vs denylist (pick one), max recipients (this scenario: 1), marketing/consent/suppression if applicable, PII patterns.
- Product answers in writing: TTL (default 48h); **timeout must not send** (reject any other answer); self-approval forbidden; whether "reopen same version" is wanted later.
- Mail vendor evidence: idempotency header, double-POST-same-key test, lookup-by-key, typical latency. Same bar as the cancellation project's Phase 0.
- Isolation plan: which process gets mail credentials (send adapter only).
- Feasibility call: if the team has one human, either (a) this is confirm-before-send, not HITL, or (b) a second person is named. Write down which. If (a), stop calling it this project.

**Exit Gate**:
- [ ] Action inventory exists; `send_email` is the only irreversible v1 action; research classified.
- [ ] Allowlist vs denylist is a written product choice, not an engineer default.
- [ ] Draft-in-Slack (or not) is written. Legal/security has been asked (reply not required to start Phase 1; **required before Phase 3 notifications leave our network**).
- [ ] Two approver identities exist for tests; self-approval policy confirmed forbidden.
- [ ] Timeout-send has been explicitly rejected in writing.
- [ ] Mail credential will not be mounted on the draft/LLM worker (infra note).
- [ ] Kill/proceed: proceed to Phase 1 regardless; proceed to *live send* only under Phase 4.

## Phase 1 — Durable Run Ledger and Immutable Draft Versions (Days 3–5)

**Objective**: Make research+draft produce write-once versions with hashes. Send is not implemented (or hard-stubbed to throw). Prove the run can sit in a durable status without a worker.

**Deliverables**:
- `runs` + `draft_versions` as in [System Design §1](./03_system_design.md#1-data-model). Run created before any LLM call.
- Canonicalizer `canon.v1` and stored `content_hash` + `canonicalizer_id`.
- Orchestrator: research → draft → persist version → stop (status `drafting` complete or a holding status that is not send). No `send_email` tool on the model.
- Work lease released when idle. Restart does not re-draft unless status says to.
- Max redraft counter exists even if unused.
- Tests: two drafts are two rows; mutating a version is impossible (DB grant / application rule); hash stable for identical payload; hash changes if `to` or body changes.

**Exit Gate**:
- [ ] Planner tool schema inspection: no send tool, no mail SDK import in that process.
- [ ] Crash after draft insert, restart: no second version unless a new draft is explicitly commanded; no send.
- [ ] Canonical form tests (NFC, sorted emails, CRLF) exist.
- [ ] `send_email` is still impossible in this environment (no creds, adapter not wired).

Do not start Phase 2 until the "no send on the model" check is mechanical, not a prompt review.

## Phase 2 — Guardrail Pipeline, Fail Closed (Days 6–7)

**Objective**: Every version gets a stored pass/fail. Fail never creates an approval request (the request table may not even exist yet; then fail never proceeds to a "ready_for_approval" status).

**Deliverables**:
- Checker implementing [System Design §7](./03_system_design.md#7-guardrail-rules-v1-minimum) plus Phase 0 extras.
- `guardrail_results` persisted. Bounded redraft on fail (e.g. 3) then `failed_policy`.
- Injection-marker fixtures (research text and draft body) as tests.
- No `override` parameter anywhere.

**Exit Gate**:
- [ ] Disallowed recipient domain: fail, no ready-for-approval.
- [ ] Extra recipients / header CR in subject: fail.
- [ ] Wrong `from`: fail.
- [ ] Passing payload: pass, status ready for Phase 3 to arm the gate.
- [ ] A test that tries `override=true` does not exist on the API; if someone added it, delete it.
- [ ] False-positive review: at least one real fixture from Phase 0's allowlist passes. If everything fails, rules are unusable; fix rules, do not add override.

## Phase 3 — Approval Gate, Authz, Hash Bind, Expiry, Notify (Days 8–10)

**Objective**: Humans can approve/reject. Send still dry-run (adapter records "would send" or is not called). The gate is real even without SMTP.

**Deliverables**:
- `approval_requests`, `approval_decisions`, `approver_bindings`, `audit_events`.
- Decision API with [System Design §6](./03_system_design.md#6-authorization-algorithm-approve).
- Approver GET of canonical body + hash + guardrail report; summary labeled non-authoritative.
- Expiry worker; `WHERE status = 'open' AND expires_at > now()` on approve.
- Notifier per Phase 0 (link-only if required). Slack buttons, if any, call our API with `expected_content_hash`. Truncated Slack preview is not an Approve button.
- Unique indexes: one open request per run; one effective decision per request.
- Dry-run send hook: on effective approve, write `would_send` audit, **do not** HTTP to mail.

**Exit Gate**:
- [ ] Requester Approve: 403; request stays open.
- [ ] Unbound actor: 403.
- [ ] Approve with wrong hash: stale; no would-send.
- [ ] Reject: new draft version required; old request cannot approve.
- [ ] Expire then Approve: stale; no would-send.
- [ ] Double Approve: one effective decision.
- [ ] Restart during pending: still pending; no would-send; notify may duplicate.
- [ ] Process cannot call mail (still no creds / still dry-run).
- [ ] Legal sign-off on notification channel received **or** notifications stay in-app only.

## Phase 4 — Send Adapter, Dispatch Ledger, Live Send Behind a Flag (Days 11–13)

**Objective**: Wire the mail API the way [ADR-005](./04_architecture_decision_records.md#adr-005) requires. The gate is approve-to-one-POST.

**Deliverables**:
- Send adapter: re-read decision, insert dispatch, HTTP, outcome. Mail creds only here.
- Idempotency key to vendor if Phase 0 found one.
- Feature flag `LIVE_SEND` off by default; staging inbox for tests.
- Wakeup on approve: pending → sending → terminal. Approve-to-send not measured in hours.
- `unknown` on timeout; no new key. Reuse cancellation-project semantics.
- Tests that force Sequence D (double wakeup) and Sequence A (hash match).

**Exit Gate**:
- [ ] Happy path against staging inbox: one message, hash matches sent bytes (capture raw MIME or provider preview).
- [ ] Double Approve / double worker: one POST (assert on fake or provider logs).
- [ ] Approve v1 after v2 exists: no send of v1; no send of v2 without its own approve.
- [ ] Crash after dispatch insert, before 200: at most one message (same key).
- [ ] Injection fixture from Sequence E: still zero sends without a human approve of a *passing* draft.
- [ ] Flag off: production has no live send. Flag on only after this gate.
- [ ] If vendor failed same-key test in Phase 0: written ops procedure and product acknowledgement, same as cancellation Phase 2.

## Phase 5 — Audit, Alerts, Metrics, Runbook (ongoing)

**Objective**: Operate the pending queue without inventing timeout-send under pressure.

**Entry Gate**: Phase 3 is green. Phase 4 may still be flagged off (you can alert on pending without SMTP).

**Deliverables**:
- Support/compliance view: timeline of versions, hashes, checks, decisions, dispatches. "Who approved this?" reads the decision row.
- Alerts: pending age (e.g. 24h of 48h TTL); open pending count; expiry count; notify_failed; send unknown; dispatch-insert failures; self-approval 403 spike (curious, not a success metric).
- Metrics: time-to-decision, reject rate, redraft count, expired rate, send unknown rate.
- Runbook: **do not resend from the dashboard.** **do not add timeout-send to clear a backlog.** Resolution of unknown is succeeded/failed, not "click send." Deprovision leavers from `approver_bindings`.
- Audit export for a sample sent run that matches success criterion 10 in [Scenario](./01_scenario_and_requirements.md).

**Exit Gate** (re-checked):
- [ ] A sent run's export names requester, hash, approver, decision time, dispatch key, provider id without Slack.
- [ ] Expired runs page or ticket; none of them have a mail POST.
- [ ] Binding removal for a test user immediately 403s Approve.
- [ ] The scrape/debug "skip approval" button does not exist.

This phase has no calendar end. If expired rate is high, staffing or TTL is wrong — tune those, do not send on timeout.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop and escalate — do not keep Approve green, do not keep `LIVE_SEND` on — if any of the following hold:

1. **Timeout or Wait-continue sent mail** (or would-send in Phase 3). Kill the continue path. Expiry is deny.
2. **Send tool or mail SDK reachable from the model worker.** Remove creds. That is a sev.
3. **A send went out with a hash the approver did not see** (mutation after hash, HTML added, tracking pixel, summary-only approve). Disable live send. Fix canonical payload.
4. **Self-approval works in a shared workspace.** Revert. Do not "just for staging" if staging shares prod Slack.
5. **Retry / second worker / second Approve issued a new idempotency key** for the same version. Kill the retry path.
6. **Override/skip-approval added to unblock a demo.** Delete it. Demo dry-run Sequence A with two identities.
7. **Pressure to skip Phase 0** because a demo is Friday. Demo research+draft+dry-run approve only. Do not demo live send until Phase 4 is green.
8. **Unknown ignored** ("we'll assume it didn't send"). Same as the cancellation project: that assumption is the double-send.
9. **Draft bodies in Slack after legal said no.** Turn notifications to link-only.

Rollback is to the last phase whose exit gate was honestly green, with `LIVE_SEND` off if Phase 4 was the failure. After a kill, requesters still get drafts and a gate. They do not get a confident Send we could not defend.

## Suggested Test Matrix (bind to gates)

| # | Scenario | Phase gate | Expected terminal | Mail POSTs |
| --- | --- | --- | --- | --- |
| T1 | Draft only, no gate yet | 1 | draft persisted, no send tool | 0 |
| T2 | Guardrail fail on domain | 2 | `failed_policy` or redraft then fail | 0 |
| T3 | Guardrail pass | 2 | ready for request | 0 |
| T4 | Request opened, nobody acts, expire | 3 | `expired` | 0 |
| T5 | Requester Approve | 3 | 403, still `pending_approval` | 0 |
| T6 | Approve wrong hash | 3 | stale | 0 |
| T7 | Reject then approve old request | 3 | stale; v2 needs its own approve | 0 |
| T8 | Happy path approve (dry-run) | 3 | would-send audit | 0 |
| T9 | Happy path approve live | 4 | `sent` | 1 |
| T10 | Double Approve / double worker | 4 | `sent` | 1 |
| T11 | Injection text in research | 4 | no send without human+pass | 0 |
| T12 | Crash after dispatch commit | 4+5 | unknown then resolved | 1 (same key) |
| T13 | Late Approve after expiry | 3/4 | stale | 0 |
| T14 | Restart during pending | 3 | still pending | 0 |

T4, T5, T10, T11 are the tests that decide whether the team understood the scenario. If they are missing, Sequence A on a Friday is theater.
