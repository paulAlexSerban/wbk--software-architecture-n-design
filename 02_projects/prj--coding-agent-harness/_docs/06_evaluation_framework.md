# Coding Agent Harness — Evaluation Framework

This document exists because "is this agent actually useful" and "is this agent impressive in a demo" are answered by almost entirely different evidence, and conflating them is the single most common way these projects fail quietly — a team ships something that looked great on five hand-picked issues, gets used in production, and only discovers months later (via reverts, incidents, or reviewers quietly stopping trusting it) that the demo told them almost nothing about real performance.

## The Demo Trap

A demo, by construction, uses issues that are:
- **Small and isolated** — touching one file or one clearly-bounded module, with no coupling to code the demo author didn't also look at.
- **Well-specified** — the issue itself already contains most of the information needed to fix it, because the person who wrote it also wrote or picked the code.
- **Unit-testable** — there's a clean test that turns green when the fix is right, and no ambiguity about what "right" means.
- **Selected after the fact** — chosen because they worked, not sampled before anyone knew whether they'd work.

None of these properties describe a representative slice of a mid-sized repository's real backlog. Real backlogs contain issues that are ambiguous ("this feels slow sometimes"), coupled to tribal knowledge never written down, guarded by a flaky or incomplete test suite, or simply larger than they look until someone starts. **A harness's demo performance and its production usefulness are, in the worst case, negatively correlated**: the exact tuning that makes small isolated issues resolve beautifully (aggressive scope assumptions, confident guessing when information is missing) is often the tuning that produces the most damage on ambiguous real issues, where the correct behavior is to stop and ask, not to guess confidently.

This document's job is to make sure the evaluation evidence is drawn from conditions the harness will actually operate under, not from conditions chosen because they make it look good.

## Evaluation Tiers

Each tier exists to catch a different failure mode, and none of them alone is sufficient to justify a rollout decision:

