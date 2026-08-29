# Ride-Hailing Spatial Matching: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

An urban mobility platform operates across 60 major metropolitan areas. It receives location updates from 900,000 active drivers every 3 seconds (~300,000 spatial writes/sec). It must continuously calculate proximity between riders and nearby drivers, estimate arrival times, and dynamically calculate surge pricing multipliers from real-time localized supply and demand inside 500-meter hexagonal cells.

The current Redis Geospatial setup suffers from severe single-threaded CPU bottlenecks during rainstorms and peak rush hours, causing stale driver positions and delayed ride matching. Localized traffic spikes in one city degrade every other city.

The design must answer, concretely:

1. What is actually failing in Redis GEO at this write rate, and why "add replicas / add Cluster" does not fix it.
2. What you would check first, and why that check before anything else.
3. How location state, matching, and surge are redesigned so a spike in one metro cannot starve another.
4. What that redesign costs in complexity, operations, and approximation.

This is the Redis GEO trap. The naive answer — bigger Redis boxes, more replicas, a larger `GEORADIUS`, maybe Redis Cluster "because sharding" — is the failure. It treats a **single-key, single-threaded command** problem as a capacity-planning problem. Redis GEO *is* a sorted set. One key. Cluster shards *keys*, not members inside a key. Replicas take reads; they do not take `GEOADD`. One rainstorm in one city still runs on the same event loop as every other city.

The correct shape is: **discretize space into H3 hexagonal cells; store cell membership, not a global geospatial index; shard ingestion, state, matching, and surge by city; compute surge off an event log, not off the query path.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true under 300K writes/sec, hex-boundary effects, driver double-booking, position staleness, and "NYC in a downpour can still melt *its own* shard group."

## The Trap, Stated Directly

Redis Geospatial is the right API for a city-scale demo and the wrong data structure for a 60-city, 300K-write/sec location fabric.

`GEOADD` encodes lat/lng as a geohash and stores the member in a **sorted set**. `GEORADIUS` / `GEOSEARCH` walk a geohash range and filter. Complexity is roughly `O(N+log(M))` where N is members in the bounding box of the radius and M is members actually inside. In a dense downtown during a storm, N is large, the command is CPU-heavy, and **it holds the single Redis command thread for the duration**. Writes (`GEOADD` from 300K pings/sec) queue behind those scans. Scans queue behind writes. Positions go stale because the write queue is the freshness mechanism, and the write queue is stuck.

"Add Redis Cluster" does not shard that sorted set. Cluster slots are assigned to **keys**. One `drivers:geo` key lives on one slot, on one primary, on one core. You have built a cluster whose useful width for this workload is one shard.

"Add replicas" helps `GEORADIUS` only if you are willing to serve matches from replicas. Driver pings are writes. They still hit the primary. The primary is still one thread. Replica lag during a write storm is how matches start dispatching to positions that are 10–30 seconds old, which is how you send a car that already left.

"Raise the radius / cache GEORADIUS" makes each scan more expensive, or serves a cached neighborhood that is wrong the moment supply moves. Caching a proximity result is caching a moving set.

The "one city degrades all cities" clause is load-bearing. It is not a mysterious coupling. It is the same key, the same thread, the same NIC. Isolation is not a Redis configuration. Isolation is a **key design and a topology**. If city identity is not in the partition key, there is no isolation to configure.

## Scale Arithmetic (the numbers that shape the design)

These numbers are assumed as given. Phase 0 must replace them with measured ones. Until then they are the capacity story the architecture has to survive.

