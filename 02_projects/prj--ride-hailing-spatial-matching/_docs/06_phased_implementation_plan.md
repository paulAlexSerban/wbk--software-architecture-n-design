# Ride-Hailing Spatial Matching — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not "we already know it's GEO."** Building Kafka against a guessed root cause is how you ship consumer-lag pages on top of an untouched single GEO key. Later phases close isolation, reservation, and surge; cutting over without them is allowed only when Phase 0 proved those gaps were not the incident — and even then GEO retirement has a date.

Rollback/kill criteria at the bottom apply at every phase.

Calendar is not a two-week death march unless the incident is. A realistic Phase 0 is days. City-sharded H3 on dedicated hot-city Redis (Phase 1) is weeks. Kafka + matcher + surge + per-metro cutover is **quarters**. Do not compress Phase 5 by skipping an isolation drill. Do not rename the GEO stopgap as "the architecture" to hit a quarter-end.

## Phase 0 — Diagnose and Confirm (before any redesign work)

**Objective**: Name what is actually failing, with Redis and traffic evidence, and decide whether this project is a full H3+Kafka+surge rebuild, a city-isolation stopgap, a reservation-only fix, or a capacity false alarm. Replace "Redis GEO melts in the rain" with a partitioned fault tree. See [Scenario — What to Check First](./01_scenario_and_requirements.md#what-to-check-first-and-why-that-one-first).

**Deliverables**:
- `INFO commandstats`, latency histogram, CPU (`INFO cpu` + host), replication lag, for the GEO primary, during a known storm/rush *and* a quiet window.
- Key proof: is live location **one GEO key** (or a handful) or already split? `ZCARD` / `MEMORY USAGE` / key name list.
- Per-metro: driver counts, ping QPS, match QPS, matching p99, overlayed on the incident. Correlation: global p99 vs one city's weather.
- How matching assigns today (read-then-write vs lock). Double-dispatch ticket count vs Redis p99.
- How surge is computed (live GEO/scan vs precompute).
- Ping freshness: p50/p99 of `now - last_ping` (last-mile vs Redis delay).
- Product numbers: max k / max pickup minutes; "closest driver" claims; surge miss policy; demand = requests vs matches.
- Topology: can top metros get dedicated Redis and matching pools? Written yes/no.
- A one-page "unknowns log": each failure mode `observed`, `ruled out`, or `still open`. Open items that change the design (no dedicated hardware; ping rate is 30K not 300K) flagged immediately.

**Exit Gate**:
- [ ] Root cause(s) named with evidence — commandstats + key count + city correlation — not "probably GEO."
- [ ] Go/no-go branch (all are successful Phase 0 outcomes):
  - **A. Full rebuild** (Phases 1–5): one-key (or one-primary) GEO, storm CPU, cross-city coupling, and/or surge-on-query-path, at scale in the same order as the prompt.
  - **B. Stopgap isolation** (Phase 1 only, Kafka deferred): coupling is real, hottest-city `GEORADIUS` still cheap, ping rate modest. City-split keys ± dedicated NYC Redis. Revisit Kafka when numbers move.
  - **C. Reservation-only**: GEO is fine; double-dispatch is the bug. Lua on current index. Stop this project.
  - **D. Wrong incident**: memory, network, app pool, last-mile p99 already 30s. Do not rebuild the index to fix those.
- [ ] If A or B: dedicated-hardware answer is written. If no, isolation language is stripped from the design review.
- [ ] STALE_S informed by measured ping gaps, not only the 15s default.

Do not "stand up Kafka in parallel" before this gate. Parallel is how the wrong system gets a head start.

## Phase 1 — City-Sharded H3 Cell Sets (no streaming required)

**Objective**: Prove cell membership + city topology beat GEORADIUS *shape* and, if hardware was granted, beat cross-city coupling — **without** taking Kafka as a dependency yet.

**Deliverables**:
- H3 res 8 idle-sets + driver hashes; apply from the **existing** ping API (sync Redis write is accepted in this phase).
- Hash tag `{city_id}`; dedicated Redis for at least one hot metro and one quiet metro (or a dedicated test shard that production cities can fail over onto).
- Matching **read path** can query cell sets (flagged); write path may still assign the old way until Phase 3 — or dual-run reads for comparison only.
- Cardinality alerts on cell sets. Lazy SREM on missing/stale hashes.
- Old GEO path still default for assignment.
- Per-city metrics: CPU, ops/sec, matching *read* p99 on the new index (shadow).

**Exit Gate**:
- [ ] Shadow match on the new index returns a candidate set that is "nearby" on sampled trips (manual or offline compare vs GEO), with documented hex-edge misses at k=0 that **shrink at k=1**.
- [ ] Hottest dedicated city Redis CPU during a replay/storm drill is dominated by HSET/SADD, not GEORADIUS. GEO may still run if not shadowed off.
- [ ] Quiet city's Redis CPU does **not** track the hot city's load if they are on different primaries. If they share a primary, **do not claim isolation**; record as topology fail, fix allocation, re-run.
- [ ] Cell cardinality in expected bounds (not thousands of "idle" downtown unless true). If thousands, idle/busy is wrong — do not proceed to Kafka.
- [ ] Phase 0 branch B may **stop here** as the production stopgap: cut matching reads+writes to city H3 or even city-GEO, keep GEO retired per city, skip Phase 2 until justified. That stop must be written, with revisit triggers (HTTP coupling, surge scans, CPU on dedicated primary).

If shadow quality is garbage (wrong city geofences, wrong resolution), **do not start Phase 2**. A log will faithfully apply garbage faster.

## Phase 2 — Event-Streaming Ingest

**Objective**: Decouple ping HTTP from city Redis CPU; give surge a log. Required for Phase 0 branch A. Optional/deferred for branch B.

**Entry Gate**: Phase 1 exit green. Phase 0 still shows ingest-HTTP coupling or a 300K-class write rate or surge-from-log need.

**Deliverables**:
- Kafka topics `driver_location`, `ride_request` (the latter may be produced as a stub until Phase 3/4).
- Partition by `city_id`; mega-city sub-partition plan documented if one partition is already hot in load test.
- Ingest API produces, returns 204 without waiting for apply.
- Location apply consumer: LWW, membership move, **does not let pings clobber reserved/busy**.
- No GEOADD fallback on produce failure.
- Dashboards: produce rate, apply lag vs STALE_S, per city.

**Exit Gate**:
- [ ] Load test at the Phase 0 measured (or prompt) ping rate for at least the hottest city + one pooled city, sustained, apply lag << STALE_S after catch-up, lag isolated (hot city lag does not grow quiet city lag).
- [ ] Kill Redis for city A for 60s: ingest still 204s; city B apply unaffected; city A lag recovers without poison-pilling the cluster.
- [ ] Out-of-order ping fixture: older `server_ts` does not overwrite.
- [ ] Produce-fail path: no GEO write in logs.

If Kafka cannot be operated at this rate, **do not pretend Phase 3 is independent**. You can still match on Phase 1 sync writes; you cannot honestly start streaming surge.

## Phase 3 — Matching and Reservation on the New Index

**Objective**: Production matching uses k-ring + Lua reserve. Double-dispatch dies. GEO assignment is no longer the default on flagged cities.

**Deliverables**:
- Matcher: city route, k-ring, hydrate, filter stale, haversine rank, Lua WIN/LOST, next candidate, reservation TTL.
- Confirm-trip handoff: reserved → busy, idle-set empty for that driver.
- Flag per metro. Start with a **small** metro, then a medium, then a hot one.
- Drill: two concurrent matches, one idle driver in cell → exactly one WIN (observed).
- Drill: matcher killed after WIN → driver returns to idle before TTL + epsilon, not forever.
- Ride_request events emitted at request time (for Phase 4).
- Routing engine **off** unless a shame-city exception is already funded.

**Exit Gate**:
- [ ] Double-book drill cannot produce two trips, one driver.
- [ ] Forced reservation TTL restores idle and SADD.
- [ ] Ping-during-reserved cannot SADD idle (fixture).
- [ ] Flagged small metro: no-driver rate and pickup-time error vs GEO baseline are understood (may be *different*; hex edges). Product accepts before hot-metro flag.
- [ ] Match p99 on flagged city is Redis+app, not a city-wide scan. Tracing shows SMEMBERS of a handful of cells.

Do not flag NYC because the small city was fine. NYC is a different cardinality.

## Phase 4 — Surge Pricing Pipeline

**Objective**: Quote and match read a precomputed, capped multiplier. No live scans.

**Entry Gate**: `ride_request` events exist (Phase 3). Supply snapshots (SCARD of child cells) exist. Product has signed demand definition and miss policy.

**Deliverables**:
- Aggregator: window T, res 7 keys, smoothing, cap, request_id dedup.
- Surge Redis keys TTL-refreshed; quote GET; miss = signed policy.
- Rate limits on request events per rider / per cell (integrity minimum).
- Drill: aggregator down → miss policy fires, alert fires, matching still dispatches.
- Drill: synthetic request spike in one cell → multiplier rises **bounded**; neighbor quiet cell on another surge key does not jump the same amount; other **city** unchanged.

**Exit Gate**:
- [ ] Quote path has zero GEORADIUS / zero k-ring SCARD in traces.
- [ ] Multiplier never outside cap in a 24h soak including a synthetic spike.
- [ ] Miss policy drill observed.
- [ ] Marketplace has a knob-runbook (caps, T, hysteresis) that does not require matcher deploys.

If product will not sign miss policy, **do not fail-open silently**. Block this gate.

## Phase 5 — Cutover and GEO Retirement

**Objective**: Default all metros to the new path. GEO keys gone on a calendar date. Isolation is demonstrated, not inferred from hash tag names.

**Deliverables**:
- Per-metro rollout order: small → medium → remaining dedicated hots → pooled tail. One metro at a time with a soak.
- Isolation drill (production-safe): load generator on metro A (pings + matches) at storm-class QPS; **canary match p99 on metro B** (real quiet city or synthetic) stays within pre-test band. If B moves, **stop the rollout**, fix topology (shared primary, shared pod pool, Kafka hot controller — name which).
- GEO write path flagged off per city after soak; then `RENAME`/`DEL` GEO keys; then 410 any leftover GEO helper.
- Support note: nearby ≠ closest; ETA approximate; surge lagged; "NYC rain will still suck in NYC."
- Runbook: promote pooled city to dedicated Redis; STALE_S; reservation TTL; surge miss.

**Exit Gate**:
- [ ] Isolation drill green for at least one dedicated pair (hot vs quiet) and one pooled-vs-dedicated pair.
- [ ] GEO keys absent; commandstats show no `geoadd`/`georadius` in location/match paths.
- [ ] Per-city SLOs are the official matching SLOs; global average is not used for paging.
- [ ] Time-box date for GEO helper removal is in the past, not "when we are sure."
- [ ] Phase 4 live or a written acceptance that surge still uses an old non-GEO method. Do not delete GEO if surge still reads it.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop, roll the city flag back, or kill the broader rebuild — do not "keep NYC on H3 to see if it settles" — if any of the following hold:

1. **Phase 0 says C or D.** Proceeding to Kafka/H3 anyway is résumé-driven. Kill; do the small fix.
2. **Phase 0 says B and Kafka is in flight anyway** because the prompt mentioned streaming. Stop Phase 2; operate Phase 1; revisit.
3. **Isolation drill fails.** Do not roll the next metro. Do not retire GEO globally. Hash tags without hardware are a failed gate, not a "known issue."
4. **Double-book observed in production on the new path.** Roll flag off that city. Phase 3 is not green. GEO (with its own races) is not automatically better — but a new race plus hex misses is a worse week.
5. **Quiet-city p99 regresses when a hot city is flagged** (coupling reintroduced at app pool or Cluster primary). Roll hot city off. Fix topology.
6. **Cell cardinality thousands and dispatching ghosts.** Idle/busy/TTL bug. Do not add Kafka consumers to a dirty set.
7. **GEO fallback re-enabled in a storm.** Treat as an incident and a kill of the retirement story until the fallback is physically gone.
8. **Pressure to expand k until metro-wide** or to "just GEORADIUS if k-ring empty." That request is a kill criterion for the index shape, not a resilience feature.
9. **Pressure to skip Lua because it's slow.** Then you kept double-dispatch. Kill Phase 3 quality, not the Lua.
10. **Dedicated hardware refused after promising isolation.** Strip the claim; do not run Phase 5 isolation gate as theater.

Rollback is always to the last phase whose exit gate was honestly green — typically "flag off this metro, previous path default." After a kill, the honest output is the Phase 0 diagnosis plus whatever city-split or Lua fix is justified. The output is not a half-enabled matcher that still GEORADIUS the world when the flag is off, undocumented, with Kafka producing to nowhere.
