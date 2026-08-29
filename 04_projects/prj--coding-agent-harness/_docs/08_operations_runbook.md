# Coding Agent Harness — Operations Runbook

Operator- and reviewer-facing procedures for day-2 operation. This complements the [System Design](./03_system_design.md) (which explains *how* things work) with concrete, step-by-step checklists.

## Reviewer Checklist

This is the single most important procedure in this document, because Gate B ([System Design — Human-in-the-Loop Gates](./03_system_design.md#6-human-in-the-loop-gates)) is the point where a plausible-looking but wrong change is most likely to be caught — or missed. **Review an agent-authored draft PR at least as carefully as a stranger's PR, not less carefully because "the tests passed."**

1. **Read the structured run report first**: plan, files touched, test results, cost, and any open questions the agent flagged. If the agent itself flagged an open question or a low-confidence area, start there.
2. **Check scope against the issue**: does the diff touch only what the issue actually required? A diff that's broader than the issue is either evidence of a real necessary dependency (verify it) or a scope-creep signal that should have been caught by the automated guard ([System Design §5](./03_system_design.md#5-stop-conditions)) — if it wasn't, that's worth reporting as a harness gap, not just fixing in review.
3. **Do not treat "tests pass" as "correct."** Ask: does this repository's test suite actually cover the behavior the issue describes? If the answer is "not really," read the diff as carefully as you would a change with no tests at all.
4. **Check for path-policy violations** that shouldn't have been possible: any touch to authentication, secrets, CI workflows, or infra/deploy config is a hard stop — report it immediately as a security issue (see [Injection/Security Incident Response](#injectionsecurity-incident-response)), don't just request changes, because it means a control that should have blocked this at the tool level didn't.
5. **Check for dependency/lockfile changes** — these should never appear without the explicit elevated approval described in [Security Architecture — Supply Chain Policy](./05_security_architecture.md#supply-chain-and-sensitive-path-policy); if one appears without that approval on record, treat it the same as #4.
6. **Read the actual diff line by line** for the same things you'd check in any PR: does it handle the edge cases the issue implies, does it match the repository's existing conventions, does it introduce a new failure mode elsewhere.
7. **Decide**: approve and mark ready for review (Gate B cleared) → normal review/merge process (Gate C, unchanged) takes over; or request changes / reject, which routes back to a new run or manual takeover, never an automatic silent retry.
8. **If you found yourself tempted to skip steps 2–6 because "it's probably fine"** — that instinct, tracked in aggregate across reviewers, is itself the rubber-stamping failure mode described in the [Evaluation Framework](./06_evaluation_framework.md#metrics-that-matter-vs-vanity-metrics). Report it (a quick note to the agent-ops owner) rather than just acting on the instinct silently.

## Handling a Stuck or Runaway Run

1. Check the run dashboard/log for which [stop condition](./03_system_design.md#5-stop-conditions) should have fired and hasn't — a run that's still going past its step/wall-clock/token budget is itself a bug in the orchestrator's enforcement, not just a slow run.
2. Manually cancel the run (the human-cancel stop condition) — this immediately tears down the sandbox; nothing is lost except the run's own progress, which was going to be discarded on failure anyway.
3. File the budget-enforcement gap as a harness bug; do not simply raise the budget as a workaround without understanding why the enforcement didn't fire.

## Cost-Spike Response

1. Identify whether the spike is concentrated in a few unusually expensive runs (likely a specific issue class exhausting context — check the [failure taxonomy](./06_evaluation_framework.md#failure-taxonomy) for a spike in "context/scope exhaustion") or spread evenly (likely a budget-default that's too generous across the board).
2. For a concentrated spike: check whether Gate A triage criteria let through issues that don't actually meet the "well-scoped" bar — tighten the checklist rather than the harness.
3. For a systemic spike: retune the token/step/wall-clock budget defaults, but retune based on the [Evaluation Framework's](./06_evaluation_framework.md) cost-per-useful-outcome metric, not on raw spend alone — a cheaper harness that produces nothing useful is not an improvement.

## Injection/Security Incident Response

Triggered by: a sandbox-level denied-egress event outside of red-team testing, a hard-blocked-path write attempt, a suspected-injection entry in the [failure taxonomy](./06_evaluation_framework.md#failure-taxonomy), or a reviewer-reported policy violation (see [Reviewer Checklist](#reviewer-checklist), step 4).

1. **Pause the affected run immediately** if still active; do not let it continue "to see what happens."
2. **Pull the full audit log for the run** — every tool call, every model turn, the exact issue/comment/file content that triggered the attempt.
3. **Confirm the capability layer held**: verify the denied action was actually denied (no egress succeeded, no blocked path was written, no secret appeared in any comment/log) — this is a verification step, not an assumption, per [Security Architecture](./05_security_architecture.md#prompt-injection-threat-model).
4. **If the capability layer held**: log the attempt, add it to the red-team test corpus so future harness changes are tested against this exact pattern, and continue normal operation — this is the system working as designed.
5. **If the capability layer did not hold** (something got through it shouldn't have): treat as a full security incident — pause all runs against the affected repository, per [Evaluation Framework — Kill Criteria](./06_evaluation_framework.md#kill-criteria-for-the-whole-program), until root-caused and fixed. Rotate the GitHub App's private key as a precaution regardless of whether it appears to have been the vector.
6. **Report**, regardless of outcome — even a successfully-blocked attempt is a signal worth the whole team knowing about, since the source (a specific issue reporter, a specific repository path) may be relevant beyond this one incident.

## Post-Merge Revert Procedure

1. If an agent-authored PR is reverted or hotfixed within the 14-day tracking window ([Evaluation Framework](./06_evaluation_framework.md#metrics-that-matter-vs-vanity-metrics)), log it against that run's record regardless of whether the root cause turns out to be the agent's fault, the reviewer's, or the issue's own ambiguity — attribution happens during review, not by omission from the metric.
2. Add the underlying issue/pattern to the [failure taxonomy](./06_evaluation_framework.md#failure-taxonomy) tracking, so a recurring pattern (e.g., a specific kind of issue the agent consistently gets subtly wrong) becomes visible in aggregate, not just as isolated incidents.
3. Revert handling itself is otherwise identical to any other PR's revert process — this system does not introduce a special revert mechanism.

## GitHub App Credential Rotation

1. Generate a new private key for the App without revoking the old one yet.
2. Deploy the new key to the orchestrator's runtime configuration; confirm a test run authenticates successfully.
3. Revoke the old key.
4. Confirm no in-flight run was disrupted (runs are short-lived and sandboxed, so overlap risk is low, but verify).
5. Rotate on a fixed schedule and immediately on any suspected compromise (see [Injection/Security Incident Response](#injectionsecurity-incident-response), step 5).

## Periodic Review Cadence

- **Weekly (during pilot phases)**: review the run dashboard for stop-condition distribution, cost trend, and any security events, however minor.
- **Per phase-gate**: re-run the full [Evaluation Framework](./06_evaluation_framework.md) metric set against a freshly-resampled holdout before approving progression to the next [Phased Implementation Plan](./07_phased_implementation_plan.md) phase.
- **Ongoing, post-rollout**: the same metrics continue indefinitely — this system does not graduate to "unmonitored" at any phase, because usefulness can degrade silently (repository drift, model updates, reviewer fatigue) even after a successful launch.
