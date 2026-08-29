# Architecture Decision Records

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Delta-and-Mirror over Full-Pull-per-Cycle

**Status**: Accepted

**Context**: The report needs ~50,000 System B records. The API allows 100 requests/hour. A week yields at most 16,800 requests; a day yields 2,400. A design that fetches the full population every cycle is arithmetically impossible at 1 record/request and still a poor idea even if page size is larger, because it re-spends quota on records already known. The obvious alternative — "just pull everything live when building the report" — is the design that fails the interview and the deadline.

**Decision**: Do not full-pull System B on each report cycle. Persist a local mirror. Populate it with a one-time (slow) backfill. Keep it current with `updated_since` (or equivalent) when the API offers it; otherwise crawl a stable ID cursor **once through the population**, then only probe for new high IDs. The report reads the mirror, never System B.

**Consequences**:
- (+) Makes a week-1 artifact possible at all; coverage can be incomplete and still increase every cycle.
- (+) Steady-state quota cost can collapse to "how many B rows changed since last sync" rather than "how many B rows exist."
- (–) Week-1 report is not a full join. That is disclosed, not hidden ([ADR-006](#adr-006)).
- (–) If there is no delta filter, steady-state remains expensive: the mirror still converges, but catching *updates* to already-mirrored IDs requires either a periodic full re-crawl (re-introducing the math trap) or accepting stale B fields. This is the worst realistic API shape and must be escalated as an ask, not papered over.
- **Alternative rejected**: fan-out N parallel clients to beat the cap. The cap is almost certainly per credential (or per IP). Parallelism gets 429s faster, not more data.
- **Revisit trigger**: System B grants a bulk dump, replica, or cap exception. Use the gift to catch the mirror up; do not switch the report job to live pulls.

## ADR-002: Local Durable Store as System of Record (Warehouse-of-One), not a Cache

**Status**: Accepted

**Context**: A cache in front of System B would still miss on the cold 50,000 and then try to fill from a source that cannot fill it in time. Caches also invite TTL thinking ("refresh every report"), which is the full-pull in a trench coat.

**Decision**: The local store (SQLite or an already-owned database) is the system of record *for this report*. System B is a replenishment source. Cache-style TTLs are forbidden on B rows. A row stays until a later fetch upserts it. Losing the store means re-paying the entire backfill in quota and calendar time; the store is backed up with whatever backup the box already has.

**Consequences**:
- (+) Quota spent becomes an asset (a row on disk) rather than an expense that evaporates when the process exits.
- (+) Report generation is a local join: fast, replayable, independent of System B's uptime at emit time.
- (–) The operator now holds a copy of System B's data and the compliance/privacy burden that comes with it.
- (–) Stale B fields are possible, especially without `updated_since`. Freshness is printed on the report rather than solved.
- **Alternative rejected**: keep pages in memory / temp files for one job run. A crash or a week-boundary kills the investment.

## ADR-003: Token Bucket with Observed-429 Backoff, not Sleep-36 or Clock-Hour Dump

**Status**: Accepted

**Context**: 100/hour can be implemented as `sleep(36)` between calls, as 100 requests at `HH:00`, or as a token bucket that refills smoothly and additionally respects 429/`Retry-After`. The first two ignore shared credentials, rolling vs clock windows, and the fact that the documented cap is marketing until proven.

**Decision**: One extractor process, one token bucket, smooth refill, small or zero burst, empty-bucket-on-start after a crash (wait rather than guess remaining quota). 429s tighten the assumed ceiling until a clean hour is observed. Rate-limit response headers, when present, override the local bucket if stricter. See [System Design §2](./03_system_design.md#2-rate-limiter).

**Consequences**:
- (+) Survives the (likely) case that we are not the only user of the key, and the (possible) case that their limiter is per-minute or rolling.
- (+) Avoids a post-crash stampede.
- (–) Will not use 100% of the theoretical 16,800/week. Good. Headroom is cheaper than a locked credential the day before the deadline.
- **Alternative rejected**: distributed rate limiter / Redis token bucket. There is one process and no budget for new infra.

## ADR-004: HTTP API as Steady-State Source; Dashboard Scrape as Bootstrap-Only Last Resort

**Status**: Accepted

**Context**: If the API cannot supply 50,000 records in a week, an existing web dashboard or CSV-download button in a UI is the usual "hints" escape hatch. Scraping works until the first markup change, often violates TOS, often authenticates as a person, and trains the pipeline on a source nobody will support.

**Decision**: Steady-state extract is the HTTP API only. A dashboard scrape or manual UI download is permitted **only** as a Phase 0/1 bootstrap to seed the mirror if (a) it exists, (b) it can be done without pretending it is supported, and (c) it is isolated behind a one-shot loader that does not sit on the cron path. It is scheduled for deletion once the API backfill catches up or a bulk dump is granted.

**Consequences**:
- (+) Does not bet the weekly job on HTML.
- (+) Still allows the one thing that can break the math trap on day 1 if a bulk-shaped UI export exists.
- (–) Bootstrap may still be slow if no such UI exists — which is the expected case.
- **Ask anyway**: a one-time CSV dump on the same FTP as System A. That is the actually good version of this idea.

## ADR-005: Cron on Existing Infrastructure, no New Orchestrator

**Status**: Accepted

**Context**: Airflow, Dagster, Step Functions, managed ETL, etc. would be the "proper" answer in a company that already runs them. This scenario has no budget, one week, and two jobs plus a report. Introducing an orchestrator is a second project that does not fetch a single extra System B row.

**Decision**: Schedule with cron, a systemd timer, or the job scheduler already on the box. State lives in the store and the archive, not in the scheduler. Alerts reuse whatever channel the operator already gets paged on (email, Slack webhook, `mail` from cron).

**Consequences**:
- (+) Week-1 calendar is spent on Phase 0 unknowns and the extractor, not on deploying a scheduler.
- (–) DST, host reboots, and "the cron daemon was not running" will eventually happen. Acceptable. Document the jobs in the phased plan; do not abstract them.
- **Revisit trigger**: the operator already has a working orchestrator. Then use that, with the same job boundaries — do not shop for a new one.

## ADR-006: Ship a Labeled-Partial v1 on the Deadline, rather than Slip for 100% Coverage

**Status**: Accepted

**Context**: Stakeholders asked for "the report" in a week. The math says full B coverage may be impossible in that week. Two failure modes compete: (1) miss the deadline building a perfect pipeline, (2) hit the deadline with a number that looks complete and is not.

**Decision**: The week-1 deliverable is a joined artifact **with a mandatory completeness/freshness banner**. Coverage may be far below 100%. That is a successful Phase 3. An unlabeled report is a failed Phase 3 regardless of coverage. Brief the consumer on day 1 with the math, not on Friday with a surprise percentage.

**Consequences**:
- (+) Aligns engineering with arithmetic and with how the artifact will actually be used.
- (+) Makes Phase 4 (ongoing backfill) visible: each subsequent report should show a better coverage number until it plateaus.
- (–) The consumer may reject a partial report. That is a business decision they can make *after* seeing the math. Building in silence and hoping coverage magically hits 100% on Thursday is how trust dies.
- **Alternative rejected**: delay the first report until the mirror is complete. If page size is 1, that delay is ~21 days with no slack, which violates the stated deadline and still assumes exclusive, perfect quota use.

## ADR-007: Left Join from A, with Coverage as a First-Class Output Column/Sidecar

**Status**: Accepted

**Context**: Join type changes the meaning of the report. Inner join hides unmatched A keys. Full join mixes questions ("what did A do last night" vs "what exists in B"). The business asked to join A's export with B's records; A is the complete nightly snapshot, B is the constrained side.

**Decision**: Default is a left join from the current A snapshot to the B mirror on the Phase-0-confirmed join key. Unmatched A keys remain in the output (or in a companion unmatched file) and feed `coverage_pct`. Inner join is forbidden as the only shipped grain. See [System Design §6](./03_system_design.md#6-join-logic).

**Consequences**:
- (+) The consumer can see *which* A entities are missing B, which is the only actionable view of incompleteness.
- (–) The file contains rows with empty B fields. That is the point; it must be explained in the banner so nobody "fills them in" by hand from tribal knowledge and then treats the file as sourced.
