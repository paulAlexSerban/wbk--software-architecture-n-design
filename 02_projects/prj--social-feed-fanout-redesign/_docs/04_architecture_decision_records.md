# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Hybrid Push/Pull with a Follower-Count Threshold over Pure Push or Pure Pull

**Status**: Accepted

**Context**: The follow graph is a power law. Average degree ~150; celebrity degree 20M+. Pure fanout-on-write makes a celebrity post a 20-million-write event and is the current breaking-news outage. Pure fanout-on-read makes every home-timeline load a fan-in across all followees and, at 250M DAU, a MySQL and cache miss storm for the ordinary case that push was invented to avoid. The existing system is already a hybrid in name; in practice the cutoff is missing, too high, or still pushes the tail.

The expected redesign, and the one this project commits to, is **hybrid push/pull with an explicit, enforced degree threshold**: push the body of the graph so ordinary reads stay one-list; pull the tail so celebrity writes stay one-index.

**Decision**: Classify authors into `push`, `hybrid`, and `pull` from maintained `follower_count` against thresholds `T_push` and `T_celeb` (working defaults 10k and 1M). Planner selects protocol from stored tier, with a hard fail-toward-pull if degree ≥ `T_hard` even when tier is stale. Clients and product do not pick per post.

**Consequences**:
- (+) Celebrity write amplification is bounded by index append, not by follower count.
- (+) Ordinary users keep a materialized home list; the 100 ms read SLO is plausible.
- (–) Two write paths and a merge that must dedupe. Boundary bugs (missing/duplicate posts) are the tax. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- (–) Thresholds will be wrong and will be political. Creators at 900k followers will not want to "become pull." Operational safety beats creator feelings; product must be in the room when `T_celeb` moves.
- (–) Running two paths is more operational surface than a single religion. That is the point of hybrid; it is also the cost.
- **Alternative rejected**: Pure push with "more workers and Redis." Replaces Memcached thrash with Redis `ZADD` storms. Same complexity class.
- **Alternative rejected**: Pure pull with "cache author timelines." Works until home load fans in 150–500 keys at p99 for everyone, every scroll. You will build push later under an incident.
- **Alternative rejected**: One global pub/sub (Kafka as the feed). 250M consumers is not a consumer-group design; it is fanout with extra steps. Kafka is acceptable *as the push job queue*, not as the timeline.
- **Revisit trigger**: measured histogram shows no tail (nobody above low 10ks). Then this whole program is overkill; cap push and stop. Phase 0 can kill the project. If a ranker requires candidate sets that are not "followed people," this ADR still holds for the *following* feed; "For You" is a new system.

## ADR-002: Read-Time Merge of Celebrity Indexes over Fanout-on-Write for High-Degree Authors

**Status**: Accepted

**Context**: Even "async fanout" for a 20M-follower author is 20 million mutations. Queueing them does not change the work; it changes when the cluster dies. The 15+ second propagation delay is workers (or invalidation rebuilds) racing a news-driven read spike. Followers of celebrities need the *post ID in a place the merge already looks*, not in 20 million home keys.

**Decision**: Pull-tier (and hybrid-tier) posts are appended to a per-author **celebrity index**. Home-timeline read **k-way merges** the viewer's push list with the indexes of pull-tier accounts they follow, with a hard cap `C_max` on merge width, duplicate suppression by `post_id`, and watermark cursors. High-degree authors are **not** fanned out to per-follower lists, synchronously or asynchronously.

**Consequences**:
- (+) Breaking-news visibility tracks index write + cache, not queue depth. This is the 15 s fix.
- (+) Celebrity delete/edit is one index mutation plus post tombstone, not a retract storm.
- (–) Every home load of a celebrity-follower does extra reads (bounded). If `T_celeb` is too low, merge width is the new outage.
- (–) Pagination under concurrent inserts is best-effort. Exact "no holes, no dupes across pages forever" is not promised.
- (–) Users who follow more celebrities than `C_max` get a degraded merge. That is explicit.
- **Alternative rejected**: "Async fanout but only to *online* followers, pull for the rest." Online/offline at 250M is a presence system you do not have, and news events are when "online" is maximized — the worst moment to push.
- **Alternative rejected**: Write-time merge into a global "news" timeline. That is not a per-user follow feed.
- **Revisit trigger**: merge p99 exceeds budget because `C_max` is saturated in production. Then raise `T_celeb` (more push — dangerous) or add a second-stage "celebrity of celebrities" cache; do not remove the cap.

