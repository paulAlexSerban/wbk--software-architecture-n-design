# Cross-System Report Pipeline — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. Phases 0–3 are sequential and sized for the stated one-week deadline. **Phase 0 is not optional and is not "documentation theater"** — building the extractor against a guessed page size is how the week is spent on the wrong system. Phase 4 is ongoing after the first ship and may last days or weeks depending on what Phase 0 measured.

Rollback/kill criteria at the bottom apply at every phase. In particular: **never ship an unlabeled report to make a gate look green.**

Calendar assumptions: one operator, ~5–6 working days to first ship, nights and a weekend only if the operator already works that way. The backfill runs whenever the process is up; it does not require a human after it is started.

## Phase 0 — Verify the Unknowns (Day 1)

**Objective**: Replace the load-bearing guesses with measurements and written asks, *before* the extractor's data model is treated as real. A wrong join key or a page size of 1 discovered on Thursday is a failed week that looked busy.

**Deliverables**:
- Written asks sent to System B (bulk dump, delta filter, cap exception, page-size docs) and System A (filename, timezone, schema, retention), plus the consumer briefing that Friday may be labeled-partial. See [Trade-offs §3](./05_tradeoffs_and_honest_assessment.md#3-what-i-would-ask-for-even-though-i-expect-a-no). Do not wait for replies.
- **Page size measurement**: a tiny, limiter-respecting probe (a handful of requests) recording records/request, pagination shape, and whether `page[size]` is honored.
- **Delta-filter measurement**: try `updated_since` / `modified_after` / cursor params that the docs or a response body suggest. Record exists / does not exist / exists-but-broken.
- **Limiter measurement**: note 429 behavior, `Retry-After`, remaining-limit headers, evidence of a clock-hour vs rolling window, evidence the key is already in use.
- **Join-key measurement**: from a sample A file (even a stale one) and a tiny B pull, estimate match rate and uniqueness both ways. Cartesian-product risk is a Phase 0 finding, not a Phase 3 surprise.
- **FTP facts**: protocol (FTP/SFTP/FTPS), path, name pattern, drop time + timezone, encoding, headers, typical bytes/rows.
- **Report column list** from the consumer: the minimum B fields worth storing.
- A one-page "unknowns log": each item is `measured` or `open, fallback assumption is X`. Open items that can kill feasibility (page size 1 *and* no delta *and* daily cadence) are flagged immediately.

**Exit Gate**:
- [ ] Probe results for page size, pagination, and delta existence are written down with the raw evidence (status codes, a redacted response shape) — not "I think it's paginated."
- [ ] Join key is named, and a sample match-rate is computed. If match-rate is catastrophic, stop and escalate to the consumer before writing more code.
- [ ] Asks have been sent. Replies are not required to pass this gate.
- [ ] Consumer has been shown the math table and has not been promised 100% coverage on Friday.
- [ ] Feasibility call: **weekly + some page size or a delta path → proceed.** **Daily + page size 1 + no delta → kill/escalate** per standing criteria, do not quietly enter Phase 1 as if the arithmetic will soften.

## Phase 1 — FTP Ingester and Archive (Days 1–2)

**Objective**: Make the easy source boring and replayable, in parallel with waiting on Phase 0 replies. System A must not still be a manual download on Friday morning.

**Deliverables**:
- Landing zone + immutable archive + checksum sidecar, idempotent on (drop date, checksum).
- Scheduled pull after expected drop + grace; missing/late/conflict/schema-drift detection as in [System Design §4](./03_system_design.md#4-ftp-ingester-mechanics).
- Current A snapshot available to a join (table load or dated file — pick one and document it).
- Alert on missing drop, wired to an already-owned channel.

**Exit Gate**:
- [ ] A real (or deliberately planted) nightly file has been pulled, archived, checksummed, and re-pulled as a no-op.
- [ ] A missing-file drill fires the alert and does not emit an empty snapshot.
- [ ] A header-drift drill fails the load rather than coercing columns.
- [ ] The archive path and checksum are recorded so a report can name the file it used.

Do not wait to start Phase 2 if this gate is close; the extractor is the long pole. Do not skip the missing-file drill — that is the Friday failure mode.

## Phase 2 — Rate-Limited Extractor, Mirror, Watermarks (Days 2–4)

**Objective**: Turn System B quota into durable rows. Start backfill as soon as the first successful page upserts — hours spent "finishing the framework" after the limiter works are hours of coverage not on disk.

**Deliverables**:
- Local store created (`b_record`, watermarks, run tables) per [System Design §5](./03_system_design.md#5-local-mirror-schema-logical).
- Token-bucket limiter with 429/`Retry-After` handling and small/zero burst ([System Design §2](./03_system_design.md#2-rate-limiter)).
- Page walker with **per-page transactional checkpoint** (rows + watermark).
- Delta path if Phase 0 found a filter; ID-cursor backfill path regardless (needed for bootstrap even when delta exists).
- Quota split: weekly bootstrap may be backfill-heavy; daily *must* reserve delta first ([System Design §3.3](./03_system_design.md#33-quota-split)).
- Heartbeat schedule so the extractor is alive around the clock (or as close as the box allows). A limiter that only runs during working hours throws away most of the week's 16,800.
- Minimum observability: requests this hour, 429s, watermark age, rows upserted.
- Optional, isolated, **one-shot** bootstrap loader if a UI export/scrape was approved as a last resort ([ADR-004](./04_architecture_decision_records.md#adr-004)) — not on cron.

**Exit Gate**:
- [ ] A crash/kill mid-page-run resumes from the last checkpoint without resetting the cursor to the beginning.
- [ ] A forced 429 (or a real one) backs off; the client does not tight-loop.
- [ ] Mirror row count increases on a clock while unattended for at least several hours.
- [ ] Two watermarks are inspectable (`delta` unused is acceptable if no filter exists; `backfill` must move).
- [ ] Backup of the store file is in place, even if "copy to another disk the operator already has." Losing the mirror is losing the week.

If Phase 0 found a bulk dump after all, **load it here** and treat the extractor as delta-only going forward. Do not ignore a gift because the backfill code was already written.

## Phase 3 — Join, Banner, Ship v1 (Days 5–6)

**Objective**: Emit the artifact the consumer asked for, with the honesty the math requires. This phase is allowed to ship at low coverage. It is not allowed to ship without coverage printed.

**Deliverables**:
- Left join from current A snapshot to B mirror ([ADR-007](./04_architecture_decision_records.md#adr-007)).
- Sidecar/header banner: coverage %, unmatched A count, A drop date+checksum, B watermarks, `last_sync_at`, last-good-A flag if used. These values persisted on a `report_run` row.
- Scheduled report window (weekly: the deadline; daily: each morning after A ingest + a small B-sync buffer that does **not** attempt a full catch-up).
- The report job contains **zero** System B HTTP calls.
- A dry-run artifact reviewed by the operator (and, if possible, the consumer) before the official send.

**Exit Gate**:
- [ ] Dry-run file contains the banner; a reviewer who is not the author can state the coverage number without opening a log.
- [ ] Unmatched A keys are visible (in-row or companion file), not dropped.
- [ ] Killing System B during report generation still produces the file (it must not need System B).
- [ ] Official v1 is sent by the deadline **or** the consumer has explicitly accepted a slip in writing. Silence is not a slip grant.
- [ ] `report_run` row exists for what was sent, so "what did we ship" is not a Slack argument.

## Phase 4 — Ongoing Backfill and Convergence (post week-1)

**Objective**: Let coverage climb until it plateaus at ~100% of A join keys (or at whatever ceiling the join-key mismatch imposes — that ceiling is a data-quality finding, not an extractor bug). This phase has no calendar end date.

**Entry Gate**: Phase 3 shipped a labeled report. If Phase 3 slipped without a file, Phase 4 is not a place to hide; go back and ship a labeled file or kill.

**Deliverables**:
- Extractor continues unattended; quota split retuned from real delta volume (if weekly and delta is tiny, feed leftovers to backfill until cursor ends, then idle).
- Coverage tracked report-over-report. If the slope is flat while the cursor is not at end, the extractor is stuck — treat as an incident.
- Once cursor-at-end and delta-empty is observed, document "caught up" and keep the heartbeat for delta only.
- Delete any scrape/one-shot bootstrap path that still exists.
- If a bulk dump or cap exception arrives late, load it, then return to delta. Do not redesign.

**Exit Gate** (may be re-checked for weeks):
- [ ] Coverage has plateaued; remaining unmatched A keys are explained (true non-existence in B vs extractor hole).
- [ ] Quota waste (no-op upserts / re-fetched unchanged rows) is low enough that delta-first is actually working — or, if no delta exists, a written decision on how stale B fields are allowed to be.
- [ ] Catch-up mode and a host reboot have been rehearsed at least once.

This phase may be short (large pages, delta exists, dump arrived) or long (page size 1). Both are successful if the banner stays honest.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop and escalate — do not "keep the jobs green" — if any of the following hold:

1. **Feasibility miss**: daily cadence **and** measured page size that cannot support both freshness and any meaningful backfill **and** no delta filter **and** no bulk dump. The honest output is "this requirement is not feasible as stated," not a denser cron schedule. See [Trade-offs §4](./05_tradeoffs_and_honest_assessment.md#4-how-the-answer-changes-if-the-report-is-needed-daily).
2. **Join key is wrong or non-unique** in a way that makes the file a cartesian mess or a 0% match. Shipping it teaches the consumer garbage.
3. **Credential lockout / sustained 429** that makes remaining-week quota negligible. Pause. Ask again for a dedicated key. Do not rotate into a second unofficial client.
4. **Mirror loss without backup** after backfill had progressed. Restore or restart with the banner reset to the truth; do not ship last week's coverage number on this week's file.
5. **Pressure to omit the banner** so the file "looks finished." That request is a kill criterion for quality, not a product suggestion.
6. **Scrape promoted onto the cron path** because the API was slow. Roll that back to one-shot or delete it.

Rollback is always to the last phase whose exit gate was honestly green. After a kill, the consumer still gets the math, the coverage of whatever mirror remains, and a recommendation: wait, accept partial, or obtain a dump. They do not get a confident full join we never had.
