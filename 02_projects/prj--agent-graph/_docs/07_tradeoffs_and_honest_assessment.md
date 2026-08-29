# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone wires four FastAPI agents to a Redis stream and calls it a platform.

The trap, once: **a multi-agent graph is a distributed workflow engine wearing an LLM costume.** Planner tokens, a GitHub POST, a CI dispatch, a Slack ping, and a human approval are independent conversations. Resume is a sixth. They do not share a rollback log. The graph that “just resumes” in a demo is a graph that has never lost a race with `open_pull_request`.

## 1. What I would build

A **durable graph with a shared dispatch ledger**, not an in-process LangGraph demo.

- **Run + node visits + a lease**, written before any vendor call. One walker. A second supervisor cannot “help.”
- **Dispatch-first tool adapters, shared across agents.** Insert `tool_dispatches` with a key **then** call GitHub/CI/Slack. Crash in the gap retries the *same* key or looks up by `agent/{run_id}` branch. It never mints a new key to “be safe.” `open_pull_request` is unique per run even across visits.
- **Tool-progress committed before the next LLM turn** ([ADR-003](./04_architecture_decision_records.md#adr-003)). Node-boundary checkpointing is the bug.
- **Bounded Reviewer↔Coder and Tester↔Coder loops**, then a business DLQ with the PR link. Infinite “the supervisor will figure it out” is a bill, not a design.
- **HITL as a row bound to PR+SHA**, not stdin, not a second Slack message on restart. Merge Executor is the only merger.
- **Isolated context slices and per-agent allowlists.** Reviewer text is data. Coder cannot merge.
- **Traces that carry `idempotency_key`.** Duplicate-dispatch rate is the SLO.

The bus is a projector of work. The database is the system. Anyone who implements retry only as “re-run the node function” has not implemented retry.

If Phase 0 finds that every tool is a read (research agents, no GitHub writes), this whole design is heavier than the problem. Build a subset (visits + caps + traces) and **do not** invent merge-executor machinery for sport. The inventory is the fork.

## 2. What I would give up

Be explicit. These are not “later.” They are not in v1, and some of them are never in this design.

**Exactly-once across our app, GitHub, CI, and Slack.** Ceiling is at-least-once with keys and lookup. Anyone quoting exactly-once in the design review has not called `POST /pulls`.

**Undo / saga close-the-PR-on-failure.** Closing a PR a human is reading is a second incident. Default is no automatic compensation. See the cancellation sibling’s [ADR-005](../../prj--agent-pipeline-cancellation/_docs/04_architecture_decision_records.md#adr-005) — same ethic, different tool.

**A peer agent mesh / A2A product.** Supervisor-mediated only. Peer gossip skips loop counters and the ledger.

**Shared full transcript.** Token suicide and injection. Isolated slices.

**Reviewer-agent merge.** Cool demo, indefensible ops.

**Instant HITL.** Hours to days. If product wants auto-merge on green CI, that is a different (worse) threat model; it is not a flag you flip on this Merge Executor without a written accept of “the graph can land code.”

**Resuming a Coder visit by asking the model what it did.** Models forget. The ledger remembers.

**Parallel write tools inside Coder in v1.** They multiply in-flight unknown. Sequential tools are how you keep drain/recon understandable.

**Trusting LangGraph / n8n / Temporal as a substitute for the ledger.** They are timers, DSLs, and UIs. The crash window is still there unless *your* adapter commits first. n8n/CI experience translates as: the pipeline JSON is not the run audit log.

**Free retries as an architecture invariant.** Every extra Coder visit is tokens + maybe CI. Caps exist because of money and because loop 4 is where uniqueness bugs hide.

**A platform that onboards arbitrary agent types on Friday.** One graph shape. Adding a “Deployer” agent is a new Phase 0 inventory and a new irreversible tool class.

## 3. What I would ask for, even though I expect a no (or a fight)

Ask **once, in writing, at the start of Phase 0**. A no must not block the ledger. A yes changes whether write tools belong on a retryable graph at all.

Ask the **vendors** (read the docs; measure):

1. **GitHub:** create-PR idempotency, list-PR-by-head-branch, merge idempotency, required checks. Expected: lookup-by-head works; `Idempotency-Key` on POST /pulls does not. Branch naming is then mandatory.
2. **CI:** workflow_dispatch idempotency, list in-progress by SHA. Expected: maybe list, maybe not. If not, Tester retries are dangerous.
3. **Slack:** update-in-place vs. new message. Expected: yes if you stored `ts`.

Ask **product / eng leadership**:

4. **Is merge allowed without HITL for “tiny” issues?** Expected: they will ask. Default in this design: no. If they insist, it is a new ADR and a kill-criteria change, not a config default.
5. **Re-run vs. resume.** Re-run = new `run_id` = new PR possible. If that is unacceptable, the UI must not look like a generic Retry.
6. **Loop caps.** 3 and 2 will feel low on hard issues. Raising them is a cost and incident-surface decision.

Ask **agent-ops**:

7. **SLA for `unknown`.** 15 minutes paged? If they will not staff it, do not offer write tools on a retryable graph — run Planner-only.

Ask **security**:

8. **Two GitHub tokens (writer vs merger)** vs. one App. Expected: one App “to keep it simple.” Then Merge Executor still must never share its token with Coder. Process isolation is the consolation prize.

What I would **not** ask for: that GitHub join our distributed transaction, that the model be perfectly honest about past tool calls, that humans “just not retry.” Those asks burn time and do not change the race.

## 4. Complexity, priced honestly

This is not a large distributed system. It is a **medium** system with a nasty consistency problem *and* four LLM entry points. The code for the happy-path graph is a weekend. The code for dispatch-first, leases, unknown, HITL bind, DLQ, and chaos tests is the actual project. Most of the failure modes will not appear in a local demo unless you test them on purpose (Phase 3 gates).

| Approach | What you save | What you pay later |
| --- | --- | --- |
| In-process LangGraph, checkpoint after node, no keys | Weeks | Duplicate PRs, double CI, HITL on the wrong SHA, a postmortem that rediscovers this document |
| This design, but skip unknown/recon | A worker and a support view | The one crash window you shipped |
| This design, plus a saga that auto-closes “duplicate” PRs | Nothing in v1 | Closing the real PR |
| Temporal/LangGraph **plus** this ledger | If you already have the engine, timers | If you don’t, a platform project that still needs ADR-002 |
| Four FastAPI agents on day one | “microservices on the résumé” | Four deploys before the ledger exists. **Do not.** Phase 1 is one Coder. |

The overkill line: **read-only research graph, no writes, Stop means stop streaming.** Then you need traces and caps, not GitHub uniqueness. The moment `open_pull_request` (or Slack, or Jira, or `gh release`) is a tool, the dispatch ledger is justified. Slack-post is the same trap with a funnier screenshot. Merge without HITL is how the screenshot becomes a production incident.

**Honest comparison to “just use a workflow engine”:**

Temporal, Cadence, Step Functions, n8n, LangGraph checkpointers all give you: retries, timers, some visibility. None of them make GitHub and Postgres commit atomically. If you already operate Temporal, use it for the supervisor loop **and still** wrap every write in dispatch-first activities that ignore naive activity retry. If you do not already operate Temporal, **do not** start this project by adopting Temporal. You will spend the quarter on the engine and still miss Case B.

LangGraph is a fine **DSL** for the routing table in one process in Phase 1. It becomes a liability when people believe `MemorySaver` is the outbox.

## 5. How the answer changes for other graphs

The architecture does not change. The **uniqueness and HITL placement** story does.

| Graph | Irreversible writes | HITL before | Typical trap |
| --- | --- | --- | --- |
| This (issue → PR) | PR, CI, merge | Merge | Duplicate PR |
| Research + cite | Maybe none | Optional | Skip the ledger; keep caps |
| Customer-email agent swarm | Send email | Before send, or accept the cancellation-project semantics | Duplicate email (see sibling project) |
| Deploy-to-prod agents | Deploy | Always | Duplicate deploy; worse than two PRs |
| Unlimited “agent OS” | Unknown | You have already lost | You will not inventory tools |

Card charge / prod deploy is where people will demand a saga. Fine: that is a payments or release design, not a generic multi-agent framework. Do not generalize this project’s `open_pull_request` into “we undo tools.”

## 6. Brutal summary

Multi-agent orchestration is an **accounting problem wearing a research-demo’s clothes.** The interesting artifacts are the visit ledger, the dispatch row written *before* the side effect, the per-run uniqueness of `open_pull_request`, the HITL bind, and the DLQ. The Supervisor is a writer of those rows. The agents are untrusted functions with small allowlists.

If you remember one sentence for the interview: **you cannot un-open a pull request, so you must not design retry as re-entering a node — you design it as replay of a ledger, you record the write before you perform it, and you treat in-flight writes as unknown until the provider says otherwise.**

If product wants “just retry the graph” to mean “nothing extra happened,” they need to remove write tools from the graph, or put a human confirm *in front* of each write so retry is unlikely to lose the race. Architecture cannot invent a time machine because the README says multi-agent.
