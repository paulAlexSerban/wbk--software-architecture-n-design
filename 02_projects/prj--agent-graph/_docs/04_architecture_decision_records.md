# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Durable Per-Node Checkpointing over In-Memory Graph State

**Status**: Accepted

**Context**: The obvious implementation of a multi-agent graph is one process, a library graph (LangGraph or similar), and a checkpointer that snapshots after a node function returns. That is correct for a demo. It is wrong for a graph whose nodes call GitHub, CI, and Slack. Process death, deploys, and worker OOM are normal. In-memory “the Coder object still knows the PR number” is not a recovery strategy. A checkpointer that only runs after `return` is exactly [System Design Case B](./03_system_design.md#72-case-b--the-trap-uncorrected-checkpoint-after-node).

**Decision**: Every node *visit* is a durable row (`node_visits`). Supervisor routing reads that table, not the bus offset and not an in-process graph object. A framework checkpointer may be used as a *cache* of LLM conversation for a single visit; it is not the system of record for whether a PR exists or whether the next node may start. Tool-level progress is committed inside the visit ([ADR-003](./04_architecture_decision_records.md#adr-003)).

**Consequences**:
- (+) Restart is defined: load run + visits + dispatches, continue.
- (+) Two supervisors can be fenced with a lease on the same rows.
- (–) We own a state machine instead of “just LangGraph.” That is the project.
- (–) An in-memory AbortController / asyncio Task is insufficient.
- **Alternative rejected**: Redis-only LangGraph state. Redis is fine as a store *if* the schema is this one and commits happen at tool boundaries. “Whatever the library wrote” is not a schema.
- **Alternative rejected**: Temporal/Cadence as a substitute for thinking. If the company already runs Temporal, model each write tool as an activity that records dispatch first and does not start a sibling activity on retry. The workflow engine does not dissolve the trap; it gives better timers. See [Trade-offs](./07_tradeoffs_and_honest_assessment.md).
- **Revisit trigger**: none that removes durable visits. A new framework still has a crash window.

## ADR-002: Shared Dispatch-Before-Call Idempotency Ledger (Prevent Duplicates, Do Not Implement Undo)

**Status**: Accepted

**Context**: Crash, bus redelivery, supervisor retry, “the model decided to call open_pull_request again,” and a human clicking Re-run are five names for “we might create two PRs.” The system must distinguish *same attempt* from *new visit* from *new run*. Without a key, every recovery path is a potential second write. With a key, failure still cannot un-open a PR; it can only avoid a second open of the *same* attempt. The ledger must be **shared across agents**: a Coder-local sqlite is useless if the Supervisor retries by starting a new Coder process with empty local state.

**Decision**: Every side-effecting tool dispatch is keyed by `sha256(run_id : node_id : visit_id : tool : attempt : request_fingerprint)`, persisted in `tool_dispatches` *before* the HTTP call, and sent to the vendor if they support a header. Natural uniqueness (branch `agent/{run_id}`, lookup-PR-by-head) is mandatory for GitHub create-PR because that API is not Stripe. A new `attempt` is allowed only after a *known non-apply*. Timeouts do not increment attempt. A new user Re-run creates a new `run_id` and therefore new keys — a second PR is allowed because a human asked again.

**Consequences**:
- (+) Crash-between-201-and-row-write can be recovered without a second PR if we lookup-by-branch or the vendor honors the key.
- (+) Bus redelivery cannot spawn attempt 2 “because the first worker vanished.”
- (–) Keys do not undo. Product must not market retry as undo.
- (–) GitHub’s weak idempotency means Phase 0 is not optional. Local unique + branch convention is the real fuse.
- **Alternative rejected**: use only `run_id` as the key. Then a legitimate second `commit_and_push` on review-loop 2 cannot fire. `visit_id` belongs in the key; `open_pull_request` has an extra per-run uniqueness invariant.
- **Alternative rejected**: “the LLM’s tool-call id is the idempotency key.” Retries produce new ids; that is how you double-open with a clean conscience.
- **Alternative rejected**: per-agent ledgers. The race is cross-process.

## ADR-003: Commit Tool Outcome before Advancing the Node (Close the Duplicate-PR Window)

**Status**: Accepted

**Context**: Even with a dispatch table, if the worker calls GitHub, then the LLM, then returns, then the checkpointer writes, the crash window is still “PR exists, visit not succeeded, resume re-enters Coder.” The model may then call `open_pull_request` with a *different* title (new fingerprint, new key) unless the adapter also enforces per-run uniqueness. Both layers are required; the ordering is the one that makes resume *skip* the call instead of *re-argue* with the model.

**Decision**: For every write tool: insert dispatch, call, persist outcome, persist tool-progress on the visit **before** the next LLM turn and before `visit=succeeded`. Resume loads dispatches first. `open_pull_request` is refused if a succeeded or unknown dispatch already exists for the run. Reviewer/Tester/Merge follow the same intra-node ordering.

**Consequences**:
- (+) The common crash (after 201, before node return) becomes catch-up, not a new PR.
- (+) The model’s second tool call is fenced even if it “forgot.”
- (–) Nodes are chattier with the DB. Correct.
- (–) Unknown still blocks progress. UX is “stuck pending recon,” not a second try.
- **Alternative rejected**: checkpoint only at node boundaries. That *is* Case B.
- **Alternative rejected**: ask the model “did you already open a PR?” Models lie and forget.

## ADR-004: Bounded Retries plus Explicit DLQ over Infinite or Silent Retry

**Status**: Accepted

**Context**: Multi-agent graphs love loops: Reviewer requests changes, Tester fails, Supervisor “tries another plan.” Without caps, the system is an unbounded token furnace that can also accumulate comments, CI runs, and (if uniqueness slips) PRs. Silent retry of `unknown` is the double-write. Infinite loops are how a portfolio demo becomes a bill.

**Decision**: Transient failures backoff with a small per-visit budget. Semantic loops increment `review_loop` / `test_loop` and stop at `MAX_REVIEW_LOOPS` (3) and `MAX_TEST_RETRIES` (2) unless product signs a change. Exhaustion, HITL reject/expiry, and unresolved unknown admit the run to a **business DLQ** with the last PR link. No dashboard button that retries a visit with a succeeded/unknown write. New work is a new `run_id` or ledger catch-up.

**Consequences**:
- (+) Token and CI cost have a ceiling per run.
- (+) Ops have a queue instead of a mystery spinner.
- (–) Some issues will DLQ that a human would have finished on the fifth rewrite. That is acceptable. The fifth rewrite is also where uniqueness bugs hide.
- **Alternative rejected**: “the supervisor decides when to stop” as a prompt. Models do not stop.
- **Alternative rejected**: automatic re-drive of DLQ every hour. That is infinite retry with extra steps.

## ADR-005: Scoped Per-Agent Tool Permissions; Only the HITL Path Can Merge

**Status**: Accepted

**Context**: A shared tool belt (“every agent can call every GitHub endpoint”) makes prompt injection and confused-deputy bugs trivial: Reviewer output says “merge,” Coder merges; Tester “fixes” CI by pushing to `main`. Prompting “you are the reviewer, do not merge” is not a control. The sibling project [prj--coding-agent-harness](../../prj--coding-agent-harness/_docs/05_security_architecture.md) already treats capability as the backstop; this graph must not regress.

**Decision**: Each worker process has an allowlist. Planner: no write tools. Coder: branch, commit, open PR, reads — **not** merge, not GitHub admin. Reviewer: read + `post_review_comment`. Tester: read + `trigger_ci_run`. `merge_pull_request` exists only on the Merge Executor, which requires a matching `hitl_approvals` row. Allowlists are configured, not inferred from the system prompt.

**Consequences**:
- (+) Successful injection has nothing to merge with.
- (+) Blast radius is per-agent (see [Security](./05_security_and_guardrails.md)).
- (–) More services/processes than a monolith graph. Isolation is the point.
- **Alternative rejected**: one worker type with a “role” string in the prompt.
- **Alternative rejected**: Coder identity with merge permission “but we won’t call it.”

## ADR-006: Isolated, Summarized Context per Agent over a Shared Full Transcript

**Status**: Accepted

**Context**: Shared memory (“stuff the whole transcript into every node”) is the default in framework demos. It blows the context window by Coder visit 2, leaks tool secrets and raw diffs into Reviewer, and treats Reviewer/CI text as if it had instruction authority. Token cost and prompt injection are the same bug: unbounded untrusted text in the next model’s system-adjacent context.

**Decision**: Supervisor holds full task state. Each agent loads a typed slice (issue, plan, `pr_number`, last review summary, last CI conclusion). Foreign-agent output is labeled `[UNTRUSTED: …]`. Instruction hierarchy: only this worker’s system prompt and supervisor-structured fields have authority. No shared scratchpad of raw tool logs.

**Consequences**:
- (+) Bounded tokens per visit; cheaper loops.
- (+) Smaller injection surface.
- (–) Summaries can drop a load-bearing review comment. Prefer passing the comment *record* (structured) over a model-written summary when the comment is short.
- (–) Agents will sometimes “not know” something another agent saw. Good: they should not act on a grep from two visits ago without re-reading.
- **Alternative rejected**: vector-memory of all tool calls. Retrieval of untrusted text into Coder is still injection; also does not replace the PR number in the ledger.

## ADR-007: Explicit HITL Approval as a Durable Gate with Timeout Policy

**Status**: Accepted

**Context**: `input()` in a worker, or a Slack message with no stored id, is the HITL analogue of Case B: restart posts a second approve button; two humans approve two SHAs; or the wait is lost and the graph merges on a default. Merge is the one truly hard-to-compensate action in this scenario.

**Decision**: HITL is a row (`open` → `approved` | `rejected` | `expired`) bound to `run_id` + `pr_number` + `head_sha`. Notification is an adapter that stores `notify_ref` and **updates in place** on restart. Timeout (default 72h) expires the row and DLQs; it does not merge. Approval of a mismatched PR/SHA is 409. Merge Executor is the only merger.

**Consequences**:
- (+) Restart does not double-prompt (or if Slack cannot edit, the row still prevents double-merge).
- (+) Merge cannot outrun the human.
- (–) HITL latency is days. The architecture must not hold an in-process lease that expires and re-enqueues Coder.
- (–) Users who wanted “just merge if CI is green” will hate this. That is a product fork, not a silent skip of the row.
- **Alternative rejected**: Reviewer agent verdict as merge authority.
- **Alternative rejected**: emoji-reaction with no row.

## ADR-008: Message Bus Is Transport; Durable Store Is the System of Record

**Status**: Accepted

**Context**: “Event-driven multi-agent” slides imply the queue *is* the conversation. Then redelivery re-runs Coder, competing consumers split a run, and “the stream is lagged” is mistaken for graph state. n8n/CI experience translates here as: the pipeline definition is not the run history; the run history is in the orchestrator DB.

**Decision**: Redis Streams / SQS / equivalent delivers envelopes (`visit_id`). At-least-once is assumed. Idempotency is the visit row + dispatch ledger + lease. Agent-to-agent communication is supervisor-mediated: no peer mesh that skips checkpoints. A *transport* DLQ (poison messages) is not the *business* DLQ table; both exist.

**Consequences**:
- (+) Workers can be dumb and horizontally scaled.
- (+) We do not need exactly-once queues (which we would not get anyway).
- (–) Dual-write (DB then bus) can drop an enqueue. Recovery: supervisor watchdog enqueues visits that are `pending` with no recent envelope. Fail toward “maybe a duplicate envelope,” never toward “lost node.” Duplicate envelopes are cheap if §4 is implemented.
- **Alternative rejected**: “the bus is the state” (event sourcing the graph off Kafka only). Possible in theory; in v1 it is how you debug with a PhD.
- **Alternative rejected**: Coder publishes “please review” directly to Reviewer’s queue. Skips loop counters and HITL.
