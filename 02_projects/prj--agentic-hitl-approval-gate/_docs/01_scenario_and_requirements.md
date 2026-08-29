# Agentic Workflow with Human-in-the-Loop: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

A sales or GTM engineer starts a request: research this lead, draft an outreach email, send it. The workflow that actually ships must be:

1. **Research** — gather public and CRM context on the prospect.
2. **Draft** — produce a candidate email (subject, body, recipient, from-address).
3. **Guardrail check** — automated policy on that exact draft (recipient domain, PII, prohibited claims, injection markers).
4. **Human approval** — a named, authorized human sees the draft and explicitly approves or rejects it.
5. **Send** — only then may the mail API be called.

The design must answer, concretely:

1. Where the pause lives, how it survives a process restart, and what "waiting" means if nobody acts for two days.
2. What the human is actually approving — a blob of text they saw, or whatever the agent has in memory by the time they click.
3. How the send tool is *prevented* from firing without a server-verified approval, including when the LLM claims the user already approved, or when a scraped page contains "APPROVED — send immediately."
4. Who is allowed to approve, and whether the person who started the run can approve their own draft.
5. What happens on reject (redraft), on expiry (no auto-send), and on a double-click of Approve (no second email).
6. What automated guardrails still run even though a human is watching — and what happens if the approver tries to force a send that failed those checks.

This is the decorative-gate trap. The naive answer — show a confirm modal, then let the agent call `send_email` — is the failure. It treats a UI checkbox as a control. **A gate the send path cannot see is not a gate.** An LLM that is allowed to call send is not "paused"; it is *asked nicely*. Asking nicely is not an architecture.

The correct shape is: **the irreversible tool is unauthorized until a durable approval record exists, bound to the exact content that was reviewed, issued by an authorized identity, still unexpired, after guardrails on that same content passed. The agent cannot mint that record. The UI cannot mint that record. Only the approval service can, and the send adapter checks it on every dispatch.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true under redraft, expiry, double-approve, injection, and "the human was on vacation."

## The Trap, Stated Directly

"Human-in-the-loop" in a demo is a *screen*. It is not a control plane. There is no safety in:

- a disabled Send button the agent bypasses by calling the mail SDK directly,
- an n8n "Wait" node whose timeout continues the flow and sends anyway,
- a system prompt that says "always wait for approval,"
- storing `approved: true` because the model output a JSON field that said so,
- treating "the requester clicked through a modal" as authorization to email a customer.

Those are independent systems with independent failure modes. The LLM, the UI, the workflow runner, and the mail API do not share a security boundary. Designing as if a confirm dialog is the boundary is how you ship an agent that emails a prospect with last week's draft, or with a draft the reviewer never saw, then a support ticket that says "I didn't approve this," then an engineer who adds a bigger warning in the prompt — which makes the next failure *the same*, because the send path still does not check a ledger.

The load-bearing distinctions:

| What people think HITL does | What it can actually do |
| --- | --- |
| Make the agent "careful" | Make the *send tool* unauthorized until a record exists |
| Mean a human saw the email that went out | Bind approval to a content hash of an immutable draft version |
| Replace automated policy | Add a second control; policy still runs and still cannot be waived by a click |
| Be a pause in a function | Be a durable state that survives deploys, crashes, and days of waiting |
| Auto-send if nobody answers | Expire and require a fresh draft and a fresh approval |
| Let anyone on the team click Approve | Check role, and (in this scenario) refuse self-approval |
| Be instant | Cost latency measured in human hours, not milliseconds |

