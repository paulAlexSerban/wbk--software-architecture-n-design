# LLM Schema Drift Forensics — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not "documentation theater"** — it is the parser patch that stops user-visible breakage, and it does **not** wait for a dated forensic report. Phases 1–3 are the investigation of *this* incident. Phase 4 is the monitor that prevents the sequel. Rollback/kill criteria at the bottom apply at every phase. In particular: **never publish an exact timestamp from a rung that cannot carry it.**

Calendar assumptions: one engineer (or a very small team) who already owns the serving path. Phase 0 is hours. Phases 1–3 are one to three days depending on the rung. Phase 4 is a subsequent small project (days, not a quarter) and may start in parallel with 1–3 if a second person exists; it must not block Phase 0.

## Phase 0 — Stop the Bleeding (hours; not a phase you skip)

**Objective**: Restore a working parse of **current** LLM JSON. Dating the change does not unbreak today's traffic. [ADR-007](./04_architecture_decision_records.md#adr-007).

**Deliverables:**
- A sample of **current** live responses (bodies you can capture *now*), redacted as production logs require.
- Diff against the parser's required keys: missing, added, type-changed.
- A patch: dual-support old and new names, or switch to the new shape if old is fully gone in current traffic. Do not fuzzy-match on the hot path as a permanent strategy; dual-support is explicit.
- A metric: parse-success / required-key-miss after the patch, so you can see whether you actually stopped the bleeding.
- A one-line incident note: "current schema differs from parser contract by X; patch shipped; forensics follow."

**Exit Gate:**
- [ ] Current-traffic sample exists and was inspected by a human, not only by a failing unit test.
- [ ] Patch is in production (or in a flag that is on for the broken surface).
- [ ] Parse-success has recovered to an acceptable level for that surface, or the remaining failures are explained (truncation, unrelated 5xx).
- [ ] Forensics have **not** been used as a release blocker.

If current traffic is mixed (old and new keys both arriving), dual-support is the patch. That mixture is also a Phase 2 input: it is overlap, and it kills naive bisection for "now"; history may still have a step.

## Phase 1 — Evidence Inventory (day 1, starts in parallel with Phase 0)

**Objective**: Name the rung before promising a day. Building a bisection script against an empty S3 prefix is how the week is spent on the wrong system.

