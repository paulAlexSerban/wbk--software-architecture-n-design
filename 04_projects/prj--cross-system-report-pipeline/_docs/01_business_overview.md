# Cross-System Report Pipeline: Business Overview
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Product Vision
A report, delivered on a weekly (or daily) cadence, that joins System A's nightly FTP CSV with the matching records from System B — **honestly labeled for completeness and freshness**, not presented as a full 50,000-row join that the rate limit makes impossible on the first cycle.

This is not a data platform. It is a **deadline-driven integration under hostile constraints**: neither source team will change anything, there is no budget for a paid API tier, and the first report is due in a week. The design exists to produce a usable, defensible artifact under those constraints — and to refuse to ship a report that looks complete when it is not.

## Business Context
- **System A**: drops a CSV export onto an FTP server every night. Uncooperative but cheap: the file is already there, already bulk, already on a schedule. This side of the join is not the problem.
- **System B**: HTTP API, hard-capped at 100 requests per hour, with ~50,000 records needed for the report. Uncooperative, no paid-tier budget, no promised bulk export. This side of the join *is* the problem.
- **Consumer**: whoever needs the weekly (or daily) joined report — typically a business/ops stakeholder who will treat a number on a page as a fact. That is the real risk: a silently incomplete join is worse than a late one, because it will be acted on.
- **Operator**: a single engineer (or a very small team) with one week, existing machines, and no new paid infrastructure.
- **Organizational reality**: asks to System A/B teams will be made. They will almost certainly be refused. The architecture cannot depend on a yes.

## The Math (the actual requirement)

This is the constraint that every other document in this project exists to respect. It is not a performance target. It is a hard ceiling.

| Window | Hours | Max requests at 100/hour | Records needed | Gap if 1 record/request |
| --- | --- | --- | --- | --- |
| One day | 24 | 2,400 | ~50,000 | 47,600 records short |
| One week | 168 | 16,800 | ~50,000 | 33,200 records short |
| Theoretical full backfill at 1 rec/req | 500 hours ≈ 21 days | 50,000 | 50,000 | just-in-time, no slack |

`100 × 168 = 16,800`. Fetching 50,000 records one-per-request in a week is **mathematically impossible**, even if the pipeline never sleeps, never retries, never shares the credential with anyone else, and never spends a single request on anything but the backfill.

Three load-bearing unknowns sit on top of that arithmetic and must be resolved on day 1, not guessed:

