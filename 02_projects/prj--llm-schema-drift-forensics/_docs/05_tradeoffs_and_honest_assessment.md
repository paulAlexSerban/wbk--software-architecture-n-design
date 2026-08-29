# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone writes a log query.

The constraint, once: **you cannot collect last week's evidence this week.** "What changed and when" is answered to the precision of the highest [evidence rung](./01_business_overview.md#the-evidence-ladder-the-actual-requirement) that still has data in the incident window. No algorithm climbs a rung that is empty. Designs that skip the inventory and go straight to binary search are refusing the question.

## 1. What I would build

Two things, in this order of **user pain**, not this order of intellectual interest.

**First, a parser patch from current traffic** ([ADR-007](./04_architecture_decision_records.md#adr-007)). Read a handful of live responses. Diff them against the keys the parser requires. Dual-support old and new names, or accept the new shape, and ship. This is not the forensic system. It is why you still have a product on Friday.

**Second, a forensic pass over whatever already exists**, not a new platform:

- An **evidence inventory** that states the rung in writing.
- A **fingerprint** of JSON shape (paths + types), envelope and payload separate, with presence rates so optional keys do not look like a new schema every call.
- A **coarse histogram** of those fingerprints over the lookback, then either **bisection** (if and only if the timeseries is a clean step) or the histogram itself as the answer (if the vendor canaried, regionalized, or mixed aliases).
- A **structural diff** of the isolated families: added / removed / type-changed / candidate-renamed.
- A **correlation** against model snapshot / `system_fingerprint` / region / endpoint, and against **your own deploys and prompt changes** in the same window — because the LLM API is not the only thing that can rename a key.
- A **report** that includes the rung, the algorithm, the bound, and the caveats. The bound may be a minute, a day, or "no later than when we noticed." All three can be successful.

**Third, after the incident (or in parallel if staffing allows): a schema contract monitor** so this is not a quarterly ritual:

- required-key validation on ingest (extra keys allowed, missing required keys page)
- a few golden probes per contract, every 15–60 minutes
- a fingerprint ledger with ~90-day retention
- model snapshot pinning where the vendor offers it

If Phase 1 discovers rung-6 bodies and a clean step, the forensic half looks like a short script and the docs will look heavy relative to the work. Build the monitor anyway. The script does not prevent the sequel. If Phase 1 discovers rung 2 and a retention gap, the forensic half looks like a disappointment. Publish the disappointment. Then build the monitor, because that disappointment is exactly what the monitor is for.

## 2. What I would give up

Be explicit. These are not "later." They are not in v1, and some of them are never in this design.

**An exact timestamp from incomplete evidence.** If bodies aged out, the honest output is a window from metrics or first exception, or an inability to date. I will not "estimate Tuesday" because the interview felt like it wanted Tuesday.

**A proof that a key was renamed.** Complementary presence of `summary` and `brief` is a **candidate** rename. Remove+add of unrelated keys in the same vendor release is observationally identical. The report will not launder a hypothesis into a fact.

**Catching semantic changes that keep the same keys.** Format-of-the-string, meaning-of-the-enum, "citations now hallucinate less but the key is still `citations`." Out of scope. Schema forensics is keys and types.

**Bisection as a personality.** It is an optimization for a monotonic step on cold storage. Mixed rollouts get a histogram. Already-materialized fingerprints get a scan. I give up looking clever.

**A new observability vendor, a data lake, or an "LLM that reads the logs."** Last week's JSON is not a reason to procure. An LLM summarizer of schemas is how you get an undebuggable wrong diff.

**Full capture of user prompts/responses "for schema safety."** That is a prompt warehouse. Fingerprints + probe bodies + required-miss logs are the retention design. [ADR-004](./04_architecture_decision_records.md#adr-004).

**Strict JSON Schema (additionalProperties: false) against a vendor I do not control.** Additive fields are normal. Paging on them kills the monitor.

**Waiting for the vendor's changelog before patching or before publishing our bound.** Their timeline is corroboration.

**The fantasy that `"latest"` is a contract.** If we keep a floating alias, we keep a named instability. Pinning is the trade: delayed vendor quality vs delayed schema surprises. I would take the pin for any path that parses JSON into business logic.

**Platformizing the forensic toolkit after one incident.** Three similar incidents: maybe. One: a saved query and a report template.

## 3. What I would ask for, even though I expect a no

Ask **once, in writing**, with the forensic report (or the Phase 0 current-body diff) attached so the TAM is not guessing. A no must not block the patch or the monitor.

Ask the **LLM vendor**:

1. **Did a model snapshot / API schema change in this window, and what were the key diffs?** Expected: vague blog post, or "we don't discuss rollout timing," or a doc that does not mention your key. Ask anyway; sometimes there is an internal ticket they can match to your `x-request-id`s.
2. **A pinned snapshot / dated model id for production**, if we are not already on one. Expected: exists and we were not using it, or does not exist on this product line.
3. **Changelog or webhook for response-schema / JSON-mode / tool-call argument shapes.** Expected: no. Model-card updates are marketing.
4. **Retention of *our* request/response on their side for the incident window.** Expected: no, or 30 days if you are on an enterprise contract you had not read. If yes, that can climb the ladder after the fact — a gift, not a plan.
5. **`system_fingerprint` (or equivalent) in the response, and a guarantee it changes when the serving model changes.** Some vendors already send this; we may have been discarding it.

Ask **ourselves / platform / legal** (these can actually get a yes):

6. **Extend fingerprint (not body) retention to a forensic horizon.** This is the ask that prevents the sequel. Expected: negotiation, not a no.
7. **Permission to retain synthetic probe bodies.** Should be easy; they are not user data.
8. **A required-key contract per surface, named owners.** If nobody will own "these keys are required," the monitor has nothing to enforce.
9. **Deploy/prompt changelog access for the lookback** so we do not blame the vendor for our own rename.

What I would **not** ask for: that they freeze the model, that they expose weights, that they offer a legally binding schema SLA this quarter, that security approve a full prompt lake. Those asks burn time the parser patch needs.

## 4. What is knowable, boundable, and unrecoverable

This is the heart of the scenario. No clean answer exists; the job is to say which kind of unclean answer you have.

| Question | Knowable exactly (typical rung 6, clean step) | Only boundable | Unrecoverable from our data |
| --- | --- | --- | --- |
| **What keys changed?** | Set-diff of path+type between families present in retained bodies | "At least these keys" from exception names / nulling columns; current bodies show the *new* full shape, not the old | Keys that existed only in the gap, never stored, never crashing a parser (optional keys nobody read) |
| **When?** | `[T_last_old, T_first_new]` at log resolution if monotonic | Metric/exception inflection window; histogram mixed window; sampled-log gap | Vendor's actual canary start in a region we do not serve; changes during a retention hole |
| **Was it a rename?** | Never "exactly" | Candidate, if complementary presence | Vendor intent |
| **Was it staged?** | Yes, if slices show mixture | "Consistent with staged" if overlap exists | Their targeting rules (account flags we cannot see) |
| **Was it us?** | Yes, if our deploy/prompt diff matches the key diff and the vendor fingerprint did not move | "Could be both" if they coincide | A prompt change that was not in git (hot-edit in a dashboard) if that dashboard has no audit log |
| **Are last week's stored extracts trustworthy?** | Columns that still exist can be compared | Fields that went null after T are suspect | Fields we never stored — we cannot audit what we did not keep |

**The uncomfortable case the prompt is aiming at:** you noticed on day 8, logs retain 7 days, bodies for the change day are gone. You have current schema (what) and a metric bump whose left edge is clipped by retention (when ≥ retention horizon). **That is the answer.** Write it down. Then ship the monitor. Spending a week reconstructing from Slack memories is how you produce a date that will enter folklore and be wrong.

## 5. Retention vs forensic capability (the real trade-off)

| What you retain | Cost / risk | What next incident can claim |
| --- | --- | --- |
| Nothing extra | Zero | Rung 0–2. This incident, again. |
| Required-miss logs (path, time, model, request id) | Tiny; still PII-adjacent (request id) | Rung 3: which required key broke, first-seen time |
| Fingerprint ledger, 90 days | Tiny storage; schema paths are mildly sensitive | Rung 6 at **shape** grain: when the hash moved, sliced by model |
| Fingerprints + 0.1–1% live bodies | Storage + PII program | Rung 5–6: shape + example values for the diff |
| 100% bodies, long retention | Prompt warehouse. Security will (should) kill it | Perfect forensics, unacceptable product |

I would buy **required-miss logs + fingerprint ledger + synthetic probe bodies** every time. I would fight for sampled live bodies only if legal already allows trace payloads. I would not fight for 100% bodies in the name of this problem.

## 6. Complexity, stated without romance

This is **not** a hard distributed-systems problem. It is a hard **honesty** problem.

The easy version (rung 6, clean step, fingerprints already cheap to compute): a query, a histogram, maybe a binary search over S3, a path-set diff, an afternoon.

The realistic version (rung 3–4, optional-key noise, a prompt deploy on Wednesday, a vendor alias move sometime that week, logs in two timezones): several days of inventory and interpretation, a window instead of a T, a candidate rename, and a postmortem that some stakeholders will call inconclusive. It is inconclusive. Ship it anyway, with the rung on the first line.

The monitor is a small cron, a JSON-schema check you should have had, and a ledger table. Teams overbuild it into an eval platform because eval platforms are résumé-adjacent. Resist.

The thing that is actually expensive is **not having done the inventory before you promised an exact day**, and **not pinning the model** so the same class of failure remains likely.

## 7. Brutal summary

The clever design is not a binary search. The clever design is **fingerprinting shape instead of diffing answers**, **refusing bisection when the rollout was mixed**, **stating the evidence rung on the report**, and **patching the parser before the postmortem is interesting**.

If you had full bodies and a step function, you will find what changed and when, and it will look obvious in hindsight. If you did not, you will find a window and a current schema, and anyone who demands more is demanding a time machine. Either way, next week you retain fingerprints, enforce required keys, pin the model you parse, and you do not get this prompt again — not because the vendor got nicer, because you stopped treating a floating alias as a wire contract.
