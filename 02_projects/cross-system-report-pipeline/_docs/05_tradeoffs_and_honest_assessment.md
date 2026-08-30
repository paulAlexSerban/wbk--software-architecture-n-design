# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone writes a for-loop.

The math, once: **100 requests/hour × 168 hours = 16,800 requests in a week.** The report wants ~50,000 System B records. If one request returns one record, a full pull cannot finish in a week. A day is 2,400 requests. Designing a live full pull is not ambitious. It is refusing to do the arithmetic.

## 1. What I would build

A **stateful warehouse-of-one**, not a "fetch both sides and join" job.

- **FTP ingester** for System A: land the nightly CSV, checksum it, archive it immutably, detect missing/late/drifted files. This is unglamorous and it is the only easy part. It is also the only complete-for-the-day source we have. Treat it with more care than it looks like it deserves (idempotency, last-good policy) and less framework than a résumé wants.
- **One rate-limited extractor** for System B: token bucket, 429/`Retry-After` observed live, checkpoint after every page. No parallelism. No second script "just to catch up."
- **A local durable mirror** (SQLite on the box, or a database we already own): System B rows, two watermarks (delta timestamp + backfill cursor), run history. This store *is* the project. Quota spent becomes rows on disk.
- **A report builder that never calls System B**: left join of tonight's A snapshot to the current B mirror, plus a banner the consumer cannot miss: coverage %, A drop identity, B watermarks, last sync time.
- **Cron** (or whatever scheduler already exists). Not Airflow. Not a new cloud account.

Bootstrap starts on day 1, not after the report code is pretty. The backfill is the long pole. Every hour of quota not used in week 1 is coverage that will not be on Friday's file.

If Phase 0 discovers a large page size *and* an `updated_since` filter, this whole system looks slightly overbuilt for the steady state. Build it anyway. The mirror is what makes "page size turned out to be 1" or "delta does not exist" survivable instead of a Thursday-night rewrite.

## 2. What I would give up

Be explicit. These are not "later." They are not in v1, and some of them are never in this design.

**Full coverage on the first report.** Unless Phase 0 shows a page size that makes 50k records fit in a few hours of quota, Friday's file is partial. Shipping it unlabeled is the actual professional failure. Shipping it labeled is the job.

**A completeness guarantee on every join row.** Unmatched A keys stay visible. Empty B fields mean "we do not have this yet," not "this entity has no B data."

**Real-time freshness.** Even in steady state, B is as fresh as the last successful delta page. The report is a snapshot of the mirror, not a live look. If the consumer needed real-time, they needed a different source team and a different budget.

**Re-fetching the full 50k every cycle.** This is the thing the prompt's math trap exists to kill. Giving it up is the design.

**New paid infrastructure, paid API tiers, warehouses, orchestrators, hosted ETL.** There is no budget. Spending calendar time procuring them is how you miss the week.

**A general integration platform.** Two sources, one join, one operator. Abstractions for "the next source" are how the extractor is not running on Wednesday.

**Trusting the brochure 100/hour.** We give up using the full theoretical 16,800. Headroom is the difference between a working key and a locked one.