1. **Page size.** If one request returns 100 records, 50,000 records is 500 requests — doable in ~5 hours of quota. If one request returns 1 record, it is 50,000 requests — ~21 days with no slack. Page size is the difference between "tight but feasible" and "abandon full coverage." It is **not known** at design time. See [Phased Implementation Plan — Phase 0](./06_phased_implementation_plan.md#phase-0--verify-the-unknowns-day-1).
2. **Whether a delta filter exists.** An `updated_since` / `modified_after` / cursor parameter is the difference between "spend the whole quota forever catching up" and "spend a handful of requests per cycle keeping current." Unknown until the API is actually inspected.
3. **Whether the 100/hour budget is exclusive.** If other consumers share this credential, or if the window is a fixed clock-hour rather than a rolling 60 minutes, effective capacity is strictly less than 16,800/week. The limiter must observe 429s and `Retry-After`, not trust the documented number. See [System Design — Rate Limiter](./03_system_design.md#2-rate-limiter).

**The conclusion, which is not optional:** stop trying to pull all 50,000 records every report cycle. Build a persistent local mirror of System B. Backfill it as fast as the quota allows. Keep it current with whatever delta the API supports (or the poorest substitute: an ID-cursor crawl). Join System A's fresh nightly CSV against that mirror. Label every report with how complete and how stale the B side is.

## Core Value Propositions
1. **A report that exists on Friday, not a perfect report that doesn't.** The first deliverable is a joined artifact with an explicit coverage percentage, not a promise that coverage is 100%.
2. **Spend the scarce resource only on what compounds.** System B quota is the only scarce resource. Every request that fetches a record already in the local mirror is a wasted request that cannot be un-spent. The architecture is built so that, after bootstrap, almost all quota goes to *new or changed* records.
3. **System A is treated as the easy, reliable half.** Nightly CSV over FTP is unfashionable and operationally annoying; it is also already a bulk extract. Do not over-engineer it. Land it, checksum it, archive it, detect schema drift, move on.
4. **Honest incompleteness over silent incompleteness.** A stakeholder who sees "B coverage: 38%, as of 2026-09-03 04:12 UTC" can decide whether to wait. A stakeholder who sees 19,000 joined rows with no footnote will assume the other 31,000 don't exist.
5. **Zero new paid infrastructure.** The no-budget constraint is real. SQLite (or whatever database already exists), cron on a machine that already runs, local disk for the FTP archive. New SaaS, new warehouses, new orchestration products are out of scope — not because they are bad, because they cannot be bought this week.

## Success Metrics
All numeric targets below are **starting points to be calibrated once page size and delta support are known** (Phase 0), not facts.

1. **A report is delivered by the week-1 deadline**, with a completeness/freshness banner that a non-engineer can read. Missing the deadline with a better design is a failure. Hitting the deadline with an unlabeled, silently partial report is a worse failure.
2. **Quota waste rate**: fraction of System B requests in a cycle that return records already present and unchanged in the local mirror. After bootstrap, this should trend toward near-zero. If it does not, the "delta" strategy is not actually a delta strategy.
3. **Coverage trajectory**: percent of known System A join keys that have a matching System B row, tracked report-over-report. The first report may be embarrassingly low. The slope should be positive every cycle until it plateaus.
4. **Zero silent-complete reports**: every shipped artifact discloses B-side coverage and watermark. A report that omits this is treated as a defect, not a formatting miss.
5. **Operator toil**: the weekly (or daily) run is a scheduled job plus an exception alert, not a human babysitting the FTP server and clicking through an API. If it requires a human every cycle after week 1, the pipeline is not done.

## Business Rules
1. The pipeline **never** presents a report as complete unless the local B mirror's coverage of the current A snapshot's join keys meets an explicit, documented threshold — and even then, the coverage number is still printed. "Looks full" is not a completeness signal.
2. System B quota is treated as a **shared, observed budget**, not a private entitlement. The limiter backs off on 429, honors `Retry-After`, and never bursts to "use the remaining 100 at second 59."
3. Raw System A drops are **archived immutably** (the file that landed, checksummed). Re-running a report for a given date must be possible from archive + mirror state, not by hoping the FTP still has last Tuesday's file.
4. The local B mirror is the **system of record for the report**, not System B live. A report run does not fan out 50,000 live API calls. If the mirror is stale, the report says so; it does not try to catch up inside the report job.
5. Asks to System A/B teams are made in writing, once, early (Phase 0). A "no" or a silence is the expected outcome and does not block the pipeline. A "yes" is a gift that shortens Phase 4, not a dependency of Phase 3.
6. Scraping a System B web dashboard, if one exists, is a **bootstrap stopgap only** — never the steady-state source of truth, never something the join logic depends on remaining stable. See [ADR-004](./04_architecture_decision_records.md#adr-004) and [Trade-offs](./05_tradeoffs_and_honest_assessment.md).

## Pipeline Consumers
This is an internal reporting pipeline, not a product; its surface area is operational:

1. **Report consumer**: receives the joined file/dashboard with the completeness banner. This person is the reason silent incompleteness is treated as a first-class failure.
2. **Pipeline operator**: the engineer who owns cron, the SQLite file, the FTP credentials, the System B credential, and the alert when a nightly drop is missing or the limiter has been in backoff for too long.
3. **Source-system owners (uncooperative)**: System A and System B teams. They are stakeholders only in the sense that Phase 0 asks them for things; they are not in the runtime path and not in the RACI for delivery.