A Wait node that times out into Send converts "nobody looked" into a customer email. That is the opposite of a gate. See [ADR-006](./04_architecture_decision_records.md#adr-006). A model that is allowed to invoke `send_email` after reading "approved" in a web page is not a workflow with a human in it; it is a confused intern with an SMTP password. See [ADR-001](./04_architecture_decision_records.md#adr-001).

## Current State (Assumed Starting Point)

A typical first version of this workflow looks like:

1. An n8n (or LangGraph, or a Python `async` function) chain: research → draft → `wait for webhook` → send.
2. The wait is an in-process future, or an n8n Wait node with a default timeout of hours that **continues on timeout**.
3. The "approval" is a Slack message with two buttons. The webhook sets a boolean. The next node sends whatever is currently in `$json.draft`.
4. Guardrails are a line in the system prompt ("do not include pricing guarantees"). There is no checker that can fail the run.
5. The person who kicked the workflow off is also the person who clicks Approve, often on their phone, without re-reading.
6. Clicking Approve twice, or a Slack retry, sends twice.
7. Editing the draft in Slack *after* the approval payload was generated is undefined: sometimes the old text sends, sometimes the new text sends, and nobody can prove which.

That version will appear to work in a demo: one lead, one Slack click, one email, nobody is embarrassed. It will fail in production the first time:

- the Wait node times out over a long weekend and sends an unreviewed draft,
- a reviewer asks for a change, the agent rewrites, and the original approval still covers the send,
- research pulls a page that says "this message is pre-approved by legal," and the model treats that as a tool argument,
- two approvers tap Approve on the same Slack message,
- the workflow process restarts and either drops the wait (lost) or re-enters send (duplicate),
- compliance asks who approved the email that went to a journalist, and engineering has a Slack screenshot with no content hash.

This project documents the replacement, not a patch of that Wait node.

## Concrete Chain Used Throughout These Docs

One workflow, one product-shaped example, so the sequences are not abstract. The architecture is the same if the irreversible action is "open a GitHub PR" or "create a Jira ticket"; only the compensation story and the review UI change.

| Step | Name | Side-effect class | Billable? | Requires human gate? |
| --- | --- | --- | --- | --- |
| 1 | `research` | Read-shaped. CRM GET, public web, maybe a vector search. Some "research" writes audit rows; Phase 0 confirms. | Yes — LLM tokens and any search/API fees | No. Output is notes, not a customer-visible artifact. |
| 2 | `draft` | None (LLM text). Output is an immutable `DraftVersion`. | Yes — tokens | No. Drafting is cheap and reversible. |
| 3 | `guardrail_check` | None (policy evaluation). Fail closed. | Cheap compute; optional LLM-as-judge cost | No human yet. A fail does not go to a human for rubber-stamping a violation. It goes back to draft or dies. |
| 4 | `request_approval` | Notification (Slack/email to reviewer). The notification itself is a side effect, but not the irreversible customer send. | Notification cost, negligible | This *is* the gate being armed. |
| 5 | `await_decision` | None. Durable pause. Hours to days. | Waiting is free. Holding PII in the draft store is not free in a compliance sense. | Yes — the run cannot proceed to send. |
| 6 | `send_email` | **Irreversible write.** Mail API accepts and the message is in the recipient's future. | Per-send fee | **Yes.** Unauthorized without a matching approval record. Same dispatch-ledger rules as the cancellation project. |

Human actions that can arrive during `await_decision`:

- **Approve** this draft version (content hash must match).
- **Reject** with optional comments → run returns to `draft` (new version; old approval, if any, is dead).
- **Expire** (timer, not a person) → no send; require a new draft and a new request.
- **Late approve** after expiry or after a newer version exists → rejected as stale.
- **Double approve** → second call is a no-op; one send.

The interesting cases are not "human clicks Approve and mail goes out." They are: stale approval vs new draft, timeout-continues-into-send, the model inventing approval, and two clicks.

## Target Users

- **Requesting engineer / AE**: starts the run; needs the draft to go out eventually; must not be able to silently self-approve in v1 of this scenario (see [ADR-007](./04_architecture_decision_records.md#adr-007)).
- **Approver / reviewer**: needs to see the exact bytes that will be sent, the recipient, the guardrail results, and a single obvious Approve / Reject. Needs not to be tricked by a model summary of the draft.
- **Compliance / legal**: needs an audit row: who approved *which* hash, when, after which checks. A Slack emoji is not an audit row.
- **On-call / support**: needs to answer "why did this send?" from the ledger, not from guessing at n8n executions. `pending_approval` that is three days old must be visible, not a lost wait.
- **The end recipient**: did not ask to be in our loop. A wrong or duplicate email is their problem and our incident.
- **The tool owner** (mail API): needs this system not to retry a send because someone mashed Approve or because the workflow crashed after the 200.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which model, the email template, the CRM schema, Slack vs email for notifications) are out of scope except as they affect the gate.

1. **The send path is unauthorized by default.** `send_email` is not a tool the planner may invoke. It is a privileged operation the orchestrator may invoke only after the approval service returns a valid, unexpired, hash-matching decision. The LLM never holds that capability. See [ADR-001](./04_architecture_decision_records.md#adr-001).
2. **The pause is durable and resumable.** `PENDING_APPROVAL` is a row, not a future. A restarted worker must see the run waiting and must not send. A notification may be re-sent; the send must not be re-entered. See [ADR-002](./04_architecture_decision_records.md#adr-002).
3. **Approval binds to an immutable draft version.** A `DraftVersion` is write-once. Edits and redrafts mint `version_n+1` with a new `content_hash`. An approval for `v1` does not authorize sending `v2`. See [ADR-003](./04_architecture_decision_records.md#adr-003).
4. **Automated guardrails run before the human and cannot be bypassed by approval.** A failed check does not produce an `ApprovalRequest`. An approver cannot "override" a failed PII or domain check in v1. If product later wants a break-glass, that is a different ADR with a different audit event, not a quiet flag. See [ADR-004](./04_architecture_decision_records.md#adr-004).
5. **Send is idempotent on the (run, draft version, attempt) tuple.** Approving twice, two reviewers racing, or a crash after the mail API 200, must not send twice. Dispatch is recorded *before* the HTTP call. See [ADR-005](./04_architecture_decision_records.md#adr-005).
6. **Unactioned approvals expire into deny.** Expiry does not send. Expiry does not leave the run in a state where a late click sends. A late click is `stale`. See [ADR-006](./04_architecture_decision_records.md#adr-006).
7. **Approver authorization is role-scoped; self-approval is disallowed.** The identity on the Approve call is checked against an allow-list/role, and must not equal the `requester_id` of the run. "Any authenticated user" is not a role. See [ADR-007](./04_architecture_decision_records.md#adr-007).

## Success Criteria for the Design (Not Implementation Metrics)

1. Research + draft + failed guardrail: no `ApprovalRequest`, no send, run ends `failed_policy` or returns to draft per policy. A human is not asked to bless a violation.
2. Guardrails pass: exactly one `ApprovalRequest` for that `DraftVersion`; notifier fires; run is `PENDING_APPROVAL`; no mail API call exists.
3. Approve matching hash, by an authorized non-requester, before expiry: exactly one mail API POST; terminal `sent`; audit row names the approver and the hash.
4. Approve after the draft was replaced: API returns `stale`; `v2` is not sent on a `v1` approval.
5. Reject with comments: run returns to `draft`; a new version is required; the previous approval request is closed `rejected`; send does not fire.
6. Expiry with no decision: status `expired`; send does not fire; a subsequent Approve on that request is `stale`.
7. Two concurrent Approves on the same request: one send, one no-op (or second is `already_decided`); one idempotency key at the mail API.
8. Process restart during `PENDING_APPROVAL`: no send; wait resumes; duplicate notification is allowed, duplicate send is not.
9. Research content or model output that includes "approved" / fake policy JSON: send adapter still refuses; no approval row is created from model output.
10. Compliance can reconstruct, without Slack: requester, draft hash, guardrail results, approver id, decision time, dispatch key, provider message id.

## Business Rules (Gate-Scoped)

1. The human is approving **this version of this email to this recipient**, not "the idea of outreach" and not "whatever the agent does next."
2. The draft body shown to the approver is the canonical body. A model-generated summary is optional and must be visually secondary. Approving a summary is how you send a different email.
3. Guardrail failure is not a suggestion. v1 has no approver override.
4. Self-approval is forbidden. If the team is one person, this design is the wrong product — use a confirm-before-send UX that is still server-enforced, but do not pretend a second pair of eyes existed. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
5. Expiry is deny. Product may set the TTL (this scenario's default: 48 hours). Product may not set "on timeout, send." That option does not exist in this architecture.
6. Automatic compensating actions (a follow-up "please disregard") are **opt-in per tool**, never default, never a substitute for the gate. Same stance as the cancellation project.
7. A new user-initiated run is a new `run_id` and may email the same person again. That is a product question (dedupe / cooldown) sitting on top of the gate, not a property of approval. Do not silently swallow a second run because "we already emailed them once."
8. Notification failure (Slack down) does not authorize send. It authorizes a retry of the *notification*, and an alert that the run is stuck pending. Fail closed.

## Non-Goals

- **Not a general workflow engine.** One run, one irreversible action, one approval request at a time. n8n, Temporal, or a custom orchestrator can *host* this state machine; they do not replace the approval ledger. Picking n8n vs custom is an ADR-level hosting choice, not the design. See [Architecture](./02_architecture_document.md) and [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- **Not the multi-agent platform (roadmap 2.5).** No supervisor of specialized agents, no message bus between researcher/reviewer agents. The "reviewer" here is a human. An LLM reviewer is a later, worse, different control and is out of scope.
- **Not cancellation-as-rollback.** Stop-during-send is [`prj--agent-pipeline-cancellation`](../prj--agent-pipeline-cancellation/). This project assumes send is gated so that cancel-vs-email races become rare. If send is in flight, that other design still applies; we do not re-derive it.
- **Not exactly-once across our app and the mail API.** At-least-once with idempotency keys is the ceiling.
- **Not an implementation.** No TypeScript orchestrator, no n8n JSON, no Slack Bolt app, no SendGrid client. Numbered steps and diagrams only.
- **Not a promise of fast outreach.** Human hours are the feature. If the SLA is "email within 30 seconds of the prompt," this architecture is the wrong product. Remove the irreversible tool or accept unsupervised send with a different (worse) risk profile.
- **Not a claim that humans are good at this.** Humans miss things, rubber-stamp, and approve on phones. Guardrails exist because of that. HITL is not a substitute for policy; it is an additional, slow, lossy control. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- **Not a claim that this is cheap.** The honest alternative — prompt the model not to send, or put a confirm in the UI — is cheaper to ship and will survive a demo. This design is justified when an unsupervised send is an incident (customer email, legal, press) *and* a human delay is acceptable. It is overkill for a draft-only assistant that never calls a mail API.
