# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone puts `send_email` on a LangChain tool list and a Slack "Approve" button next to it.

The trap, once: **a human in the loop is not a control unless the irreversible tool is unauthorized without a durable, hash-bound, authorized decision.** A Wait node, a system prompt, and a confirm modal are three ways to look like that control. None of them are it.

## 1. What I would build

A **draft-version-then-gate**, not a workflow canvas with a Wait.

- **Immutable `DraftVersion` rows** with a canonical content hash. The approver is shown those bytes. Send POSTs those bytes. Anything else is a different version.
- **Guardrails before the human**, fail closed, no override in v1. Deterministic rules first; optional model-assisted checks cannot skip the deterministic list.
- **An approval ledger** (`approval_requests` + `approval_decisions`) as the only issuer of send-capability. Authz: role-bound, not self. Expiry: deny. Unique effective decision.
- **LLM without the send tool.** Mail credentials not on the draft worker. The send adapter re-reads the decision and records a dispatch row *before* HTTP, keyed by run + version + attempt.
- **A notifier that is a projector.** Slack/email carries a link (and optionally a verified button that calls *our* API with the hash). Slack is not the system of record.
- **An expiry and unknown-send worker.** Pending age alerts. No "just resend."
- **An audit log** that can answer "who approved which hash" without a Slack export.

Waiting is a row with the work lease released. Anyone who implements HITL as `await fetch(slack)` has not implemented HITL; they have implemented a demo that cannot survive a deploy.

If Phase 0 finds that the product never calls a mail API — drafts stay in-app — this whole design is heavier than the problem. Build versioned drafts and stop. **Do not** invent an approval service for sport. The inventory of irreversible actions is the fork.

## 2. What I would give up

Be explicit. These are not "later." They are not in v1, and some of them are never in this design.

**Instant send.** The feature is delay. If the SLA is "email 30 seconds after the prompt," you cannot have this gate. Pick unsupervised send (and own the incidents) or a confirm by the *requester* that you do not market as a second pair of eyes.

**A single boolean `approved`.** That boolean is how v2 bytes ride on a v1 click. The designed artifact is a decision bound to a version id and a hash.

**The model as a tool-using sender.** Even "only if the user is staff." Injection does not care about job title.

**Timeout-send / "nudge then send anyway."** That option is not implemented as a flag. It is a different product.

**Self-approval as HITL.** A solo user can have a hashed confirm-before-send. They cannot have this project's ADR-007 story. Using one login for the demo and calling it two-person review is a lie in a portfolio.

**Edit-in-place on the approval screen (v1).** Typo fixes are a new version and a re-check. Later, a guarded "edit + re-check + approve" transaction is allowed. Silent textarea-to-SMTP is not.

**Automatic "please disregard" if they reject too late.** Too late is after send. Compensation is opt-in and usually wrong for email.

**Quorum (two of three).** Real for legal/comms. A different state machine. Fake quorum via two Slack reactions is worse than one named approver.

**A general BPM / n8n-as-the-architecture.** n8n can host. The ledger is the design. If the company already has Temporal, use it for timers and signals; still do not let Wait continue into Send.

**Exactly-once with the mail API.** Ceiling is at-least-once plus keys.

**Humans as a safety proof.** Reviewers rubber-stamp. Guardrails exist because of that. HITL is lossy, slow, and still worth it for *some* irreversible actions. It is not a replacement for policy, evals, or not giving the model a weapon.

**Stop-equals-rollback on send.** That is the sibling project. This gate makes that race rarer. It does not invent a time machine.

## 3. What I would ask for, even though I expect a no (or a fight)

Ask **once, in writing, at the start of Phase 0**. A no must not block the ledger. A yes changes who may approve, where drafts may appear, or whether send belongs on this agent at all.

Ask **product / GTM**:

1. **Is a human delay acceptable for every send this agent might do?** Expected: "yes except for these five transactional templates." Then those templates are not this agent, or they are a separate unsupervised path with a different risk owner. Do not mix them in one tool list.
2. **Who is an approver, and is self-approval forbidden?** Expected fight in a five-person startup. If they insist on self-approval, rename the feature to Confirm. Do not keep the HITL label.
3. **Allowlist vs denylist for recipient domains.** Expected: they want "email anyone." Then write down that blast radius. Engineering does not silently choose it.
4. **Cooldown / dedupe** if a second run targets the same person. Not part of the gate; still a product incident if missing.

Ask **legal / privacy / security**:

