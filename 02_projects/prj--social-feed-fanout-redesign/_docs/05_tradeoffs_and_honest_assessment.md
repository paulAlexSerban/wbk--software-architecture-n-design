# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone stands up a Redis cluster or a fanout topic.

The expected answer is three words: **hybrid push/pull**. Those three words are correct. They are not free. Unbounded fanout-on-write through MySQL and Memcached is the anti-pattern; listing "add cache" and "add Kafka" is diagnosis-adjacent, not design. This page is the cost of the design.

## 1. What I would build

A **tiered timeline fabric** on top of the existing post and follow records.

- **Degree classification** with stored `follower_count` and tier `push` | `hybrid` | `pull`. Hard fail-toward-pull above `T_hard` if classification is stale. [ADR-001](./04_architecture_decision_records.md#adr-001).
- **Celebrity index + read-time merge** for the tail. This is the 15-second news fix. [ADR-002](./04_architecture_decision_records.md#adr-002).
- **Chunked, checkpointed, idempotent push workers** for everyone still below the cap. Queue with backpressure. [ADR-006](./04_architecture_decision_records.md#adr-006).
- **Redis-class sorted ID lists**, not Memcached blobs. Lists are a rebuildable projection; posts and follows stay the source of truth. [ADR-005](./04_architecture_decision_records.md#adr-005).
- **Counter service** as a sharded projection with idempotent events and fail-open reads. [ADR-003](./04_architecture_decision_records.md#adr-003).
- **Media IDs only** in posts and timelines. CDN remains someone else's system; the contract is the work. [ADR-004](./04_architecture_decision_records.md#adr-004).

I would not "just add Kafka" in front of the same 20 million Memcached writes. I would not swap Memcached for Redis and keep pushing celebrities. I would not put `like_count` on the post row and call the feed done.

If Phase 0 shows the tail is small (no authors near 20M, incidents are cache sizing or hot rows only), I would **not** build this whole program. I would cap push at a few tens of thousands, maybe split counters, and stop. Hybrid pull for a tail that does not exist is résumé-driven.

## 2. What I would give up

Be explicit. These are not "later." They are not in v1, and some of them are never in this design.

**Linearizable, globally ordered home timelines.** Cross-author order is best-effort by timestamp/score. Concurrent posts appear in different orders for different people. Pagination can skip or duplicate across pages under inserts. If product wants a totally ordered worldwide feed, they are asking for a different product (and a slower one).

**Exact like/repost/comment counts on cards.** The number is nearby. The actor's button state is immediate. Finance-grade counts are a ledger, not a feed field. Teams that refuse this will keep the hot row and miss the 100 ms SLO during the same events this project exists for.

**Guaranteed sub-100 ms during an extreme breaking-news open-the-app stampede without a degraded mode.** The design *aims* at 100 ms metadata p99 for the merge+hydrate path. A synchronized miss on a viral post body plus 250M clients is still a herd. Singleflight and stale-while-revalidate exist because the SLO will be missed without a degrade. Claiming "always <100 ms, including images, including ranking, including the Super Bowl" is a lie.

**The simplicity of one Memcached key per user, one write path, one on-call playbook.** You will have push workers, indexes, merge, counters, a queue, and a Redis cluster. Two paths are the architecture. They are also two ways to be down.

**Instant materialization of ordinary posts into every follower's list as part of the HTTP response.** Push is async. A 10k-follower author is fast *enough*. A backlog is a degraded mode for that tier. Do not "fix" lag by pushing celebrities onto the same workers.

**Self-contained feed JSON with durable media URLs and counts inside the timeline cache.** Decoupling means more round-trips and more partial failure (tweet without image, tweet with stale count). That is the point.

**A ranking/"For You" engine.** This is delivery of *followed* accounts. Smuggling candidate generation into the fanout rewrite is how you ship neither in a year.

**Multi-region active-active home timelines.** Single-region (or primary-region) with replica lag is the claim. Active-active merge of push lists is a consistency project of similar size to this one. Do not bundle them.

**Cheapness, if the old path was "insert post, GET-modify-SET some blobs."** This is a multi-quarter platform migration. Pay it when the degree tail and the 15 s delay are real. Do not pay it because an interview question said "Twitter fanout."

**A threshold that makes everyone happy.** `T_celeb` will misclassify borderline creators. Pull means "your tweet hits 20M feeds via merge, not via 20M writes," not "we deprioritized you." If you cannot say that sentence to Creator Relations, do not start Phase 1.

## 3. What I would ask for, even though I expect friction

Ask **once, in writing, in Phase 0**, in parallel with the histogram. Silence must not block measurement.

Ask product:

1. **Is a home timeline of followed accounts (not For You) the actual incident?** If the 15 s delay is ranking lag, this project will not help. Expected: mixed answers. Make them pick the SLO in one sentence: "time from celebrity post commit to appearance in a follower's following-feed metadata."
2. **Are approximate public counts acceptable?** If no, they are asking to keep the hotspot or to fund a ledger. Either way, do not hide it inside merge.
3. **What is the maximum celebrities-followed we will honor at read time?** If the answer is "unlimited," `C_max` will still exist; they need to know some follows will not merge.

Ask SRE / capacity:

4. **Redis (or equivalent) memory budget and on-call ownership.** Expected: "the app team owns it" until the first failover. The cluster is the new timeline disk.
5. **Whether the 15 s delay is measured** (probe users) or anecdotal. If nobody can plot it vs author degree, Phase 0 is that plot, not a purchase order.

Ask security / trust and safety:

6. **Takedown SLO: is hydration-time drop enough, or must every cached ID list retract within N seconds?** Expected: "remove immediately worldwide." Reality: tombstone on post + CDN purge is the worldwide part; list retract is best-effort for push-tier. Get that in writing.

Ask creator/product:

7. **Will they accept pull-tier for accounts above `T_celeb` without a "real-time" badge war?** If the only acceptable outcome is 20M push with 100 ms, this design cannot succeed. Stop before Redis.

What I would **not** ask for: a graph database as a prerequisite, Kafka as a personality, a new CDN, Kubernetes, a rewrite of the mobile clients beyond media-ID resolution, active-active, or a ranking team in the same milestone.

## 4. Complexity inventory (what those three words cost)

| You take on | You shed |
| --- | --- |
| Two write paths + merge dedupe + watermark cursors | One GET-modify-SET blob that last-write-wins posts away |
| Degree classifier, threshold politics, fail-toward-pull | Unbounded work proportional to celebrity degree |
| Queue, chunks, checkpoints, DLQ, backpressure | Inline fanout in the post request |
| Redis-class cluster as list fabric; dual-write migration | Memcached-as-timeline-database, LRU thrash on news |
| Counter service, idempotency keys, fail-open, reconcile | `UPDATE posts SET like_count` |
| Media ID contract, client resolve, partial UI states | Fanout of URLs and transcode status |
| Probe-based propagation SLO, metrics split by tier | "Cache hit rate" as a single meaningless number |
| Eventual consistency as an explicit product fact | The fantasy of one consistent home timeline for 250M people |

Net: **more parts, in the right complexity class.** The old design was simple *and quadratic in the tail.* The new design is the industry-standard hybrid, and the standard one is still **quarters**, not a sprint: migration of the serving cache, worker correctness, and merge bugs will dominate. Redis commands are the easy part.

### What is not worth building

- Kafka (or any log) as the per-user feed. Consumer-group fanout at 250M is the original problem wearing a brand.
- Pushing "online users only" without a real presence system, especially during news (when everyone is online).
- A custom CDN, a graph database, or a ranking model "while we are in there."
- Exactly-once, globally consistent counters on the card.
- Synchronous retract of 20M lists before a takedown is considered done. Tombstone + hydrate + CDN purge.
- Active-active multi-region in the same program as the first hybrid cutover.
- Infinite home-timeline length. Cap `K`. History is search and profile.

## 5. When I would not do this

- Phase 0 histogram shows **no heavy tail** and incidents correlate with Memcached RAM or a single hot like-row. **Cap push, add RAM or split counters, stop.** Hybrid pull is a flex.
- Product SLO includes ranking, ads, and video start time in the same 100 ms. This project cannot take that SLO. Split it or refuse the number.
- Creator Relations will not allow a pull tier. Then you will push 20M and this document is a museum piece. Do not "compromise" by pushing 20M asynchronously and calling it hybrid.
- The team cannot staff Redis + queue on-call for a year. The migration will stall at dual-write forever, which is worse than the status quo.
- Compliance forbids approximate counts *and* forbids a separate ledger. Then you have a contradiction; do not invent one on the post row and hope.

When I **would** do this: the tail is real (multi-million follower authors posting during news), probes show propagation delay growing with degree, cache miss storms follow those posts, and product will accept pull for that tail plus approximate counts. Then hybrid push/pull is the design, and this document is the bill.

A **partial** build is often the honest build: pull-tier for the extreme tail on the *current* cache, without a full Redis migration, can kill the 15 s celebrity delay first. That is Phase 1. Do not hold Phase 1 hostage to Phases 3–5.

## 6. Brutal summary

The clever design is not a bigger Memcached slab or a Kafka topic in front of 20 million writes. The clever design is **refusing to materialize a 20-million-follower post into 20 million timelines**, merging a small number of celebrity indexes at read time, keeping push for the body of the graph, and taking counters and media off the timeline mutation path.

"Hybrid push/pull" is the right three words. The fourth through four-hundredth words are thresholds that fail toward pull, k-way merge with dedupe, chunked idempotent workers, Redis as a list fabric not a blob cache, approximate counters, media IDs, and a Phase 0 histogram that can still kill the project.

If the graph is not skewed, do not build this. If it is skewed, do not pretend cache sizing is a strategy. Either way, Phase 0 is degree versus fanout time versus hit rate — before anyone files a PO for a Redis fleet.
