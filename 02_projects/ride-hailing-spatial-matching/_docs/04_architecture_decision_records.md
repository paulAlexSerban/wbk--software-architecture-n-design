# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: H3 Hex Grid over Redis GEO / Raw Geohash / Quadtree

**Status**: Accepted

**Context**: The serving index must answer "which idle drivers are near this pickup?" hundreds of times per second per hot metro, while 300K pings/sec update positions. Redis GEO answers that with a geohash sorted set and `GEORADIUS`. That is one key, one thread, `O(N+log M)` in the bounding box, and it cannot be Cluster-sharded by member. It is the current incident.

Alternatives that look spatial:

- **Raw geohash prefixes in Redis keys**: similar to cells; rectangles, polar distortion, awkward neighbors (8-ish, uneven). Works. Worse neighbor math than hexes.
- **Quadtree / R-tree in-process**: excellent NN. Requires a bespoke location service and a replication story. Not v1 unless Redis cell sets fail on a dedicated city primary (see [ADR-004](#adr-004)).
- **PostGIS / Elastic geo_query**: disk-oriented or search-oriented. Wrong latency class for live dispatch.
- **H3**: hexagonal hierarchical index. Constant-time cell membership, cheap k-ring, compact 64-bit ids, parent/child between matching grain and surge grain. Uber published it for this problem class; the engineering reason is discrete sets + hierarchy, not the logo.

"500-meter hexagonal cells" is not a precise H3 parameter (edge vs diameter). Res 8 (~461 m edge) is the matching grain. Res 7 is the surge grain so multipliers are not one-car/one-request lottery tickets.

**Decision**: Use **H3 resolution 8** for matching idle-sets and **resolution 7** for surge keys. Neighbor search is k-ring, not radius scan. Redis GEO is not on the hot path. Exact nearest-neighbor is not a v1 requirement.

**Consequences**:
- (+) O(1) cell lookup + small set reads replace GEORADIUS on a global set.
- (+) Matching and surge can use different grains without a second spatial library.
- (+) Cell ids are partition-friendly later (`city + prefix`).
- (–) Hex edges: a nearer driver can sit in k=1. k=0-only matching is a product bug. See [System Design](./03_system_design.md#22-k-ring).
- (–) Not exact NN. Do not advertise it as such.
- (–) Wrong resolution downtown (huge sets) or in suburbs (empty cells / over-expansion) is a tuning problem. Changing resolution is a schema migration of every key. Pick 8/7 and live with them until a city-specific exception is forced by cardinality alerts.
- **Alternative rejected**: keep GEO, shard by city (`GEORADIUS` per city key). Buys cross-city isolation. Leaves NYC scanning tens of thousands of members on one thread. Valid **stopgap**, not the architecture. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- **Alternative rejected**: always res 9 (~174 m) because "finer is better." More cells, more k-ring width to cover the same pickup radius, noisier surge if reused, more Redis keys. Use when a res 8 cell cardinality alert says so, per city, as a migration — not as the default.
- **Revisit trigger**: a dedicated-city Redis primary is CPU-bound on `SMEMBERS` of huge cells *after* idle/busy is proven correct. Then finer resolution or prefix-split, not a return to GEO.

## ADR-002: City-Partitioned Isolation over One Global Cluster

**Status**: Accepted

**Context**: The scenario requires that a spike in one city must not degrade another. Today that coupling is literal: one GEO key. After H3, coupling returns if (a) all city keys live on one Redis primary, (b) one global matching pod pool, or (c) one Kafka partition for the world.

City is already a product entity (launch, regulation, pricing, geofence). Using anything finer as the *default* isolation unit (hex prefix, driver_id) over-partitions small metros and under-isolates unless you also group by city anyway.

Mechanical catch: Redis multi-key Lua for reservation needs one hash slot. Tag `{city_id}` implies **one slot per city** = one primary per city. That is enough isolation *between* cities only if those slots are **pinned to different primaries / different clusters** for dedicated metros. A 3-node Cluster with 60 hash tags is not 60 isolation domains. See [System Design §3.1](./03_system_design.md#31-same-slot-invariant-for-reservation).

**Decision**:
- **Isolation unit = metro.** Kafka partition key `city_id`; matching routed by city; surge keyed by city; Redis hash tag `{city_id}`.
- **Topology:** dedicated Redis (primary+replica, or dedicated Cluster) for top ~10–15 metros; shared Cluster for the long tail, still tagged by city.
- **Escalation (not v1):** split a mega-city by H3 coarse prefix when *that city's* primary is the wall.
- **Not in v1:** multi-region active-active for pings. Each metro has a home region.

**Consequences**:
- (+) Blast radius of a rainstorm is that metro's hardware and consumer lag, if topology is honest.
- (+) Adding metro #61 does not rehash 1–60.
- (+) On-call can page a city, not "Redis."
- (–) One primary per city can still melt NYC. City sharding is necessary, not sufficient. Escalation is documented, not built.
- (–) Pooled tail metros share primaries; two "small" cities can still noisy-neighbor. Promotion to dedicated is the fix.
- (–) Border pings: one city only. Dual-write is how you double-match and double-count surge. Dead-letter + geofence hygiene instead.
- (–) Slot-aware Lua constrains how far we can split a city without a new apply protocol.
- **Alternative rejected**: global Redis Cluster, hash tags only, "Cluster will spread us." Spreads keys; does not pin cities to hardware. Isolation theater.
- **Alternative rejected**: shard by H3 cell globally, ignore city. A downtown hex in two product cities (borders) and a ops story with 60×N cell queues. City is the business unit; keep it the technical unit.
- **Alternative rejected**: active-active location in two regions. Conflict-free 300K/sec geo state is a research paper. Home-region failover is enough.
- **Revisit trigger**: isolation drill fails (Phase 5). Do not proceed with GEO retirement. Fix topology.

## ADR-003: Event Log Decouples Ingest from Serving State

**Status**: Accepted

**Context**: Synchronous `GEOADD` on the ping HTTP path couples API worker occupancy to Redis command latency. When GEO melts, ping ingest melts, then matching on the same pool melts. Even after H3, 300K `HSET`s/sec *on the request path* will still couple worker pools to Redis p99.

A log (Kafka) turns ping accept into "appended" and lets apply consumers absorb Redis slowness as **lag**, which matching already treats as staleness (TTL). The same log is the demand/supply feed for surge ([ADR-005](#adr-005)) without a second scrape of Redis.

Cost: Kafka is an operational product. 300K msg/sec is fine; retention, ACLs, and "why is consumer lag" are new incident types.

**Decision**: Target architecture publishes pings (and ride_requests) to **Kafka partitioned by city_id**. Location apply and surge consume. Matching does not. Phase 1 may still write Redis from the API as a **stopgap** if Phase 0 says tonight's page is cross-city GEO coupling and Kafka is months away — but that stopgap is not the architecture, and it must not reintroduce GEO.

**Consequences**:
- (+) Ping API p99 independent of city Redis CPU.
- (+) Replay for surge and for rebuild-after-wipe of a city Redis.
- (+) Backpressure is consumer lag, isolated per city partition, instead of HTTP 504 storms.
- (–) New system: Kafka. On-call surface area grows. This is most of the *platform* cost of the redesign.
- (–) Matching reads a store that lags the world by apply time. Honest; already true with replica GEO, now explicit.
- (–) Produce failures: ping dropped until next 3s interval. Do not GEOADD-fallback; that is how the old path never dies.
- **Alternative rejected**: sync Redis writes forever, "H3 is enough." H3 fixes scan shape. It does not uncouple HTTP from Redis. At 300K/sec, the log is justified. At 30K/sec, maybe not — Phase 0 numbers.
- **Alternative rejected**: matching consumes Kafka per request (event sourcing dispatch). Wrong tool; you cannot k-ring a log on the hot path.
- **Revisit trigger**: Phase 0 measured global ping rate is far below 300K and Redis HSET p99 is flat. Then Kafka may be Phase 2+ or skipped until surge needs it. Do not skip the log *and* build streaming surge; surge then needs another source of truth.

## ADR-004: Restructured Redis Cluster as Location Store; Bespoke In-Memory Service as Escalation Only

**Status**: Accepted

**Context**: Serving "idle drivers in these 7 cells" with sub-10ms reads is an in-memory set-membership problem. Redis can do that if the keys are small sets and hashes, not GEO. Building a custom location VM (ring buffers, CRDTs, GPU, etc.) is a company.

Teams in this scenario often jump to "we need a geospatial database / we need to rewrite Redis." Usually they needed a different **key schema** and **topology**.

Limits of Redis here: one primary per city ([ADR-002](#adr-002)); set ghosts ([System Design](./03_system_design.md)); single-threaded command execution *per city primary*. If NYC dedicated Redis is CPU-capped on simple HSET/SADD at ~27K pings/sec, something else is wrong (pipelining, too many round trips, huge sets) — 27K simple ops is normally comfortable. If it is *not* comfortable after profiling, prefix-split or a bespoke service is on the table.

**Decision**: v1 location store is **Redis with cell sets + driver hashes + reservation keys**, no GEO, dedicated instances for hot metros. A custom in-memory location service is **not started**. Revisit only with profiles from a dedicated city primary.

Sorted-set-by-timestamp cells vs sets+lazy-SREM: default **sets + lazy SREM** (common case is ping-in-same-cell = HSET only). Switch to ZSET if ghost cardinality is the incident.

**Consequences**:
- (+) No new datastore product. Staff already operate Redis.
- (+) Lua reservation on one slot is a known pattern.
- (–) Redis semantics leak into architecture (hash tags, slot, TTL ≠ set membership). Engineers must read [System Design §3](./03_system_design.md#3-redis-key-layout).
- (–) One-thread-per-city remains. Isolation is horizontal across cities, not infinite vertical for NYC.
- **Alternative rejected**: RedisGEO per city as the destination architecture. Stopgap only.
- **Alternative rejected**: RedisJSON / Redis Stack geospatial modules as a "smarter GEO." Same single-key gravity unless you still cell-shard.
- **Alternative rejected**: build the custom service in parallel with H3 "because Uber has one." Résumé-driven. Uber's H3 *library* is the portable part; their dispatch stack is not a week of work.
- **Revisit trigger**: documented CPU ceiling on a dedicated city primary with small sets and pipelined apply, after prefix-split is also measured. Then a purpose-built location process can own that city.

## ADR-005: Streaming Windowed Surge over On-Demand Computation

**Status**: Accepted

**Context**: Surge needs localized supply/demand in ~500 m class cells. Computing it at quote time with `GEORADIUS` or with `SCARD` of a k-ring on the request path either (old) melts Redis or (new) couples quote QPS to a scatter of set cardinalities and produces flicker (1 request / 0 drivers).

Precomputation with a trailing window, a **coarser** surge cell (res 7), caps, and hysteresis turns quote into a GET. Duplicate ride_requests must not infinitely heat a cell (`request_id` in window). Supply from periodic `SCARD` snapshots of child matching cells, not from ping unique-counts that miss silent-but-fresh drivers.

**Decision**: Surge aggregator consumes Kafka (`ride_request` + snapshots or ping-assisted supply). Writes `{city}surge:{h3_res7}` with TTL. Quote/match **GET** only. Multiplier bounded (working cap 3.0). Smoothing required. Fail-open to 1.0x on miss by default, with an alert; product may fail-closed in writing.

Demand is **requests**, not completed matches, so "no cars" still raises price (the actual signal of shortage). Confirm with marketplace; if they want matches-only, the signal lags and under-surges the moment you cannot dispatch.

**Consequences**:
- (+) Quote path cannot melt location Redis.
- (+) Caps prevent bot-driven infinity.
- (–) Multiplier is delayed by window T and aggregator lag. "Instant surge" is marketing. Storm response is tens of seconds to minutes.
- (–) Always-on stream processor cost.
- (–) Marketplace will fight the curve forever. Architecture owns bounds and isolation, not the perfect function.
- (–) Fail-open 1.0x during outage is a revenue/integrity hole; fail-closed is a UX outage. Must be a written choice in Phase 4.
- **Alternative rejected**: quote-time live counts. Recreates the scan; flicker.
- **Alternative rejected**: surge at res 8 as the binding price. Too noisy. Heatmaps may still render res 8.
- **Alternative rejected**: city-wide surge only. Violates the scenario's localized 500 m requirement and overprices quiet neighborhoods next to a stadium.
- **Revisit trigger**: abuse (request bots) surviving rate limits. Then demand must be authenticated-and-budgeted more aggressively; the aggregator is not the whole integrity model.

## ADR-006: Approximate ETA in the Match Hot Path; Routing Engine for Top-K Only

**Status**: Accepted

**Context**: Product will call haversine "ETA." It is distance. GEO `WITHDIST` was the same lie. A real routing engine (OSRM, vendor) is correct near rivers and one-way grids and is **too expensive/slow** to run on every k-ring member under storm QPS.

Accuracy vs latency: rank ~8–20 candidates with haversine × city speed factor; optionally re-rank top 3–5 with routing under a tight timeout; degrade to approximate on timeout.

**Decision**: v1 matching ranks by **approximate ETA** only. Routing engine integration is **optional Phase 3+**, default off, per-city enable for documented shame cases, K ≤ 5, timeout ~20 ms, no blocking of reservation on the engine.

This project does **not** build a routing graph.

**Consequences**:
- (+) Match p99 stays a Redis problem, not a matrix-API problem.
- (+) Cities without rivers do not pay.
- (–) Some matches will send a "near" car that is 12 minutes away on the road. Support must know. A "closest driver" legal/marketing claim is false.
- (–) Speed factors need calibration; a wrong factor is a systematic bias, not noise.
- **Alternative rejected**: route every candidate. p99 death, vendor bill, storm amplification.
- **Alternative rejected**: no distance at all, pick random idle in k=0. Undercuts marketplace trust for a small latency win. Haversine is cheap.
- **Not in v1:** live traffic in the hot path. That is another product.
- **Revisit trigger**: a city where haversine vs actual pickup-time error is measured and unacceptable, *and* routing at K=5 fits the p99 budget in a storm drill. Then enable for that city.