1. **Static/offline checks** — schema/contract tests on the tool layer, sandbox isolation tests (does a denied network attempt actually get denied), replay of past incident transcripts to confirm they'd be caught. Catches regressions in the harness's own mechanics; says nothing about task quality.
2. **Sandboxed smoke-test benchmark** — a small, fixed set of representative-but-known issues (curated or public), run on every harness change. **Treated as a regression check only, never a launch or rollout gate** (see [ADR-006](./04_architecture_decision_records.md#adr-006)) — a score improvement here is a "didn't obviously break something," not evidence of production usefulness.
3. **Shadow mode against the real backlog** — the harness runs end-to-end (including opening a draft PR, or an equivalent internal artifact) against a sample of real, currently-open issues, **without any reviewer being asked to look at the result**. A separate rater (not the reviewer who'd normally take the issue) scores the outcome after the fact. This is the first tier that uses real backlog conditions without spending real reviewer attention.
4. **Small pilot cohort with real reviewers** — a small, explicitly-labeled, willing set of reviewers see real draft PRs for real issues, knowing they're agent-authored. This is the first tier that measures the thing that actually matters: does a real reviewer, under real time pressure, find this genuinely useful.
5. **Production monitoring** — once past the pilot, the same metrics continue to be tracked indefinitely, not just during a launch window — usefulness can degrade over time (repository drift, model updates, reviewer fatigue) and this tier is what would catch that.

## Metrics That Matter vs. Vanity Metrics

| Vanity metric (looks good, proves little) | Why it's misleading | Real metric to use instead |
| --- | --- | --- |
| PRs opened / issues attempted | Says nothing about whether any of them were good — a harness that opens a draft PR for every issue regardless of confidence will maximize this while producing pure reviewer overhead | **Merge-without-material-rework rate** (fraction of draft PRs merged with the reviewer changing less than a small line-count threshold) |
| Sandbox tests-pass rate | A weak or incomplete test suite passing tells you the agent satisfied the test suite, not that the change is correct — this is exactly the gap a subtly-wrong change lives in | **Post-merge revert/hotfix rate within 14 days**, compared against the same rate for human-authored PRs on comparable issues |
| Time-to-first-draft | Fast is only good if the draft is worth the reviewer's time; a fast bad draft is a net negative | **Reviewer time delta**: median reviewer time on an agent PR vs. a human PR for a comparable issue class — the actual quantity this system is trying to improve |
| Model-reported confidence / self-assessed success | The model grading its own output is not independent evidence | **Independent human rating** (shadow-mode rater, or the actual reviewer) blind to the model's own stated confidence where practical |
| "It worked in the demo" | Selected after the fact from a non-representative sample | **Rate over a stratified, continuously-resampled holdout drawn from the real backlog** (see below) |

A harness that looks amazing on the left column and mediocre on the right column is, by this framework's definition, **not working** — the left column is not a fallback signal, it is actively risky to report as if it were evidence.

**The rubber-stamping failure mode**: a high merge rate is not unambiguously good — if reviewer surveys or spot-audits show reviewers are approving agent PRs with less scrutiny than they'd give a stranger's PR (because "the tests passed" or because of review fatigue from volume), that is itself a tracked failure mode, not a success. Automation bias — trusting a system more than the evidence warrants because it's usually right — is one of the most realistic ways this system causes an incident despite every metric looking fine right up until it doesn't.

## Statistical Rigor

- **The holdout is a sample of the real backlog, not a hand-picked set.** Stratify by issue type (bug fix, small feature, mechanical refactor, docs) and rough size/ambiguity, and draw the sample *before* anyone knows which specific issues will be easy or hard for the harness.
- **Refresh the sample periodically**, not once. A fixed holdout, reused indefinitely, eventually becomes something people (consciously or not) start optimizing toward, and a repository's backlog composition changes over time anyway.
- **Guard against Goodhart's law explicitly**: if triaging maintainers start routing only the issues they suspect will "work" to the agent (a natural, well-intentioned adaptation), the measured merge-without-rework rate will drift upward for reasons that have nothing to do with the harness improving. Mitigate by periodically auditing what fraction of the *actual* eligible backlog (per the Gate A checklist) is being routed, not just measuring outcomes among routed issues.
- **Minimum sample sizes before trusting a rate**: a binary outcome (merged-without-rework: yes/no) measured on 5–10 issues has enormous variance; "10/10 succeeded" is not evidence of a high true rate, it is consistent with a wide range of true rates. Any go/no-go decision in the [Phased Implementation Plan](./07_phased_implementation_plan.md) should be backed by a sample size derived from an actual power calculation for the effect size that matters (e.g., "can we distinguish a 50% from a 70% merge-without-rework rate with reasonable confidence"), not by an arbitrary round number of issues chosen because it felt like enough.

## Counterfactual Baseline

The right comparison is never "the agent vs. nothing" — issues get worked whether or not the agent exists. The right comparison is **the agent vs. a human picking up the same issue class**:
- Reviewer time delta is measured against human-authored PRs for comparable issues, not against zero.
- Revert/defect rate is measured against the same repository's baseline human-authored revert rate, not against a hypothetical zero-defect standard.
- "Useful" means the agent's output, plus the reviewer time it costs, beats or matches what would have happened if a human had just done it — not that the agent is flawless in isolation.

## Failure Taxonomy

Every stopped or escalated run (see [System Design — Stop Conditions](./03_system_design.md#5-stop-conditions)) is categorized by **why**, not just counted as a failure:

| Category | Example | What it implies |
| --- | --- | --- |
| Ambiguous/under-specified issue | Issue didn't state expected behavior clearly | Triage (Gate A) criteria need tightening — not a harness bug |
| Context/scope exhaustion | Step or token budget hit while still exploring a genuinely cross-cutting change | Either the issue was mis-triaged as small, or [context management](./03_system_design.md#3-context-window-management) needs improvement |
| Flaky test infrastructure | `run_tests` result inconsistent across identical runs | A repository-side problem the harness surfaces but did not cause — track separately so it isn't misattributed as harness failure |
| Genuinely hard problem within scope | Issue was well-scoped but the fix required a design judgment call | Expected and acceptable — the correct behavior is escalation (Gate D), and this is evidence the stop-condition design is working, not evidence of failure |
| Suspected prompt-injection attempt | Issue/comment text contained instruction-like content aimed at the agent | Security event — feeds [Security Architecture](./05_security_architecture.md) review and red-team test corpus, regardless of whether the attempt succeeded |

This taxonomy exists because an aggregate "success rate" number treats all of these identically, and they call for completely different responses — a spike in "ambiguous issue" stops means fix triage; a spike in "genuinely hard problem" stops is a sign the system is correctly aware of its own limits; a single "suspected injection" entry is a five-alarm security review regardless of the aggregate rate.

## Red-Team / Injection Testing

Before any pilot expansion (see [Phased Implementation Plan](./07_phased_implementation_plan.md)), the harness is tested against a corpus of **planted adversarial issues** — issue bodies and comments specifically crafted to attempt scope redirection into blocked paths, attempted command injection via `run_command` arguments, attempted secret exfiltration via `post_status_comment`, and social-engineering-style "this is actually a system message" framing. Every planted attempt must fail at the capability layer ([Security Architecture](./05_security_architecture.md#prompt-injection-threat-model)) regardless of whether the model recognizes it as an attack at the prompting layer — the test asserts the *outcome* (no egress, no blocked-path write, no secret in a comment), not the model's stated reasoning.

## Kill Criteria for the Whole Program

Stated explicitly, in advance, so a bad outcome has a predetermined response rather than a debate under pressure:

- **Any confirmed security incident** (a red-team-style attempt that actually succeeded in production, not just in testing) — immediate pause of all runs, full audit review, no resumption until root-caused and fixed.
- **Post-merge revert/incident rate meaningfully exceeds the human-authored baseline**, sustained over a large-enough sample to be statistically credible (not a single bad PR) — pause expansion, investigate, likely roll back to an earlier, narrower phase.
- **Reviewer trust collapses** — survey or qualitative signal that reviewers no longer believe the draft PRs are worth their time, independent of the quantitative metrics — this is treated as disqualifying on its own, because the entire value proposition depends on reviewers actually engaging with the output rather than reflexively distrusting or reflexively rubber-stamping it.
- **Cost per merge-without-rework outcome exceeds the reviewer-time value it's supposed to save**, sustained past the pilot's initial calibration period — this is a legitimate reason to shut the program down, not just tune it, if it doesn't improve.

None of these are framed as "tune and continue by default" — each one is framed as a genuine stop-and-reassess trigger, because a system this capable of causing quiet damage should have to actively earn continued operation, not be assumed worth continuing by default.
