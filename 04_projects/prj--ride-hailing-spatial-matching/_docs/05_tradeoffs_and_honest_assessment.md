# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone stands up Kafka.

The expected answer is four words: **H3 cells, city-sharded**. Those four words are correct. They are not free. Redis GEO on one key is the anti-pattern; listing `GEORADIUS` complexity is diagnosis, not design. This page is the cost of the design — and the cheaper thing that is sometimes enough.

## 1. What I would build

A **city-isolated location fabric**, a **greedy matcher with a real lock**, and a **precomputed surge cache**.

- **H3 res 8 idle-sets + driver hashes** on Redis, **no GEO**. Lazy ghost filter. [ADR-001](./04_architecture_decision_records.md#adr-001), [ADR-004](./04_architecture_decision_records.md#adr-004).
- **Dedicated Redis primary+replica for the top metros**; pooled Cluster for the tail; hash tags are not isolation if NYC and Cleveland share a core. [ADR-002](./04_architecture_decision_records.md#adr-002).
- **Kafka** for pings and ride_requests, partitioned by city, so ingest HTTP does not share Redis CPU with matching, and surge has a log. [ADR-003](./04_architecture_decision_records.md#adr-003).
- **Matcher**: k-ring (k=0..2, k=1 is not optional for quality), haversine ETA, **Lua reservation** that pings cannot clobber. [ADR-006](./04_architecture_decision_records.md#adr-006).
- **Surge**: res 7 windows, capped, smoothed, GET at quote time. [ADR-005](./04_architecture_decision_records.md#adr-005).
- **Phase 0 metrics** before any of the above is "the rewrite." Commandstats, one-key proof, per-city density, ping-gap p99.

I would not "upgrade Redis" as the fix. I would read it in Phase 0 so I know what is failing *today*, then stop treating GEO as architecture.

If Phase 0 shows the failures are *only* cross-city noisy neighbor, per-city driver counts are modest (low thousands), and `GEORADIUS` inside the hottest city is still cheap, **city-sharded GEO or city-sharded H3 sets without Kafka** is the stopgap. The four-word answer is for when 300K writes, storm-time scans, surge-on-the-query-path, and double-dispatch are real. Be honest about which incident you are in.

## 2. What I would give up

Be explicit. These are not "later." They are not in v1, and some of them are never in this design.

**The simplicity of one Redis box and `GEOADD`/`GEORADIUS`.** That API fit in a developer's head. The replacement is a log, apply consumers, key schemas, Lua, k-ring, two H3 resolutions, city topology, and a stream processor. On-call who could `redis-cli` a radius cannot debug consumer lag with a one-liner. Train them or you will GEO-fallback at 3 a.m.

**Exact nearest-neighbor.** H3 + k-ring + haversine is "nearby," not "closest on Earth," not "closest on the road." Hex edges are real. Rivers are real. If legal/marketing need "closest," they are asking for a different system (and still not getting it under a 3s ping).

**Freshness tighter than ping interval + apply lag.** Positions are stale by construction (3s) plus queueing. TTL manages ghosts; it does not make the map true. A faster index does not fix OEM battery savers.

**Synchronous "the ping is in Redis before 204."** The log accepts; Redis follows. Matching may not see the ping that was just sent. That is the decoupling you asked for.

**One global matching SLO.** Averaged p99 will look healthy while NYC burns. You give up a simple dashboard. Per-city SLOs are the product.

**Infinite isolation from hash tags on a shared Cluster.** Isolation is hardware assignment. The long-tail pool still shares fate. NYC dedicated still melts *NYC*.

**Instant, perfectly localized surge.** Windowed, coarser than matching, capped, lagged. 500 m *binding* prices flicker or get gamed. Heatmaps can be pretty; the multiplier is res 7.

**Globally optimal dispatch, pooling, batch matching.** Greedy k-ring + reserve. A storm is when greedy is *more* defensible (you need a car now), not when you should ILP the city.

**A routing company.** Top-K OSRM is a later city exception. v1 haversine will embarrass you next to a river. Accept it or schedule the exception, do not boil the ocean.

**Multi-region active-active driver positions.** Home region per metro. A region outage is that region's cities. Dual-writing 300K geo updates is how you buy split-brain.

**Cheapness relative to one Redis instance.** Kafka + extra Redis + stream processors + per-metro capacity planning is a permanent bill. You are buying blast-radius control and a scan-shaped index, not a discount.

**The fantasy that a rainstorm becomes a non-event.** NYC will still have no cars, high ETAs, and ugly p99 — **in NYC**. The win is Cleveland's p99. Sell that win. If leadership wanted NYC to be fine in a hurricane, they wanted more drivers, not H3.

## 3. What I would ask for, even though I expect friction

Ask **once, in writing, in Phase 0**, in parallel with Redis diagnosis. Silence must not block the diagnosis.

Ask marketplace / product:

1. **Is demand = ride requests or completed matches?** Default requests. If they pick matches, surge will lag the shortage. Make them sign the sentence.
2. **Surge miss: 1.0x or cannot-quote?** Default 1.0x + page. Integrity teams will hate it. UX will hate the other. Same sentence, two signatures.
3. **Max k-ring / max pickup ETA you will send a car?** If they say "find anyone in the metro," matching becomes a city scan again. Need a number.
4. **Is "closest driver" a claim we make to users or regulators?** If yes, this design does not support the claim. Change the copy or change the project.

Ask ops / platform:

5. **May top metros have dedicated Redis (and dedicated matching pools)?** If no, city hash tags on the existing 3-node Cluster are a partial story. Do not promise isolation.
6. **Kafka ownership, retention, PII on location topics.** Expected: ticket latency. That latency is a Phase 2 risk.
7. **Per-city SLO dashboards as the official matching SLO.** Expected: "we already have a global one." The global one is how NYC hid.

Ask security / privacy:

8. **Retention of 300K pings/sec paths.** Hours vs weeks is a legal and cost fork. ML will ask for weeks. Default hours on the hot topic; derive elsewhere if they win.

Ask finance:

9. **Whether this is funded as a multi-quarter rebuild.** If the ask is "finish H3 this sprint," you will ship city-GEO stopgap and call it done. Name that.

What I would **not** ask for: a custom location database, Kubernetes-for-its-own-sake, multi-cloud, building OSRM worldwide, active-active, batch-optimal matching. Those asks spend calendar time that belongs to key schema, Lua drills, and topology.

## 4. Complexity inventory (what those four words cost)

| You take on | You shed |
| --- | --- |
| H3, two resolutions, k-ring edge cases | GEOADD/GEORADIUS on one key |
| Kafka + apply lag as a first-class signal | Ping HTTP coupled to Redis CPU |
| Hash tags, one-slot Lua, dedicated vs pooled topology | "We have Cluster so we are sharded" |
| Reservation TTL + pings must not clobber status | Read-then-SET double-dispatch |
| Lazy SREM ghosts; TTL ≠ set membership | Fantasy that expiry cleans indexes |
| Stream processor, windows, caps, hysteresis | Quote-time scans for surge |
| Per-city SLOs, isolation drills | One global p99 that lies |
| Geofence-as-partition-key hygiene | One world map |
| Operational cost of many Redis + Kafka | One hero Redis box |

Net: **more parts, in the right places.** The old design was simple *and wrong at this write rate and this coupling.* The new design is the standard shape for this problem, and the standard shape is still **quarters**, not an afternoon of `GEOSEARCH`.

### What is not worth building

- A custom in-memory geospatial server before a dedicated city Redis is actually CPU-bound on small sets. [ADR-004](./04_architecture_decision_records.md#adr-004).
- Prefix-split inside every city on day one. Escalation for 1–2 megacities, not a v1 ritual.
- Routing on every candidate. [ADR-006](./04_architecture_decision_records.md#adr-006).
- Exact NN / PostGIS on the hot path.
- Active-active location.
- Batch ILP matching to "do it properly."
- GEO fallback "just in case." It will be used in panic and re-couple cities.
- Week-long Kafka retention of raw pings because someone said data lake.
- Surge at res 8 as the billed multiplier.
- Expanding k until a driver exists somewhere in the metro.

## 5. When I would not do this

- **Phase 0 shows `used_memory` concern, not command-thread CPU, and the GEO key is small.** Wrong project. You have a different incident.
- **Global ping rate is an order of magnitude below 300K, hottest city GEORADIUS is fine, and the only bug is double-dispatch.** Write Lua reservation on the existing GEO (still a race fix) and go home. Do not take Kafka as a souvenir.
- **The only proven bug is NYC melting Cleveland, and NYC GEORADIUS is still acceptable.** **Stopgap: `drivers:geo:{city}` (or H3 sets per city) + dedicated Redis for NYC.** Skip Kafka until surge or HTTP coupling forces it. This is not cowardice; it is the incident you actually had.
- **Leadership wants "closest driver" legally and will not change copy, and will not fund routing.** Do not ship H3 as if it satisfied them. Deadlock is more honest than a silent lie.
- **No dedicated hardware will be approved for top metros.** Then do not sell isolation. Sell "slightly better key schema on the same box." Maybe still worth H3 sets to kill GEORADIUS *shape*; do not print "strict isolation" in the design review.

When I **would** do this: commandstats show GEOADD+GEORADIUS pinning a core during storms; one key (or one primary) holds all cities; matching p99 is globally correlated with one city's weather; surge scans the same box; double-dispatch tickets track latency. Then the four words are the design, and this document is the bill.

**Honest middle:** Phase 1 city-sharded H3 sets on dedicated hot-city Redis, still sync writes, Lua reserve. Measure. If ingest HTTP and surge still fight the city primary, *then* Kafka + streaming surge (Phases 2 and 4). The plan allows that. Skipping Phase 0 and standing up Flink because the prompt said "event streaming" is how you operate two outages.

## 6. Brutal summary

The clever design is not a bigger Redis or Redis Cluster in front of one GEO key. The clever design is **refusing to store the world in one sorted set**, **putting city on the hardware path not just in a JSON field**, checking commandstats first so you know whether you are in a coupling incident or a megacity-scan incident, and paying for topology, a log, a lock, and a surge cache.

"H3 cells, city-sharded" is the right four words. The fifth through five-hundredth words are: one primary per city unless you prefix-split, hash tags are not a dedicated box, TTL does not empty SETs, k=1 exists because hexes have edges, haversine is not ETA, surge is lagged and capped, Kafka is optional until the numbers say it is not, and NYC in rain will still suck — in NYC.

If the numbers are small, do not build this. If the numbers are real, do not pretend `GEORADIUS` is a strategy. Either way, Phase 0 is the Redis thread and the key count — before anyone opens a Jira titled "Stand up Kafka."