## ADR-003: Decoupled Approximate Counters over Synchronous Row-Level Updates on `posts`

**Status**: Accepted

**Context**: Likes, reposts, and comments on a viral post are a write hotspot. Putting `like_count` on the post row (or in the same Memcached blob as the timeline) serializes feed hydration behind counter writes and couples two different QPS classes. Exact global counts at feed-card freshness are not a social-feed requirement; they are a dashboard fantasy. The acting user needs their *action* acknowledged; everyone else needs a number that is nearby.

**Decision**: Engagement events are durable and idempotent (`idempotency_key`). Displayed counts are a **sharded projection**, read in batch at hydration, reconciled asynchronously. Merge **fails open** if the counter service times out. The post row is not updated on the like hot path.

**Consequences**:
- (+) Viral like-storms do not lock feed reads.
- (+) Retries do not double-count if keys are honored.
- (–) Counts are wrong for seconds to minutes. Screenshots will be used against you. Product must accept this in writing.
- (–) A new service, a new failure domain, a reconcile job that can itself drift. This is real cost; it is not "a Redis INCR."
- (–) Comment *threads* are not this service; comment *counts* are. Do not smuggle a comment store in here.
- **Alternative rejected**: `UPDATE posts SET like_count = like_count + 1`. Cheapest this week. The news-event row lock.
- **Alternative rejected**: Store counts inside each home-timeline blob. Multiplies write amplification by engagement rate; guarantees staleness and thrash.
- **Alternative rejected**: Fail-closed feed when counters are down. Teaches the site to go dark when likes are hot — the same moments as celebrity posts.
- **Revisit trigger**: a compliance or money path needs exact counts (ads, payouts). That path must **not** be the feed card. Build a ledger; leave the feed approximate.

## ADR-004: Media by Stable ID, Decoupled from Timeline Payload, over Embedding Media State in Fanout

**Status**: Accepted

**Context**: Timeline blobs that contain media URLs, transcode status, or bytes couple CDN lifecycle to follow-graph writes. A finished transcode, an expiring signed URL, or a takedown then requires rewriting or invalidating the same millions of keys a celebrity post already thrashed. Media delivery is read-heavy and cacheable by object ID. Timeline generation is graph-shaped. Mixing them is how a video packager incident becomes a feed incident.

**Decision**: Posts store **stable media IDs**. Home lists and celebrity indexes store **post IDs only**. Clients/edge resolve IDs to CDN URLs. CDN invalidation never walks follower lists. This project does not implement a CDN.

**Consequences**:
- (+) Transcode and takedown do not fan out.
- (+) Timeline values stay small (IDs), which is required for Redis memory math and merge speed.
- (–) Feed JSON is not self-contained for playback. Clients must resolve media. Extra round-trip unless the media URL scheme is deterministic from ID.
- (–) "The image is broken but the tweet is in the feed" becomes a possible state. That is correct; do not "fix" it by stuffing URLs back into lists.
- **Alternative rejected**: Hydrate media URLs into the cached home page JSON with long TTL. Convenient; URL expiry and takedown become feed-cache problems.
- **Alternative rejected**: Build a new CDN as part of the timeline rewrite. Scope explosion. Use the existing one; fix the contract.
- **Revisit trigger**: no CDN and no object store exist. Then this ADR still holds for the timeline (IDs only); someone else must still deliver bytes. Do not put bytes in Redis.

## ADR-005: Redis-Class Sorted Structures Replacing Memcached as the Timeline Materialization Tier

**Status**: Accepted

**Context**: Memcached is a look-aside object cache. The current design uses it as a timeline database: serialized lists, GET-modify-SET, LRU eviction under write churn. That is the thrash mechanism. A sorted set with unique members, O(log N) prepend, and explicit caps matches the push-list and celebrity-index access pattern. Redis (or an equivalent: KeyDB, Dragonfly, a purpose-built list service) is the standard answer. It is **not free**: it is a data store migration at 250M DAU, with persistence/replication decisions Memcached never asked you to make.

