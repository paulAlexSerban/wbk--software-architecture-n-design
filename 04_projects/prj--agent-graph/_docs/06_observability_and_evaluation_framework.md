# Multi-Agent Orchestration Platform — Observability and Evaluation Framework
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document exists because “the graph ran” and “the graph did not double-write, did not merge without a human, and was worth the tokens” are different claims. Framework traces of pretty node graphs are a demo. The centerpiece trap is a **duplicate side effect**. If you cannot query that, you are not operating this system.

Architecture: [Architecture](./02_architecture_document.md). Mechanics: [System Design](./03_system_design.md). Gates: [Phased Implementation Plan](./08_phased_implementation_plan.md).

## The Demo Trap

A demo, by construction:

- uses one happy-path issue,
- never kills a worker after `open_pull_request` returns,
- never redelivers a bus message,
- never waits 72 hours for HITL,
- counts “PRs opened” as success.

None of that is production. A graph that looks beautiful in LangSmith and opens two PRs under chaos is a **failing system with good UX on the happy path**.

This document’s job is to make the evidence match the failure modes in the [scenario](./01_scenario_and_requirements.md).

## Tracing Every LLM and Tool Call

**One trace per `run_id`.** Parent spans: supervisor routing, each `visit_id`, each LLM call, each tool call.

Required attributes on every span:

| Attribute | Why |
| --- | --- |
| `run_id` | Join to ledger |
| `visit_id` / `node_id` / `attempt` | |
| `tool` / `model` | |
| `idempotency_key` | Tool writes |
| `dispatch_status` | recorded / succeeded / unknown |
| `provider_id` | pr_number, ci_run_id |
| `untrusted_slice` | bool — was foreign-agent text in context |

**Invariant:** if a GitHub POST happened, a span and a dispatch row exist. A span without a row is a bug (adapter bypass). A row without a span is an observability hole (still better than the inverse).

Sampling: at this volume, keep 100% of traces until cost hurts. Do not sample away the one double-POST.

## Metrics That Matter vs. Vanity Metrics

| Vanity metric | Why it's misleading | Real metric |
| --- | --- | --- |
| Runs started / “agents invoked” | Says nothing about duplicates or merges | **Duplicate-dispatch rate**: count of write HTTP calls per `tool` per `run_id` that are not explained by a unique key hit (should be **0** for `open_pull_request` and `merge_pull_request`) |
| Nodes completed | Retry theater | **Catch-up vs. re-execute rate** after injected crashes |
| Token spend (alone) | Can look “productive” while looping | Tokens per **completed or DLQ** run; loop-depth histogram |
| HITL time-to-notify | Fast ping, wrong PR | **HITL bind mismatches** (409s); **duplicate notify** count |
| DLQ = 0 | Means you are retrying forever or not measuring | **DLQ rate by reason**; time-in-unknown |
| Model-reported “I opened the PR” | Not evidence | Ledger `pr_number` vs. GitHub list-by-branch (recon job) |

A platform that looks amazing on the left and non-zero on duplicate-dispatch is **not working**. The left column is not a fallback signal.

**The rubber-stamping failure mode (HITL):** humans approve because CI is green and the graph is confident. Track reviewer time and “approve without opening the diff.” That is a people metric; still a kill input if merge quality collapses. See [coding-agent-harness evaluation](../../prj--coding-agent-harness/_docs/06_evaluation_framework.md) for the same honesty about merge-without-rework — this graph *feeds* that harness-shaped outcome; it does not replace it.

## Evaluation Tiers

1. **Contract tests (no LLM):** adapter insert-then-call; unique key; lookup-by-branch; merge refuses without HITL; Coder allowlist rejects `merge_pull_request`.
2. **Chaos / fault injection:** kill worker after dispatch commit and after 201; bus redelivery; two supervisors; GitHub timeout. **This is the Phase 3 gate.** A score on a golden issue is not a substitute.
3. **Shadow graph:** run through Tester, **do not** open HITL to real humans; recon compares ledger to GitHub. Measure duplicate PRs on a real issue sample.
4. **Pilot HITL:** small willing cohort, one repo, merge on. Track duplicates (must stay 0), DLQ reasons, tokens, human time.
5. **Production monitoring:** the same metrics indefinitely. Model updates and prompt tweaks re-open the crash window if someone “simplifies” the adapter.

## Failure Taxonomy

Every DLQ or terminal-fail is categorized by **why**:

| Category | Example | Implication |
| --- | --- | --- |
| Duplicate write prevented | Unique key hit on resume | System working; still log as catch-up |
| Duplicate write **not** prevented | Two PRs | **Incident.** Kill retry path. Phase 3 failed in prod. |
| Unknown unresolved | GitHub timeout, no lookup | Vendor/inventory; do not retry |
| Loop cap | Reviewer never satisfied | Issue too hard or caps too low; not a reason to remove caps |
| HITL expired / rejected | Human out | Product, not a graph bug |
| Injection attempt | Instruction-like issue/review | Security review; capability must have held |
| Routing bug | Merge without row | Security incident |

Aggregate “success rate” that treats DLQ-on-cap as the same as duplicate-PR is how you optimize toward lying.

## Kill Criteria for the Whole Program

Stated in advance:

- **Any confirmed duplicate `open_pull_request` or `merge_pull_request` for the same `run_id`** that is not a documented new-run Re-run — pause writes, feature-flag Coder writes off, leave Planner if you must demo.
- **Any merge without a matching HITL row** — immediate pause of Merge Executor.
- **Unknown ignored** (auto-failed and retried with a new key) — treat as sev; revert.
- **Token cost per useful PR** (merged or human-taken draft) exceeds the alternative of a human doing the first draft, sustained past pilot calibration — legitimate shutdown, not just “tune the prompt.”
- **HITL cohort trust collapse** (people ignore the graph or rubber-stamp) — pause expansion.

None of these are “tune and continue by default.”

## Minimum Alerts

- Duplicate provider ids for the same tool on one `run_id`.
- Dispatch insert failures (fail-closed; users will see failed runs).
- Open `unknown` older than SLA.
- Merge executor invoked without approval row (page).
- Lease steal / lock failures.
- Review loop or test loop hitting max (info; DLQ).
- Denied allowlist tool call (security signal).

If these are missing, on-call will search GitHub by timestamp and “open another PR to be sure.” That sentence is the incident.
