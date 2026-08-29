# Multi-Agent Orchestration Platform — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not a multi-agent demo.** Building retry against an uninventoried GitHub/CI/Slack list is how you ship a graph that sometimes opens two PRs. Phase 5 is ongoing operations, not a calendar day.

Rollback/kill criteria at the bottom apply at every phase. In particular: **never ship a Retry control that can mint a new idempotency key for `open_pull_request` or `merge_pull_request` on the same `run_id`.**

Calendar assumptions: one small team, sequential phases. A single Coder with a ledger (Phase 1+3 overlap allowed only as: Phase 1 without write tools, then Phase 3 before enabling PR create). **Do not enable `open_pull_request` until Phase 3’s chaos gate is green.** Do not add Reviewer/Tester until Phase 1’s restart test is green. Do not enable merge until Phase 4.

## Phase 0 — Inventory Side Effects and Vendor Contracts (Days 1–3)

**Objective**: Classify every tool the graph is allowed to call, and write down what the vendor actually guarantees. Guessing that “GitHub is idempotent” is how PR #413 is born.

**Deliverables**:
- A table, one row per tool (`create_branch`, `commit_and_push`, `open_pull_request`, `post_review_comment`, `trigger_ci_run`, `merge_pull_request`, `notify_slack`, plus reads): side-effect class, idempotency header support, lookup-by-key or by natural id (head branch, SHA), documented timeout behavior, whether a 5xx might still have applied, typical latency.
- Evidence, not vibes: redacted successful responses; a timeout test; a **double POST with the same key/branch** (did GitHub create two PRs?); double POST with different titles (baseline double-PR).
- LLM provider notes: retry/429 behavior; whether abort bills tokens. Record a sample.
- Product questions in writing: HITL required before merge? Re-run vs resume copy? Support SLA for `unknown`? Two GitHub tokens? See [Trade-offs §3](./07_tradeoffs_and_honest_assessment.md#3-what-i-would-ask-for-even-though-i-expect-a-no-or-a-fight).
- Feasibility call: if create-PR has neither idempotency nor list-by-head, either (a) keep writes off the retryable graph, (b) accept human recon as the design, or (c) derive a guaranteed-unique branch and treat “get or create” as the API. Write down which. **(c) is the expected path for GitHub.**

**Exit Gate**:
- [ ] Inventory table exists with evidence links for GitHub, CI, Slack, LLM.
- [ ] Written choice for create-PR uniqueness (branch `agent/{run_id}` + lookup).
- [ ] Asks to product/security/ops have been sent. Replies are not required to start Phase 1, but **write tools stay off** until Phase 3.
- [ ] Kill/proceed: proceed to Phase 1 regardless; proceed to *enabling* writes only under Phase 3’s gate.

## Phase 1 — Single-Agent Coder, Durable Visits, Lease, No Writes (Days 4–8)

**Objective**: Make resume real for one node with **read-only** tools (or writes hard-disabled). Prove the visit table, lease, and bus redelivery without the PR race.

**Deliverables**:
- `runs` + `node_visits` as in [System Design §1](./03_system_design.md#1-data-model). Run created before any LLM call.
- Supervisor loop with lease + routing stub (Planner optional: can be a fixed plan fixture).
- One Coder worker: reads only (`read_file`, `grep_code`). No `open_pull_request` in the build — absent, not disabled-in-prompt.
- Bus envelope + redelivery no-op if visit not pending.
- Minimum traces: `run_id`, `visit_id`, LLM spans.

**Exit Gate**:
- [ ] Kill Coder after visit `running`, restart: worker **does not** start a second visit; catch-up or resume the same `visit_id`.
- [ ] Duplicate envelope: no second LLM burst that the test cannot account for (or at most one in-flight; second acks).
- [ ] Two supervisors: one lease winner.
- [ ] `open_pull_request` still absent.

Do not start Phase 2 until the restart test is green. That test is the point of a durable visit. Adding more agents first only multiplies a broken walker.

## Phase 2 — Reviewer + Tester Loops, Caps, Business DLQ (Days 9–12)

**Objective**: Multi-agent routing without write-tool fan-out. Reviewer and Tester may use **read** tools and *fake* verdicts/CI in tests. Real `post_review_comment` / `trigger_ci_run` wait for Phase 3.

**Deliverables**:
- Routing table: Coder (fixture result) → Reviewer → Coder until cap → DLQ; Tester fail → Coder until cap → DLQ; pass → `awaiting_hitl` **without** merge.
- `MAX_REVIEW_LOOPS` / `MAX_TEST_RETRIES` enforced in supervisor, not in prompts.
- Isolated context slices ([ADR-006](./04_architecture_decision_records.md#adr-006)); untrusted labels.
- `dlq_entries` with reason.
- Allowlists per worker even if write tools are stubs.

**Exit Gate**:
- [ ] Reviewer `request_changes` three times → DLQ, no fourth Coder visit.
- [ ] Tester fail twice → DLQ.
- [ ] Isolated slice test: Coder context does not contain Reviewer’s raw tool log.
- [ ] Allowlist: Coder cannot invoke merge stub.
- [ ] Real GitHub writes still off.

## Phase 3 — Dispatch Ledger, Idempotency, Chaos (the trap) (Days 13–18)

**Objective**: Put write tools on the path without inventing rollback. The gate is crash-after-dispatch, not a pretty adapter interface.

**Deliverables**:
- Tool adapter: classify, insert dispatch, call, record outcome ([System Design §6](./03_system_design.md#6-side-effecting-tool-execution-load-bearing)).
- Unique `idempotency_key`; GitHub lookup-by-head-branch; per-run uniqueness for `open_pull_request`.
- `unknown` on timeout; recon lookup; **no new key**.
- `post_review_comment`, `trigger_ci_run`, `notify_slack` with the same pattern (can be fakes in CI + one staging repo).
- Chaos: kill after `recorded` commit; kill after 201 before `visit=succeeded`; bus redelivery during in-flight POST; delayed 201 after unknown.

**Exit Gate**:
- [ ] Crash after 201: **exactly one** PR on the staging repo; ledger shows `pr_number`; graph continues to Reviewer with 412 not 413.
- [ ] Crash after `recorded`, before HTTP: at most one POST; same key; not a new title.
- [ ] Timeout forever: `unknown`; Reviewer/HITL **not** started as if PR existed.
- [ ] Late 201 after unknown: no second POST; dispatch resolved; no second terminal “completed.”
- [ ] User Re-run: new `run_id`, *may* open a second PR — asserted, and the UI copy is reviewed.
- [ ] Lease contention: two Coders, one PR.
- [ ] If real GitHub failed the Phase 0 double-POST-same-branch test, written ops procedure + product acknowledgement. Shipping anyway without that is a kill criterion.

If this gate is not green, **do not** proceed to HITL merge. A graph that duplicates PRs must not be allowed to merge *either* of them automatically.

## Phase 4 — HITL Gate and Merge (Days 19–22)

**Entry Gate**: Phase 3 green.

**Objective**: Durable approval bound to PR+SHA. Merge Executor only.

**Deliverables**:
- `hitl_approvals` row; notify with `notify_ref`; restart updates in place ([System Design §8](./03_system_design.md#8-hitl-mechanics)).
- Timeout → DLQ, no merge.
- Merge Executor: dispatch-first merge; 409 already-merged = success; SHA mismatch = refuse.
- Separate merger token if Phase 0 allowed ([Security](./05_security_and_guardrails.md#identity-and-access)).
- Tests: approve twice; approve wrong PR; expire; worker die during wait.

**Exit Gate**:
- [ ] Restart during HITL: no second Slack (or second message cannot merge — row still unique).
- [ ] Approve without row: Merge Executor refuses; alert fires in test.
- [ ] Mismatched SHA: no merge.
- [ ] Coder still cannot merge (token or allowlist test against protected branch).

## Phase 5 — Observability, Recon, Kill Criteria (ongoing)

**Objective**: Close remaining crash windows without “retry the PR to be sure.”

**Entry Gate**: Phase 3 green. Phase 4 may still be in flight (unknown has operational cost even before merge is on).

**Deliverables**:
- Worker: expired leases, `unknown` / `awaiting_provider` older than TTL.
- Lookup by branch / SHA against GitHub; else support ticket template with `idempotency_key`, `run_id`, branch.
- Metrics and alerts from [Observability](./06_observability_and_evaluation_framework.md).
- Runbook line: **do not resend from the dashboard.** Resolution is succeeded/failed, not “click open PR.”
- Duplicate-dispatch dashboard at ~0.

**Exit Gate** (re-checked):
- [ ] Chaos on staging inbox/repo: at most one PR, one merge.
- [ ] Unknown older than SLA pages a human, not a retry bot.
- [ ] The “just retry the node” button does not exist. If someone added it, delete it.

This phase has no calendar end. If unknown is common in steady state, wait/lookup is wrong or the vendor is flaky — tune, do not guess outcomes.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop and escalate — do not keep Retry green — if any of the following hold:

1. **Two PRs (or two merges) for one `run_id`** that is not a documented new run. Feature-flag writes off. Keep Planner if needed.
2. **A retry issued a new idempotency key** for the same user-visible write. Kill the retry path.
3. **Merge without HITL row.** Disable Merge Executor.
4. **Unknown assumed failed and retried.** Sev. Revert.
5. **Automatic close of “duplicate” PRs** added to “handle” Case B. Disable. Product conversation, not a hotfix.
6. **Pressure to skip Phase 0** because a demo is Friday. Demo Planner+read-only Coder only. Do not demo Stop/Retry+open-PR until Phase 3 is green.
7. **Four microservices before the ledger exists.** Rollback to one Coder process. Isolation is Phase 2+; the ledger is Phase 3.

Rollback is always to the last phase whose exit gate was honestly green, with write tools flagged off if Phase 3 was the failure. After a kill, users still get a graph that plans. They do not get a confident “we resumed safely” you could not defend.

## Suggested Test Matrix (bind to gates)

| # | Scenario | Phase gate | Expected | GitHub write POSTs (`open_pull_request`) |
| --- | --- | --- | --- | --- |
| T1 | Kill worker mid-read-only Coder | 1 | Same visit resumes | 0 |
| T2 | Duplicate envelope | 1 | One visit | 0 |
| T3 | Two supervisors | 1 | One lease | 0 |
| T4 | Review loop cap | 2 | DLQ `max_review_loops` | 0 (writes still off) |
| T5 | Coder crash after PR 201, before visit success | 3 | Catch-up, one PR | 1 |
| T6 | Crash after dispatch recorded, before HTTP | 3 | One POST, same key | 1 |
| T7 | Timeout on create PR | 3 | `unknown`, no Reviewer | 1 (or 0 if never left) |
| T8 | Late 201 after unknown | 3+5 | No second POST | 1 |
| T9 | Bus redelivery during in-flight create | 3 | One PR | 1 |
| T10 | Re-run (new run_id) after T5 | 3 | New PR allowed | +1 new key |
| T11 | HITL restart | 4 | One approval row | — |
| T12 | Merge without HITL | 4 | Refused | 0 merges |
| T13 | Approve wrong SHA | 4 | 409, no merge | 0 merges |
| T14 | Max loops with writes on | 3+2 | DLQ, still one PR | 1 |

T5, T6, T8, T9 are the tests that decide whether the team understood the scenario. If they are missing, the rest is theater.
