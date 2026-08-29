# Coding Agent Harness — Phased Implementation Plan

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. Phases 0–3 are sequential and non-negotiable in order — in particular, **no phase that touches the real repository begins before the phase before it has proven the harness stops itself correctly under injected faults**. Phases 4–5 are conditional and may never trigger. Rollback/kill criteria from the [Evaluation Framework](./06_evaluation_framework.md#kill-criteria-for-the-whole-program) apply at every phase, not just at the end.

## Phase 0 — Foundations

**Objective**: Prove the security and evaluation *infrastructure* works before any run is judged on task quality — a harness that produces great diffs but leaks a secret or has no real evaluation plan is not a partial success, it's a failure with good marketing.

**Deliverables**:
- Ephemeral sandbox provisioning/teardown pipeline, with default-deny network egress and the narrow allowlist ([Security Architecture](./05_security_architecture.md#network-exposure)).
- GitHub App created and installed with exactly the scopes in [Security Architecture — Identity and Access Management](./05_security_architecture.md#identity-and-access-management) — no more.
- Branch protection on the target repository configured and independently tested to confirm the App identity cannot merge or push to protected branches.
- Audit logging pipeline live, capturing tool calls, model turns, and sandbox network events, durable independent of sandbox lifecycle.
- Holdout-sampling protocol for evaluation ([Evaluation Framework — Statistical Rigor](./06_evaluation_framework.md#statistical-rigor)) drafted and reviewed by someone other than the person building the harness.
- Repository configuration schema defined: allowlisted `run_command` entries, hard-blocked path globs, step/wall-clock/token budget defaults.

**Exit Gate**:
- [ ] A test run attempting network egress to a non-allowlisted host is denied and logged as a security event.
- [ ] A test attempt to push/merge using the App's credentials against a protected branch is rejected by GitHub itself, not just by application logic.
- [ ] The audit log for a synthetic run contains every tool call and model turn, retrievable after the sandbox is destroyed.
- [ ] The holdout-sampling protocol has been reviewed and signed off by a second person.

## Phase 1 — Read-Only Triage Agent

**Objective**: Validate that the model can understand real issues in this specific mid-sized repository and correctly scope them — with **zero ability to write anything**, so any failure here is purely a "does it understand the problem" failure, not confounded by editing/testing mechanics.

**Deliverables** (implements only `Triage`/`Plan`/`Explore` from the [control loop](./03_system_design.md#1-control-loop); no `Edit`, `Validate`, or PR-creation states exist yet):
- `fetch_issue`, `read_file`, `list_directory`, `grep_code` tools implemented and schema-validated; `apply_patch`, `run_command`, `run_tests`, `open_draft_pull_request` do not exist in this phase's build at all — not just disabled, absent, so there is nothing to misconfigure.
- The agent produces a structured feasibility report per issue (in-scope estimate, files it believes are relevant, open questions) posted as an internal artifact, not a public comment.
- [Context window management](./03_system_design.md#3-context-window-management) tiering implemented and exercised against real, full-length repository files.

**Exit Gate**:
- [ ] Across the initial holdout sample, an independent human rater judges the feasibility report "correct and appropriately scoped" for a threshold rate **to be set from this phase's own baseline run**, not assumed in advance (see [Evaluation Framework](./06_evaluation_framework.md#statistical-rigor) on not inventing false-precision targets).
- [ ] Zero unhandled crashes across the sample; every stop condition that fires produces the expected structured report.
- [ ] Token/cost per run stays within the Phase 0 budget defaults, or the defaults are deliberately revised with a documented reason.

## Phase 2 — Sandboxed Patch Generation (No PR Yet)

**Objective**: Prove the `Edit`/`Validate` mechanics — patch application, command/test execution, error handling, and stop conditions — hold up under real and *deliberately injected* faults, entirely inside the sandbox, before the harness is ever allowed to touch the real repository's PR queue.

**Deliverables**:
- `apply_patch`, `run_command` (allowlisted), `run_tests` implemented; the resulting branch/diff is inspectable internally (e.g., a human can pull the sandbox's branch) but **no `open_draft_pull_request` capability exists yet**.
- Full [error-handling taxonomy](./03_system_design.md#4-error-handling) implemented: schema validation, execution-failure classification, stagnation detection, circuit breaker.
- A fault-injection test harness that deliberately: sends malformed tool-call arguments, kills the sandbox mid-run, forces a patch conflict, forces a command timeout, and forces a repeated-identical-failure loop.

**Exit Gate**:
- [ ] Every fault-injection scenario above results in the correct, documented stop condition or recovery — no silent hang, no partial/corrupted sandbox state, no unbounded retry.
- [ ] Patch validity rate (proposed patches that pass `git apply --check`) and sandbox test-execution reliability are measured against a small internal sample; sandbox test flakiness is distinguished from the repository's own baseline CI flakiness (per the [failure taxonomy](./06_evaluation_framework.md#failure-taxonomy)).
- [ ] The scope-creep guard (diff size vs. issue size) is exercised with a deliberately oversized change and correctly forces a stop rather than proceeding.

## Phase 3 — Draft PRs, Mandatory Human Gates, Small Pilot Cohort

**Objective**: The first phase where a real human reviewer sees real agent output for real issues — measure the metrics that actually matter ([Evaluation Framework](./06_evaluation_framework.md#metrics-that-matter-vs-vanity-metrics)) on a small, explicit, willing pilot cohort before considering any wider use.

**Deliverables**:
- `open_draft_pull_request`, `post_status_comment` implemented; every PR opened is a draft, per [ADR-004](./04_architecture_decision_records.md#adr-004), with the structured run report attached.
- A shadow-mode run first (per [Evaluation Framework — Evaluation Tiers](./06_evaluation_framework.md#evaluation-tiers)): the full pipeline runs against a real backlog sample without any reviewer seeing the output, scored by an independent rater.
- A small, explicitly-labeled pilot cohort of willing reviewers, briefed that PRs are agent-authored and what specifically they're being asked to evaluate (Gate B, per [System Design](./03_system_design.md#6-human-in-the-loop-gates)).
- Red-team injection test corpus ([Evaluation Framework](./06_evaluation_framework.md#red-team--injection-testing)) run against the live pipeline (in the sandbox, against synthetic issues) before any real pilot issue is processed.

**Exit Gate**:
- [ ] Zero security incidents in red-team testing — every planted adversarial issue fails at the capability layer, verified by outcome (no egress, no blocked-path write), not by the model's stated reasoning.
- [ ] Merge-without-material-rework rate and reviewer-time delta are measured over a sample size backed by an actual power calculation ([Evaluation Framework — Statistical Rigor](./06_evaluation_framework.md#statistical-rigor)), not a handful of anecdotes.
- [ ] Post-merge revert rate for pilot-cohort PRs, tracked for at least 14 days post-merge, compared against the repository's human-authored baseline.
- [ ] Pilot reviewers surveyed directly on trust/friction — a neutral-to-positive result is required to proceed; a negative result pauses expansion regardless of the quantitative metrics.

## Phase 4 — Expanded Autonomy Within Unchanged Guardrails

**Objective**: Only if Phase 3 metrics hold at a larger sample, widen what the agent is allowed to attempt — without touching any of the human gates, the sandbox isolation, or the identity/permission model, which remain fixed regardless of how well Phase 3 went.

**Entry Gate**: Phase 3's exit-gate metrics must hold or improve when re-measured at a larger N drawn from a freshly-resampled holdout (guarding against the sample having been unrepresentatively favorable the first time).

**Deliverables**:
- Multi-file changes enabled (previously implicitly limited by the scope-creep guard's threshold).
- A modestly wider, still fully allowlisted, `run_command` set per repository, added deliberately with its own review — not opened generically.
- Cost/step/wall-clock budget defaults retuned using real Phase 3 data instead of Phase 0's initial guesses.

**Exit Gate**:
- [ ] Metrics from Phase 3 (merge-without-rework, reviewer-time delta, revert rate, reviewer trust survey) hold or improve at the larger N.
- [ ] No new failure category appears in the [failure taxonomy](./06_evaluation_framework.md#failure-taxonomy) that wasn't anticipated and covered by an existing stop condition.
- [ ] Cost per merge-without-rework outcome is tracked and remains below the reviewer-time value it's saving, per the pilot's own calibration.

## Phase 5 — Conditional Broader Rollout

**Objective**: Expand scope (more of the backlog, more reviewers, or relaxing exactly one specific guardrail) — explicitly conditional, and explicitly **one change at a time**, never a bundle.

**Deliverables** (illustrative — actual scope decided based on Phase 4 evidence, not planned in advance):
- Example single relaxations, each its own separate gated change: draft → auto-mark-ready-for-review (Gate B still exists, just triggered automatically after the run's own report meets a bar — merge, Gate C, is never touched by this); widening eligible issue types beyond the initial Gate A checklist; adding a second target repository.

**Exit Gate** (re-applied independently for each relaxation attempted):
- [ ] The specific relaxation is measured in isolation against the same metric set — a positive result on a bundle of simultaneous changes is not attributable and does not satisfy this gate.
- [ ] All Phase 3/4 security and trust exit-gate criteria continue to hold.

This phase may recur (each relaxation is its own instance of this phase) or may never trigger at all — the harness remaining permanently at Phase 4's scope is an entirely acceptable outcome if the evidence never justifies going further.

## Standing Rollback / Kill Criteria (apply at every phase)

Carried directly from [Evaluation Framework — Kill Criteria](./06_evaluation_framework.md#kill-criteria-for-the-whole-program): any confirmed security incident, a sustained revert-rate regression against the human-authored baseline, a collapse in reviewer trust, or a cost-per-useful-outcome that stops making sense — each is treated as a mandatory pause-and-reassess trigger at whatever phase the program is in, with rollback to the last phase where the exit gate was cleanly met.