**Dashboard scraping as architecture.** If a UI export exists, it may seed the mirror once ([ADR-004](./04_architecture_decision_records.md#adr-004)). It is not a weekly dependency. HTML is not an SLA.

**Silent substitution when A's file is missing.** We give up the convenience of "just run it anyway" without a label. Empty or yesterday-unlabeled is how bad decisions get made with good formatting.

**The fantasy that System B will become nice because we designed well.** They will not change anything. The design assumes that sentence is true.

## 3. What I would ask for, even though I expect a no

Ask **once, in writing, on day 1**, in parallel with Phase 0 measurement. A no (or silence) must not block the pipeline. A yes is a gift that shortens backfill, not a dependency of Friday.

Ask System B, in roughly this priority:

1. **A one-time bulk export** of the 50,000 records (CSV on the same FTP System A already uses, an S3 dump, a DB extract, anything bulk). This is the only ask that actually breaks the math trap. Expected answer: no. Ask anyway; someone on their side may already have a nightly dump they simply do not publish.
2. **An `updated_since` / cursor / changelog endpoint** if the public API does not already have one. This is what makes the mirror *stay* cheap after bootstrap. Expected: no, or "that's on the paid tier" which we also cannot have.
3. **A rate-limit exception or a dedicated credential** with a higher cap, even temporarily for bootstrap. Expected: no.
4. **Page size confirmation and whether `page[size]` is client-controllable.** This one sometimes gets a yes because it is documentation, not work. It is also the highest-leverage unknown.
5. **A webhook, changefeed, or replica.** Expected: no. If they ever say yes, the extractor becomes a consumer of that feed and the poller becomes backup. Do not design v1 around this arriving.

Ask System A (cheaper asks, still expect indifference):

6. **Filename, schedule, timezone, schema, join key, typical row count, what happens on holidays.** They may not "change anything" and still answer a question.
7. **Retention on the FTP.** If they overwrite in place and keep one file, our archive is the only history. Good to know.

Ask the report consumer (this is not a source team; this can actually get a yes):

8. **Accept a labeled-partial v1**, with coverage printed, and a trajectory ("this number should rise each week until it plateaus"). If they refuse, the remaining options are slip the deadline or ship a lie. Make them pick in public.
9. **The actual join key and the actual columns they need.** 50,000 "records" is not a schema. Fetching fields nobody will use is quota and privacy waste.
10. **Fail-loud vs last-good-A** when Tuesday's FTP file does not land on Wednesday morning.

What I would **not** ask for: that they rebuild their systems, that they waive security review for a scrape, that they stand up Kafka this week. Those asks burn goodwill and do not change Friday.

## 4. How the answer changes if the report is needed daily

The hourly cap does not change. **100/hour is still 100/hour.** Daily delivery does not grant more quota; it spends the same quota under a tighter publishing clock.

| | Weekly | Daily |
| --- | --- | --- |
| Theoretical requests per cycle | 16,800 / week | 2,400 / day |
| Time to absorb a quota-wasting bug | days, maybe until next Friday | hours, then a bad file goes out |
| Bootstrap slack | some: you can spend almost all week on backfill and still emit once | almost none: every night a report is expected while the mirror is still empty |
| Steady-state if delta exists | delta once per week (or continuous trickle, emit once) | delta must be **caught up every day** before emit |
| Steady-state if delta does **not** exist | ugly but maybe tolerable (slow re-crawl between Fridays) | ugly and likely **not** tolerable — you cannot re-crawl 50k/day |
| Quota split | backfill-heavy in week 1 | **delta reserved first every hour**, backfill gets leftovers, forever until coverage plateaus |
| Completeness as a temporary embarrassment | plausible: "partial this Friday, better next Friday" | **a permanent operating mode** until the mirror converges, which the consumer will see *every morning* |
| Missing A-drop policy | one painful Friday | a repeatedly painful morning; last-good-with-label becomes almost mandatory or the operator lives in the alert channel |

What stays the same:

- Still a mirror. Still no live full pull. The math is worse, not different in kind.
- Still one extractor, one limiter, no parallelism.
- Still ask for the bulk dump. Daily cadence makes that ask *more* justified, not more likely to be approved.
- Still label coverage. Daily reports without a banner will train the consumer to treat a climbing row count as business growth.

What I would change in the design:

1. **Hard quota split.** A daily pipeline that lets backfill starve delta will ship increasingly complete *and increasingly stale* rows — a nastier failure than a stable-fresh partial file. Delta always wins the hour; backfill drinks leftover tokens. See [System Design §3.3](./03_system_design.md#33-quota-split).
2. **Treat labeled partial as the product** until a coverage floor is met, not as a week-1 apology. Put the floor in writing ("we will not claim this is operationally complete below N% match"). Below the floor, the banner is red and the consumer has agreed what that means.
3. **Shorter stall alerts.** A watermark that has not moved in two hours during business time is an incident, not a Friday surprise.
4. **Stronger backup of the mirror.** Losing the SQLite file on a weekly pipeline costs a painful month. Losing it on a daily pipeline costs a painful month *and* twenty failed mornings in a row.
5. **Revisit the "no delta filter" case immediately.** On weekly, an ID-cursor backfill still converges and updates may rot between re-crawls. On daily, without `updated_since`, the mirror cannot stay both complete *and* fresh inside 2,400 requests. That is the point at which I would say **the requirement is not feasible as stated** and push the bulk-dump / delta-endpoint asks again, with the daily arithmetic attached. Building more cron jobs will not create requests.

What I would still not do:

- Parallel extractors.
- Scrape-every-morning.
- A paid tier we cannot buy.
- Quietly dropping unmatched A rows so the daily file "looks cleaner."

## 5. Brutal summary

The clever design is not a distributed fetcher. The clever design is **refusing to fetch 50,000 records every cycle**, telling the consumer the first file is incomplete, and spending every cheap System B request on rows we will still have tomorrow.

If page size is large and a delta filter exists, this is a small, slightly fussy batch job and the docs will look heavy relative to the code. If page size is 1 and there is no delta, this is the only design that does not lie, and even then the daily variant may be infeasible without a gift from System B.

Either way, the first report is due in a week. Start the backfill on day 1. Print the percentage on the file. Ask for the dump anyway.