| Quantity | Value | Why it matters |
| --- | --- | --- |
| Active drivers | 900,000 | Size of the live location set, not the registered-user set |
| Ping interval | 3 seconds | Freshness bound: a position is already up to 3s old *before* queueing |
| Location writes | 900,000 / 3 = **300,000/sec** | This is the ingest rate. It is not the match rate. |
| Metros | 60 | Isolation units. Not 60 equal shards. |
| Average drivers/metro | 15,000 | A lie if used as a sizing number. Distribution is skewed. |
| Hot metro (assumed) | 50,000–80,000 drivers | ~17K–27K writes/sec to *one* city's keys during ordinary operation |
| Cell size | "~500 m hex" | Underspecified. See H3 note below. |
| Burst | rainstorm / rush hour | Match *reads* and ride *requests* spike. Ping rate stays ~constant unless drivers come online. The GEO bottleneck is mixed read+write CPU, not "more pings." |

**H3 note on "500-meter hexagonal cells."** H3 resolutions are discrete. Resolution 8 has average edge length ~461 m and average area ~0.74 km². Resolution 9 has average edge ~174 m. "500-meter cells" does not say whether 500 m is edge, diameter, or a slogan. This design uses **H3 resolution 8 as the matching cell** (closest standard edge to 500 m) and **resolution 7 as the surge cell** (coarser, less noisy multipliers). That split is a decision, not a product setting; see [ADR-001](./04_architecture_decision_records.md#adr-001) and [ADR-005](./04_architecture_decision_records.md#adr-005). Changing resolution does not require a new architecture; mixing matching and surge on the same noisy small cell does.

**What 300K/sec actually is.** A single Redis primary doing simple `SET`s can often exceed this on a fat box, in a benchmark, with pipelining, with no `GEORADIUS` in the mix. That benchmark is not this workload. `GEOADD` is not `SET`. `GEORADIUS` on a dense downtown is not `GET`. The 300K number is a problem because it is **concentrated on one GEO key and interleaved with heavy reads**, not because "Redis cannot do 300K ops." After the redesign, 300K is ~60 city streams of a few thousand to ~30K simple ops/sec each. That is a different machine.

**Match rate is unspecified.** Ride-request QPS is not in the prompt. A platform of this driver count is not matching at 300K/sec. Matching is bursty and city-local. Design the match path for **hundreds of requests/sec in a hot metro during a storm**, not for the ping rate. Do not size matching like ingest. Do not size ingest like matching.

## Current State (Assumed Starting Point)

A typical first version of this path looks like:

1. Driver app POSTs `{driver_id, lat, lng, timestamp}` every 3 seconds to an API.
2. The API `GEOADD drivers:geo driver_id lng lat` (and maybe `HSET driver:{id}` for metadata) on a standalone Redis, or on one logical database that every city shares.
3. A rider requests a pickup. The API `GEORADIUS drivers:geo lng lat R km WITHDIST COUNT N`, filters idle, picks nearest, assigns.
4. Surge is computed on a timer or on the request path by counting drivers in a radius and recent requests in a radius — more `GEORADIUS` / scans, same thread.

That version will appear to work in staging with 5,000 simulated drivers in one city, on a dedicated Redis, with no storm. It will fail in production the first time 60 cities share the key, the first time a downtown GEORADIUS walks tens of thousands of members during a write storm, the first time replica lag makes "nearest driver" a car that is already on a highway, the first time NYC rain inflates p99 for matching in a city that is currently in sunshine.

This project documents the replacement, not a bigger `maxmemory` on that box.

## Layer-by-Layer Fault Tree (Redis GEO, This Write Rate, Specifically)

Walk the path. At each layer, name only what fails *because the spatial index is a single-threaded global sorted set*, or *because city traffic shares that set*. Generic "Redis is down" is out of scope.

### Driver client / last mile

- **Pings are best-effort and already stale.** 3 seconds is the *intended* interval. Cellular radio, app backgrounding, OEM battery savers, tunnels, and "the driver put the phone in a cup holder on power saving" produce 10–30 second gaps on a subset of drivers. The index will always contain ghosts and holes. A faster Redis does not fix last-mile. The architecture must **expire and filter**, not pretend GEOADD is ground truth.
- **Clock skew on `timestamp`.** Device clocks lie. Server receipt time is the write clock. Client timestamp is a hint for "how old was this when sent," not a source of truth for ordering.

What this layer does *not* explain by itself: a global p99 explosion correlated with *one* city's weather. That is origin contention.

### Ingest API

- **Synchronous `GEOADD` on the request path.** Each ping is an RPC to Redis. When Redis command latency goes from 1 ms to 50 ms, the API pool saturates on location updates. *Unrelated* endpoints on the same pool (including matching) start 504-ing. Location ingest has become a denial-of-service against matching.
- **No backpressure distinction between cities.** A retry storm from one metro's drivers (mobile network blip, then everyone reconnects) is admitted into the same Redis as everyone else.

### Redis primary (the GEO key)

- **One sorted set, one slot, one core.** This is the root cause. Cluster, Sentinel, and "we have 12 nodes" are decorative if the GEO set is one key.
- **`GEORADIUS` CPU vs `GEOADD` throughput.** Heavy reads and heavy writes share the thread. During a storm you want *both*: more matches *and* continued freshness. GEO makes those two goals fight.
- **Large radius in dense cells.** Product pressure after "no cars found" is to increase R. That is how you turn a bad command into a worse command. Complexity tracks density, which is exactly what a storm increases in the cells you care about.
- **`COUNT` does not make it cheap.** Redis still searches; COUNT truncates the result. It is not a covering index.
- **Memory is not the first wall.** 900K geo members are small. Teams will look at `used_memory` and say Redis is fine. The wall is **CPU on the command thread**, which `INFO memory` will not show. Check `used_cpu_sys` / commandstats / latency histogram.

### Redis replicas

- **Replica `GEORADIUS` during `GEOADD` storm.** Replication is asynchronous. Match-from-replica is match-from-the-past. In a storm the past is exactly when you cannot afford it (supply is moving, drivers go busy).
- **Replicas do not absorb writes.** Scaling read replicas to "handle 300K" is a category error. 300K is writes.

### Redis Cluster, misapplied

- **Sharding by key, GEO as one key.** Cluster helps the moment you have *many* keys whose slots spread. A single GEO key is a Cluster anti-pattern. This is in the Redis documentation in all but those words.
- **Hash-tag mistakes.** If someone later splits to `drivers:geo:{city}` but still GEORADIUS a city of 80K members on one shard, they have bought *cross-city* isolation and still have an *intra-city* GEO problem. Isolation is necessary and not sufficient for NYC.

### Matching application

- **Read-then-write assignment.** `GEORADIUS` then `SET driver:{id} busy` is a race. Two riders get the same driver. Under storm latency the race window is larger. GEO is not a lock.
- **ETA as haversine on GEO `WITHDIST`.** Straight-line distance is what GEO gives you. Product will call it ETA. It is not ETA. Rivers, bridges, one-way downtown grids, and "the driver is on the other side of a freeway" are not geohash problems; they are routing problems. Putting a routing engine on every candidate in the hot path is how matching p99 dies a second death.

### Surge computation on the query path

- **Counting supply with another `GEORADIUS`.** Surge that scans live GEO to estimate density is a second heavy reader on the same thread you needed for matching.
- **Demand as "queries we remember in Redis."** If demand is also a hot key on the same instance, surge and matching and ingest are now three tenants of one core.
- **No hysteresis.** Raw demand/supply in a 500 m cell is noisy. Multipliers jump. Drivers and riders react. You have built a feedback oscillator and blamed Redis.

### Infra around the box

- **Vertical scaling theater.** Bigger instance → faster core → more headroom → same shape. You buy months, not an architecture. The next 20% of drivers, or the next city, returns the incident.
- **Multi-AZ Redis that still has one primary per shard.** Failover is not throughput. A failover during a storm is a storm plus a cold replica.

## What to Check First, and Why That One First

**Check first: Redis `commandstats`, latency histogram, and CPU on the GEO primary, sliced by time against a known rainstorm/rush incident, plus whether the GEO data is one key or many.**

This is a read-only check. It partitions the entire fault tree in minutes.

| What you see | What it isolates | Why it is cheap |
| --- | --- | --- |
| One key (`drivers:geo` or similar) holding ~900K members | Cluster cannot help. Stop talking about Cluster. | `INFO keyspace` / `MEMORY USAGE` / one `ZCARD` |
| `GEOADD` + `GEORADIUS` dominate `cmdstat_*` and CPU ~1 core pinned | Command-thread bottleneck, not memory, not network | `INFO commandstats`, `INFO cpu`, host CPU |
| p99 Redis latency tracks *one* city's weather/events, globally | Noisy-neighbor / shared key. Isolation is absent. | Overlay incident timeline on global matching p99 |
| Replica lag growing during the same window | Matches-from-replica are stale; writes are backing up on primary | `INFO replication` |
| API 504s on *non-location* endpoints during ping storms | Ingest is sync on the request pool | Ingress + Redis latency correlation |
| `used_memory` healthy, CPU maxed | Teams looking at memory will misdiagnose | The usual wrong dashboard |
| Per-city driver counts highly skewed | Average-per-metro sizing is a lie; NYC needs its own plan | `ZCOUNT` after a split, or app metrics if city is tagged |

**Why not "stand up Kafka" first.** Kafka does not fix a one-key GEO model if the consumer still `GEOADD`s into one key. You will have a durable outage.

**Why not "just shard GEO by city" first as the *architecture*.** It is a valid **Phase 1 stopgap** (see [Trade-offs](./05_tradeoffs_and_honest_assessment.md) and [Phased Implementation Plan](./06_phased_implementation_plan.md)). It buys cross-city isolation. It does not fix GEORADIUS inside NYC. Do not confuse the stopgap with the design. Do measure whether the incident *is* cross-city coupling; if it is, the stopgap is how you stop paging tonight.

**Second check, only after the key/CPU partition:** per-city driver counts and match QPS during the incident (so you know whether NYC is a GEO-in-one-city problem). Third: assignment races (double-dispatch tickets vs GEO latency). Fourth: how surge is computed (on-request scan vs precomputed). Fifth: ping lag distribution (p50 vs p99 of `now - last_ping`) — if p99 ping lag is already 20s, "stale positions" are not only Redis.

## Target Users

- **Owning engineer**: implements location, matching, and surge; needs a diagnosis order they can run during a storm and a design they can defend when someone asks why we are not "just using Redis GEO, that's what it's for."
- **On-call**: needs to know, from CPU and commandstats and city-tagged p99, which metro is on fire, without reproducing 80,000 drivers in staging.
- **Product / marketplace**: needs to know that ETA is approximate in the hot path, that surge is delayed by a window, and that hex edges mean "nearest car" is not a geometric guarantee.
- **Capacity / finance**: needs to know this is a multi-quarter rebuild with a Kafka + sharded Redis + stream processor bill, not a Redis instance class change.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (vehicle types, rider UX copy, which cities you launch next) are out of scope.

1. **Sustain ~300K location writes/sec with burst headroom**, without those writes sharing a single command thread with matching. Ingest and query must be separable.
2. **Proximity query in the low tens of milliseconds p99 per match** in a hot metro, including candidate fetch, not including a full road-network route through every candidate.
3. **Surge multipliers from localized supply/demand at roughly 500 m hexagonal cells**, fresh enough to react to a storm (tens of seconds, not tens of minutes), stable enough not to flicker every ping.
4. **Strict blast-radius isolation per metro.** A load spike, a hot key, a consumer lag, a Redis shard CPU peg in city A must not consume city B's ingest, match, or surge budget. Shared global resources (control planes, schema registries, the Kafka cluster *controller*) should be boring; data-plane work should not be.
5. **Horizontal scale-out without rewriting the matching algorithm.** Adding a metro, or splitting a hot metro onto more shards, is topology, not a new spatial index.
6. **Graceful staleness.** Positions older than a configured TTL are not matchable. The system does not wait for a perfect last-mile. Ghost drivers in a cell set are filtered, not trusted.
7. **Race-free driver reservation.** Two concurrent matches cannot both assign the same idle driver. "We GEORADIUS'd first" is not a lock.
8. **Match quality is "good nearby car quickly," not "globally optimal dispatch."** Batch pooling, multi-hop, and marketplace optimization are a different product.

## Success Criteria for the Design (Not Implementation Metrics)

1. A rainstorm in one metro can peg *that* metro's shard group and consumer lag without moving matching p99 in a quiet metro on a different shard group.
2. Location writes do not share a single-threaded GEO command with `GEORADIUS`. Ping ingest can be delayed (queue) without stalling the match read path on the same thread.
3. A match does not return a driver whose last write is older than the staleness TTL, even if a cell set still lists them.
4. Two concurrent match requests for the same last driver in a cell: one wins the reservation, the other proceeds to the next candidate or reports no driver — never two trips, one car.
5. Surge for a cell can be read in a single key lookup at quote time. Quote time does not `GEORADIUS` to estimate supply.
6. Adding metro #61 does not require resharding metros 1–60's location keys.
7. A forced mid-storm kill of one metro's matching pods does not drop other metros' matching availability (they do not share a worker pool sized for "global").

## Business Rules (Matching- and Surge-Scoped)

1. A driver is matchable only if `status = idle`, `last_seen` within TTL, and no live reservation.
2. Reservation is short-lived (tens of seconds). Expiry returns the driver to idle. A hung match must not tombstone a car.
3. Cell membership is derived from lat/lng via H3 at write time. The client does not send a cell id as authority.
4. Surge multiplier is computed from pre-aggregated supply/demand, capped, and smoothed. A single cell with 1 request and 0 drivers does not produce an unbounded multiplier.
5. Quote-time surge is the cached multiplier for the pickup cell (or the max of pickup cell and a small ring — a product choice). It is not recomputed from live scans.
6. City is assigned by geofence / service-area polygon at ping and at request time. A ping near a border is in one city for sharding purposes. Dual-city membership is a product exception, not the default topology.

## Non-Goals

- **Not a turn-by-turn routing engine.** OSRM / vendor routing may be called for **top-K finalists**. Building or operating a city-scale routing graph is out of scope. Approximate ETA in the hot path is in scope. See [ADR-006](./04_architecture_decision_records.md#adr-006).
- **Not globally optimal batch matching, carpooling, or "solve the assignment problem."** Greedy k-ring + rank + reserve is the v1 matcher. Marketplace science is a later consumer of the same location state.
- **Not a payments, fare, or receipts system.** Surge is a multiplier. Tax, tolls, and "what we charge" beyond that multiplier are out of scope.
- **Not full multi-region active-active.** Each metro has a home region. Cross-region active-active for 300K writes/sec of location is a different (and usually regrettable) project. Failover is regional, not "every driver dual-written."
- **Not an implementation.** No Java/Go service, no Terraform, no Redis module. Numbered steps and diagrams only.
- **Not a claim that H3 is exact nearest-neighbor.** Hex edges exist. k-ring is the mitigation. Do not advertise "the closest driver on Earth."
- **Not a claim that this is a sprint.** Replacing a GEO key with H3 cell sets is a week if you ignore ingest isolation, reservation, surge, and topology. The honest system is a multi-quarter, multi-team rebuild. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- **Not "Kafka because we are supposed to have Kafka."** The log is justified as decoupling and as the surge source of truth. If Phase 0 shows the only incident is cross-city GEO coupling at modest per-city QPS, city-sharded Redis without a log is the stopgap. That distinction is load-bearing.