5. **May the full draft body live in Slack?** Expected: often no (PII, unpublished claims). Then notifications are link-only and the approval UI is ours.
6. **Retention of drafts vs audit vs CRM.** Do not cascade-delete the hash that authorized a send.
7. **Whether this is considered marketing email** (consent, CAN-SPAM, suppression lists). If yes, suppression is a *guardrail rule*, not a reviewer memory. Expected: someone says "the AE knows." That is not a control.

Ask **the mail vendor** (measure, don't vibe):

8. **Idempotency-Key support and lookup-by-key.** Same questions as the cancellation project. If neither exists, unknown is human-resolved and dual-writer is a dual-send.

Ask **support / ops**:

9. **Who owns the pending queue and the expiry alerts?** If nobody, expiry will surprise requesters and they will demand timeout-send. Staff it or do not offer the agent.

What I would **not** ask for: that the LLM will "just be careful," that Slack is SOC2 so it can be the ledger, that reviewers will always read the body. Those asks burn time and do not change the architecture.

## 4. Complexity, priced honestly

This is not a large distributed system. It is a small system with a *nasty* authorization-and-binding problem. The research+draft loop is a weekend. The code for immutable versions, hash bind, authz, expiry-deny, unique decisions, dispatch-first send, and not mounting mail creds on the model worker is the actual project. Most of the failure modes will not appear in a demo that only shows Sequence A.

| Approach | What you save | What you pay later |
| --- | --- | --- |
| System prompt + send tool | Weeks | Injection send, "I didn't approve" tickets, a postmortem that rediscovers this document |
| n8n Wait → Send, continue on timeout | A database | Weekend sends, then a "how did this go out?" that has no hash |
| Slack button without a ledger | UI work | No audit, retries double-send, body truncated and still "approved" |
| This design, skip guardrails because "human" | A checker | Rubber-stamp of PII and wrong domains |
| This design, skip dispatch keys | One table | Double-approve email |
| Full BPM platform + this design | If you already have the engine, timers | If you don't, a platform project that still needs ADR-001 |

The overkill line: **draft-only assistant, human copies out of the app, no mail API.** Then you need a decent draft UX, not this ledger. The moment the agent can send (or open a PR, or post to Slack as the brand), the gate is justified. Slack-post-as-the-brand is the same trap with a faster screenshot.

**n8n specifically:** it is a fine *host* for research nodes and for calling our adapter. It is a bad *source of truth*. Portfolio reviewers have seen a thousand n8n canvases. The interesting artifact is the ledger and the ADRs. Using n8n without the ledger is how this project fails to look like architecture.

## 5. How the answer changes for other irreversible actions

The architecture does not change. The **payload canonicalization, guardrail rules, and compensation** story do.

| Action | Irreversible? | What the hash must cover | Typical extra guardrail | Compensation exists? |
| --- | --- | --- | --- | --- |
| Send outreach email | Yes | from/to/subject/body | domain, marketing consent, injection in body | Almost never |
| Open GitHub PR | Yes (visible, but often closable) | repo, base, title, body, diff | repo allowlist, path allowlist, secret scan on diff | Close PR — a *new* call, opt-in; does not un-notify reviewers |
| Create Jira/ticket | Yes | project, type, body | project allowlist | Close/delete — opt-in |
| Post Slack as brand | Yes | channel, body, attachments | channel allowlist | Delete message if you stored `ts` — still opt-in |
| Charge card | Yes | amount, currency, customer, capture vs hold | amount caps, dual control | Refund/void — payments design, not a generic gate |
| Write to a sandbox you own | Often reversible | path + bytes | path jail | Delete the file — the exception |

PR-as-the-scenario is slightly kinder than email: you can close a PR. You cannot un-notify ten subscribers, and you cannot un-leak a secret in the diff. Hash the diff. Secret scan is a non-bypassable guardrail. Do not tell yourself "it's only a PR" as a reason to skip the ledger.

Card charge is where people will demand quorum and break-glass. Fine: that is a payments design. Do not generalize this project's email gate into "we have HITL so we can charge cards."

## 6. Brutal summary

Human-in-the-loop for an agentic send is an **authorization problem wearing a workflow feature's clothes.** The interesting artifacts are the immutable draft version, the content hash, the approval ledger the model cannot write, the non-bypassable guardrails, expiry-as-deny, and the dispatch key. The Slack button is a client of `POST /decisions`.

If you remember one sentence for the interview: **the human does not pause the agent; the send tool is simply not callable until a ledger row exists for these exact bytes, issued by an authorized identity, still unexpired — and a timeout is not a signature.**

If product wants Send to mean "the agent just handles it," they need to remove the mail API from the agent, or accept unsupervised send with a named risk owner. Architecture cannot invent a second pair of eyes because the canvas has a Wait node.