**Decision**: Materialized home lists and celebrity indexes live in a Redis-class clustered store as capped sorted ID sets. Memcached may remain for *post-body* look-aside or other blobs during migration; it is **not** the home timeline. Persistence: enough replica durability that a node death does not require rebuilding 250M lists from MySQL in the same hour; exact AOF-every-write is not required (lists are rebuildable, slowly). See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).

**Consequences**:
- (+) Operations that match the data structure (prepend, cap, idempotent member, range by score).
- (+) Celebrity index is a natural hot key; cluster sharding must **not** put all celebrities on one shard — shard by `author_id`, accept that a single celebrity index is still one key (small).
- (–) Multi-quarter migration. Dual writes. Incident risk during cutover. Hiring/on-call for Redis at this memory size.
- (–) Redis is not magic capacity. 20M `ZADD`s to distinct home keys is still 20M writes; ADR-001/002 forbid that. This ADR does not license unbounded push.
- (–) Persistence vs memory cost. If you treat Redis as ephemeral Memcached, a failover is a site-wide empty feed. If you treat it as the only copy of home timelines, you have created a new system of record you will regret. **Lists are a cache of a rebuildable projection.** MySQL posts + follows remain the rebuild source. Rebuild is slow; replicas exist so you rarely do it.
- **Alternative rejected**: Keep Memcached; store smaller blobs. Smaller blobs still GET-modify-SET and still invalidate millions of keys on celebrity push.
- **Alternative rejected**: MySQL `home_timeline` table as the serving copy. 250M × K rows, celebrity insert storms if anyone pushes the tail, replica lag as the 15 s delay. MySQL can be the *rebuild* source for push-tier if you keep a narrower table; it is not the serving fanout engine.
- **Alternative rejected**: Cassandra/Scylla as the first cut because "wide rows." Viable at this scale, heavier ops, not required to prove hybrid pull. Revisit if Redis memory economics fail Phase 0.
- **Revisit trigger**: Phase 0 memory model shows Redis cost exceeding willingness to pay. Then consider: smaller `K`, inactive-user eviction, or a disk-backed list store — not a return to Memcached blobs.

## ADR-006: Async Queue-Based Fanout Workers over Inline Fanout at Post-Creation Time

**Status**: Accepted

**Context**: Inline fanout (the post HTTP request loops followers, or spawns unbounded goroutines) ties API latency and blast radius to degree. Even for push-tier (≤10k) this is a clumsy request. For a misclassified celebrity it is an outage in the request pool. Unbounded async (fire-and-forget threads, an in-memory channel) moves the outage by seconds. A queue with chunked jobs, checkpoints, visibility timeouts, DLQ, and **backpressure** is the difference between "workers are behind" and "workers and the API are dead."

**Decision**: Post API persists then calls the planner. Push/hybrid work is **chunked jobs** on a queue. Workers are idempotent. Checkpoints are cursors. Poison goes to DLQ. Queue overload sheds **push** work; it does not start pushing pull-tier authors. The queue is not the celebrity news path.

**Consequences**:
- (+) API latency independent of degree.
- (+) Partial crash recovery without duplicate display (given sorted-set members).
- (–) Ordinary posts are eventually in followers' homes, not atomically. Product "instant for my 200 followers" is *usually* true and not a transaction.
- (–) A new failure domain: queue partitions, poison, lag. On-call must read **tier-split** lag, or they will "scale workers" during a celebrity event that does not use them.
- (–) Kafka/SQS/etc. choice is operational, not architectural, as long as chunking and backpressure exist. Do not block the design on brand.
- **Alternative rejected**: Inline fanout with a 50 ms budget then "continue in background" without checkpoints. The background half is the half that loses the last 4,000 followers silently.
- **Alternative rejected**: One queue message per follower. 10k messages per mid-tier post is queue-broker abuse; 20M is a self-DDoS. Chunks exist for a reason.
- **Revisit trigger**: push-tier `T_push` is so low that jobs are tiny and queue overhead dominates. Then batch multiple posts per follower (inbox packing) — a new ADR, not a return to inline loops.