**Deliverables:**
- Catalogue of sources: application logs, APM/trace blobs, object-storage replay, warehouse columns, exception streams, dashboards, tickets, **and your deploy/prompt changelog**.
- For each source: time range still present, sample rate, fields retained, timezone, whether timestamp is response-time or ingest-time, join key.
- Retention-gap statement: "bodies exist from D to now; incident rumor is D-4" (or whatever is true).
- Assigned **rung** for this incident ([evidence ladder](./01_business_overview.md#the-evidence-ladder-the-actual-requirement)).
- Lookback window chosen to **start before** the suspected change if data exists; if not, lookback is "whatever remains" and the left bound is open.
- Written vendor asks sent (changelog, pin, retention) — replies not required. [Trade-offs §3](./05_tradeoffs_and_honest_assessment.md#3-what-i-would-ask-for-even-though-i-expect-a-no).

**Exit Gate:**
- [ ] Rung is written down with evidence (a screenshot of retention settings counts; "I think we log bodies" does not).
- [ ] Timezone/clock caveats are written down.
- [ ] Our own deploys/prompt changes in the rumored window are listed or confirmed absent.
- [ ] Feasibility call: **rung 0 with no proxies → skip to a report that says we cannot date this, then Phase 4.** **rung 1–4 → Phase 2 proxy path.** **rung 5–6 → Phase 2 body path.** Do not enter the body path on warehouse columns and call them bodies.

## Phase 2 — Fingerprint, Timeline, Diff (days 1–3)

**Objective**: Produce the tightest **what** and **when** the inventory supports. This phase is allowed to produce a window. It is not allowed to produce an undated novel or a timestamp without a monotonicity check.

**Deliverables:**
- Fingerprint function as in [System Design §2](./03_system_design.md#2-schema-fingerprint) (envelope vs payload; presence rates; truncation/`INVALID` handling).
- Extract of bodies or proxies for the lookback.
- Coarse histogram (illustrative 6-hour buckets, then finer if needed).
- Overlap check recorded: **bisection licensed or forbidden.**
- If licensed: bound `[T_last_old, T_first_new]` from bisection or scan, **without interpolating across sample gaps**.
- If forbidden: histogram description, including metadata slices (model, region, snapshot/fingerprint, endpoint).
- If proxies only: inflection window, plus structural diff of **current** bodies vs parser contract (what-now, when-bounded).
- Structural diff of isolated families: adds/removes/type-changes/candidate-renames. [System Design §4](./03_system_design.md#4-structural-diff).
- Correlation notes, including "our deploy coincides" or "vendor snapshot flipped" or "insufficient metadata."
- Draft forensic report with **rung on the first line**.

**Exit Gate:**
- [ ] Histogram (or proxy series) exists; a reviewer who is not the author can see whether the change looks like a step, a ramp, or a mixture.
- [ ] If T is a single short bound, the overlap check is attached and passed.
- [ ] If overlap failed, no single T appears in the report except as a rejected temptation.
- [ ] Diff table is about **paths and types**, not about generated text.
- [ ] Truncation / `INVALID` / optional-key noise was handled, or called out as residual risk.
- [ ] Our-deploy hypothesis is explicitly accepted, rejected, or marked "cannot tell."

If this gate cannot pass because the extract is empty: **do not iterate on the algorithm.** Return to Phase 1; the rung was wrong. If the rung is truly 0–1, write the report and go to Phase 3/4.

## Phase 3 — Report, Vendor, Decisions (day 2–4)

**Objective**: Freeze the investigation as an artifact, optionally corroborate with the vendor, decide what to pin and what to dual-support long-term. This is not a new analysis. It is publication and follow-through.

**Deliverables:**
- Published forensic report (immutable version): rung, algorithm, bound, diff, correlation, caveats, link to Phase 0 patch.
- Vendor packet: redacted before/after shapes, request ids, timestamps, model ids — sent once.
- Decision: pin snapshot or accept floating alias as named risk ([ADR-005](./04_architecture_decision_records.md#adr-005)).
- Decision: required-key contract for the monitor (the list ingest will enforce).
- If the change was *us*: a follow-up on prompt/parser release process so schema changes ship with parser changes.

**Exit Gate:**
- [ ] Report is stored where postmortems live, not only in chat.
- [ ] Vendor ask is sent or explicitly skipped with a reason.
- [ ] Pin / no-pin decision is written.
- [ ] Required-key list has an owner.
- [ ] Stakeholders have been told the bound **and the rung**, not only the bound.

Vendor silence is not a failed gate.

## Phase 4 — Schema Contract Monitor (post-incident, days not weeks)

**Objective**: Make the next occurrence a same-day (really same-hour) detection with a ledger that dates it without a scavenger hunt.

**Entry Gate:** Phase 0 patched production. Phase 4 may start before Phase 2 finishes. It must not wait for vendor replies.

**Deliverables:**
- Ingest validator: required `(path, type)` check, extra keys allowed, miss → metric + alert (+ optional fail-closed per surface). [ADR-003](./04_architecture_decision_records.md#adr-003).
- Structured required-miss log (path, model, time, request id) — future rung 3, cheap.
- Golden probe runner: few fixed prompts, 15–60 min, cache bypass, dedicated key if possible. [ADR-006](./04_architecture_decision_records.md#adr-006).
- Fingerprint ledger with retention ≥ the "we might notice a week late" horizon, or a written legal exception that shortens it and accepts the consequence. [ADR-004](./04_architecture_decision_records.md#adr-004).
- Last-known-good update path that is **manual accept**, not auto.
- Drill: break a required key on staging (or a probe fixture) and confirm a page.
- Optional: live fingerprint sampling 0.1–1% if PII policy allows.

**Exit Gate:**
- [ ] A staging drill pages on required-key miss.
- [ ] Extra-key-only change does **not** page (warn/metric only).
- [ ] Probes have completed multiple intervals unattended; ledger rows exist.
- [ ] Last-known-good cannot change without an explicit accept (tested).
- [ ] Pin is in production **or** the floating-alias exception is documented with its own probes.

This phase may look small relative to the forensic docs. That is success. A monitor that takes a quarter is a different project wearing this incident as a costume.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop and escalate — do not "keep the investigation green" — if any of the following hold:

1. **Rung cannot support the claim being drafted.** A Tuesday 14:03 in a rung-2 report is a kill of that report version, not a finding. Downgrade the claim to the window the rung allows, or kill the date entirely.
2. **Bisection run without a passed overlap check.** Discard T; produce the histogram.
3. **Phase 0 blocked on Phase 2.** Unblock Phase 0 immediately. Forensics are not a hostage mechanism.
4. **Bodies copied off-platform in violation of PII policy** "so we can grep." Delete, switch to fingerprints/proxies, involve security. A dated schema is not worth an incident of your own.
5. **Monitor auto-updates last-known-good** after a mismatch. Roll back the update; the mismatch is the alert, not a new baseline.
6. **Forensic scope expands into general eval / hallucination / quality.** Kill the expansion. Different project ([llm-hallucination-detection](../../prj--llm-hallucination-detection/README.md) if that is the real ask).
7. **No historical data and no proxies, and someone wants a reconstructed timeline from memory.** The output is "cannot date from our data." Memory may go in an appendix labeled anecdote.

Rollback is always to the last phase whose exit gate was honestly green. After a kill of the **date**, the **diff of current vs contract** still ships; Phase 0 still ships; Phase 4 still ships. You can fail to date a change and still succeed at stopping it and seeing the next one.
