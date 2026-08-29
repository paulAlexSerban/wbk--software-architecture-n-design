# High-Fanout Social Feed: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

A social platform serves 250 million daily active users. The follow graph is highly skewed: the average account has about 150 followers; public figures and celebrities have more than 20 million. A single celebrity post is a write-amplification event. Under the current hybrid push/pull model, that post must update millions of per-user timeline caches at once. The caches sit on Memcached in front of MySQL. The symptoms are cache thrashing, high database read amplification, and 15+ second propagation delays for followers during breaking-news events.

The design must answer, concretely:

1. Why fanout-on-write fails at celebrity scale, and why fanout-on-read fails at ordinary-user scale — both, not one.
2. What you would measure first, and why that measurement before any cache swap or queue introduction.
3. How timeline generation is redesigned so celebrity write-amplification is bounded, feed reads stay under 100 ms, media delivery is not coupled to timeline state, and engagement counters survive a viral post.
4. What that redesign costs in complexity, consistency, and calendar time.

This is the fan-out trap. The naive answer — more Memcached, bigger MySQL, faster fanout workers, "just Kafka" — is the failure. It treats a structural mismatch between graph skew and per-follower writes as a capacity-tuning problem. Capacity is real and it must be named, because it *is* what is failing today. It is not the architecture.

The correct shape is: **push (fanout-on-write) for ordinary and mid-tier accounts; pull (a shared celebrity index, merged at read time) for accounts above a follower threshold; timeline entries carry media references, not bytes; engagement counters live on a different hot path than the post row.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true under a 250M DAU read load, a 15-second news delay that users already notice, and a cache tier that was never a timeline data structure.

## The Trap, Stated Directly

Fanout-on-write is the obvious social-feed design. When Alice posts, write that post ID into every follower's materialized timeline. Reads become cheap: load Alice's friends' precomputed list. That design is correct for a graph whose degree is bounded. It is lethal when degree is a power law.

A celebrity with 20 million followers produces 20 million timeline writes per post. Those writes are not "20 million cheap cache sets." They are 20 million keys that must be found, deserialized, appended, truncated, and written back — or 20 million list pushes that still contend on the same cache cluster, the same network, the same fanout-worker pool. During breaking news, dozens of celebrities post in the same minute. The write fanout is no longer 20 million. It is hundreds of millions of timeline mutations colliding with hundreds of millions of feed reads of those same keys. Memcached evicts the working set. MySQL absorbs the miss storm. Followers wait 15 seconds to see a tweet that the rest of the internet already saw.

Fanout-on-read is the other obvious design. Store posts only on the author's timeline. At read time, fetch the latest posts from everyone the viewer follows and merge. For a user who follows 150 ordinary accounts, that is 150 small reads plus a merge — painful but maybe survivable with caching. For a user who follows 200 accounts of which 12 are celebrities, the celebrity tails dominate: you are merging fat, hot indexes at read time, and you are doing it on every home-timeline request. Pure pull does not "solve celebrity." It moves the cost from write amplification onto the read path of *everyone who follows a celebrity*, which at this scale is most DAU.

The current system already knows this and runs a hybrid. Hybrid is not the insight. Hybrid *without a hard ceiling on who gets pushed* is how you still fan out 20 million writes for the accounts that break the cache. Hybrid *with Memcached as the timeline store* is how those writes thrash: Memcached is a look-aside blob cache, not a sorted list with bounded fanout semantics. Hybrid *with counters on the post row* is how a viral like-storm serializes on one MySQL record while the timeline path is already on fire.

Raising Memcached memory, adding MySQL read replicas, and putting a queue in front of the same per-follower write are the php.ini of this problem. They move the next failure further out. They do not change the fact that celebrity degree and per-follower materialization cannot both be unbounded.

## Current State (Assumed Starting Point)

A typical first version of this path looks like:

1. A post insert lands in MySQL (`posts` plus perhaps a denormalized `user_timeline` or `home_timeline` table).
2. A "hybrid" rule exists on paper: push to followers below some informal fame cutoff; pull for "very famous" accounts. The cutoff is undocumented, inconsistently applied, or set high enough that 20-million-follower accounts still get pushed "because product wants them in the home timeline immediately."
3. The serving copy of each user's home timeline is a Memcached blob: a serialized list of post IDs (or a page of hydrated posts) keyed by `timeline:{user_id}`.
4. Fanout workers (or the post API itself) read the follower list from MySQL, and for each follower GET-modify-SET the Memcached blob, or invalidate it so the next read rebuilds from MySQL.
5. Likes, retweets, and comments `UPDATE posts SET like_count = like_count + 1 WHERE id = ?` (or an equivalent hot row). The counter is on the same record the feed hydrates.
6. Media URLs, and sometimes media metadata, live in the post payload that is cached inside the timeline blob. A transcode finishing, a CDN URL rotating, or a takedown requires rewriting or invalidating timeline entries that already fanned out.

That version will appear to work in staging with a few thousand test followers and a warm cache. It will fail in production the first time a celebrity posts during a news event, the first time Memcached's working set exceeds RAM and LRU starts evicting home timelines of users who are actively scrolling, the first time a viral post's like-count row locks stall feed hydration, or the first time a media takedown tries to chase millions of cached blobs.

This project documents the replacement, not a patch of those knobs.

## The Arithmetic That Makes Tuning Insufficient

Numbers are order-of-magnitude. They exist to bound the design, not to pretend we have production telemetry yet. Phase 0 replaces them with measured histograms. Until then, refuse designs that only work if the celebrity tail is smaller than the problem statement.

| Quantity | Working figure | Why it matters |
| --- | --- | --- |
| DAU | 250 million | Read path is the common case. Feed loads dominate writes. |
| Mean followers | ~150 | Push is cheap for the body of the graph. |
| Celebrity followers | 20 million+ | One post is a 20M-write event if you push. |
| Feed loads per DAU per day (assumed) | ~20 | ~5 billion home-timeline reads/day. Sub-100 ms is a read-path SLO, not a write-path SLO. |
| Breaking-news window | minutes | Dozens of high-degree posts collide with a read spike. |
| Current propagation delay | 15+ seconds | Already user-visible. The SLO cannot be "eventually the workers catch up." |
| Target feed read latency | p99 < 100 ms | Hydration, merge, counters, and media *references* must fit. Bytes of video do not. |

Write amplification if celebrities are pushed:

- 1 celebrity post × 20M followers = 20 million timeline mutations.
- 50 such posts in a news hour = 1 billion mutations in an hour, on top of the ordinary-user firehose, on top of the read traffic that is trying to GET those same keys.
- Memcached at this key cardinality, with GET-modify-SET on multi-kilobyte blobs, is not "a cache in front of MySQL." It is the timeline database, and it is the wrong one: no native sorted-set prepend, no replication story you control, LRU that evicts the *active* working set when the celebrity write storm inflates churn.

Read amplification if you give up and pull everything:

- Viewer follows 150 accounts → 150 author-timeline reads per uncached home load.
- Cache misses cascade to MySQL. 250M DAU × even a modest miss rate is a replica-killing query storm.
- This is why the current hybrid exists. Hybrid is justified. Unbounded push inside the hybrid is not.

The design implication: **bound the push set by degree. Never push a 20M-follower post into 20M caches. Pay a merge at read time for the small number of celebrity indexes each viewer follows.** The merge is O(followed celebrities), not O(celebrity followers). That is the only complexity class that survives this skew.

## Layer-by-Layer Fault Tree (Celebrity Fanout Specifically)

Walk the path. At each layer, name only what fails *because degree is skewed*, or *because skew makes a shared resource scarce during news events*. Generic "the cache is down" is out of scope.

### Post write / fanout enqueue

- **Synchronous fanout in the post request.** The API tries to push to N followers before returning. For N = 150 this is a slow request. For N = 20M it is an outage. Even "async but unbackpressured" just moves the outage into the worker pool 30 seconds later.
- **Follower-list read as a single query.** `SELECT follower_id FROM follows WHERE followee_id = ?` for 20M rows is a table scan with a celebrity-shaped key. It is also a thundering herd if many workers start the same fanout.
- **No idempotency on fanout.** Retry after a worker crash duplicates timeline entries, or a "rebuild from MySQL" invalidation stampede doubles the miss storm.

What this layer does *not* explain by itself: slow reads for users who follow nobody famous. That is cache sizing or a different bug. Do not start a celebrity redesign there.

### Memcached timeline blobs

- **GET-modify-SET on a serialized list.** Concurrent fanouts to the same user (two friends posted) last-write-wins a lost post. Concurrent celebrity storm + user scroll = the hottest keys are also the most mutated.
- **LRU vs write churn.** Celebrity fanout touches millions of keys that are *not* currently being read. Those writes inflate eviction. Actively scrolling users miss. Misses hit MySQL. This is cache thrashing with a precise cause: the write set is far larger than the read working set, and the cache does not distinguish them.
- **No data structure for "prepend post ID, cap at K."** You emulate a deque with a blob. Every prepend deserializes the whole page. Cost per fanout write grows with timeline payload size — which grew when someone cached hydrated posts and media metadata in the same blob.
- **Invalidation instead of update.** Some hybrids give up on SET and `delete timeline:{user_id}` so the next read rebuilds. During a celebrity post that is 20 million deletes, then 20 million rebuilds, aligned with a news-driven open-the-app spike. That is the 15-second delay.

### MySQL

- **Home-timeline table as source of truth for push.** Inserting 20M rows per celebrity post is a write outage with a durable souvenir. Partitioning by user helps reads, not the write burst.
- **Read replicas absorbing cache misses.** Replicas help until the miss storm is the celebrity invalidation. Replication lag then serves *stale* home timelines, which looks like the 15-second delay even after workers "finished."
- **Hot row on the post.** `like_count` / `repost_count` / `comment_count` on `posts.id`. A viral post is a single-row write hotspot. Feed hydration that JOINs or re-reads that row serializes reads behind the counter writes. This is a different failure than fanout, triggered by the same events.

### Media coupled to timeline state

- **Hydrated media in the cached timeline.** Fanout wrote a URL or a processing status into millions of blobs. When transcoding completes or a URL is signed with a short TTL, those blobs are wrong. You either live with broken images or invalidate the same millions of keys the celebrity post just thrashed.
- **Takedown / edit / delete.** A celebrity deletes a post. Push systems must fan out a *delete* with the same amplification as the create. Pull systems delete one row on the author index. If your hybrid still pushed, you pay 20M mutations to retract.

### Engagement counters

- **Counters on the read path of the feed.** Every timeline card needs a count. If counts live on the post row, every feed load is a hot-row read. Caching counts in the timeline blob makes them stale by construction and couples counter freshness to timeline invalidation — the thing already on fire.
- **Exactly-once increment under retry.** Likes are retried. Without idempotency keys you double-count; with row-level updates you cannot take the write rate of a viral post.

### Client / "real-time" expectations

- **Push notifications and in-app banners** are not the home timeline. Product will conflate "the push notification arrived" with "the tweet is in my feed." The 15-second gap is the feed write path, not APNs. Do not "fix" it by adding more websocket fanout of the same blob updates.

## What to Check First, and Why That One First

**Check first: a follower-count histogram of *authors who posted in the last incident window*, plus fanout-job duration and timeline-cache hit rate split by author degree, plus p99 home-timeline latency and MySQL QPS on `posts` vs `home_timeline` vs `follows` during that window.**

This is a read-only, no-rewrite-needed check. It partitions the entire fault tree in one news cycle — or in a load-test that replays one.

| What you see | What it isolates | Why it is cheap |
| --- | --- | --- |
| Fanout job time linear in follower count, with a long tail at high degree | Push is unbounded. The hybrid cutoff is missing or too high. | Job duration vs degree is a scatterplot you can pull from existing worker metrics if you log `author_id` and `follower_count`. If you do not log those, that is a Phase 0 finding, not a reason to skip measurement. |
| Cache hit rate collapses *after* a high-degree post, across keys that were not the author's | Write-churn eviction / invalidation storm, not "cache too small in general." | Hit rate vs time, annotated with celebrity post timestamps. |
| MySQL QPS spike on `home_timeline` or on `posts` primary-key lookups aligned with cache miss | Rebuild-from-DB path; Memcached is not absorbing the working set. | Already in RDS/slow-query metrics. |
| `UPDATE posts SET like_count` lock wait / row contention on a few IDs | Counter hotspot, distinct from fanout. May be *enough* to miss a 100 ms SLO even if fanout is fine. | `performance_schema` / lock waits. |
| Propagation delay (post `created_at` vs first appearance in a sample of follower caches) > 15s only for high-degree authors | Confirms the problem statement. If delay is high for *everyone*, look at a global worker outage or a queue partition, not celebrity logic. | Needs a probe: sample followers, or a canary user who only follows celebrities. |
| Timeline blob size growing (hydrated posts + media) | Fanout CPU and eviction get worse independent of degree. Decoupling media is justified even if you never touch celebrity pull. | `strlen` of cached values, or Memcached slab stats. |

**Why not add Redis first.** Swapping Memcached for Redis without changing who gets pushed turns 20 million GET-modify-SET blobs into 20 million `ZADD`s. Redis is the right structure for the *push* tier (sorted sets, capped lists). It does not make 20 million writes cheap. You will have spent a quarter migrating cache clients to reproduce the same amplification with nicer commands.

**Why not "just pull celebrities" in the app without measurement.** If the incident is actually hot-row counters, or blob size, or a stuck fanout partition, you will add a merge path that does not fix the outage and that *does* add a new consistency bug (duplicate posts, missing posts at the push/pull boundary). Measure, then pick the slice.

**Second check, only after the histogram:** how the hybrid cutoff is actually implemented (code, config, tribal knowledge). Third: whether fanout is sync, async-unbounded, or async-with-backpressure. Fourth: whether likes hit the post row. Fifth: whether media is in the timeline blob.

## Target Users

- **Owning engineer**: implements timeline write and read; needs a degree threshold they can defend when product asks why a 2-million-follower creator is "not real-time pushed."
- **On-call**: needs to know, from fanout lag and cache hit rate, whether this is a celebrity storm, a counter hotspot, or a cache-capacity incident, without replaying 20 million writes.
- **SRE / capacity**: needs to know that Redis memory is sized for the *push* working set plus celebrity indexes, not for 250 million fully materialized infinite timelines.
- **Product**: needs to know that "instant for everyone, exact like counts, full media in the feed payload" is three products, and this design ships none of them as absolutes.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which ranking model, the like-button animation, ads) are out of scope.

1. **Home-timeline read p99 < 100 ms** for a cached or merge-from-hot-indexes path, excluding media byte transfer. Media is a different SLO on a different system. If the 100 ms budget includes video start, this project cannot claim it; see non-goals.
2. **Fanout write cost for a post must be bounded by a degree threshold, not by the author's actual follower count.** A 20-million-follower post must not produce 20 million timeline mutations. The cost must be O(1) or O(index append) on the write path for that tier, with O(followed celebrities) merge on the read path.
3. **Ordinary accounts (the body of the degree distribution) still get push.** Pull-for-everyone is how you miss the 100 ms SLO for users who follow 150 non-celebrities and expect an already-merged list. Hybrid is a requirement, not a compromise you apologize for.
4. **Propagation of a celebrity post into follower home timelines must not wait on a 20-million-write drain.** The 15-second news delay is a celebrity-index visibility problem, not a fanout-queue-depth problem. Target: celebrity posts visible on the merge path in well under a second in the common case; the old 15 s is a failed SLO, not a budget.
5. **Engagement counters must not share a hot row or a hot cache blob with timeline materialization.** Viral likes cannot stall feed reads. Counts may be briefly wrong. They must not be a mutex on the post.
6. **Timeline state must not include media bytes or volatile media URLs.** Entries carry stable media IDs (or stable public identifiers). The CDN/object-store contract is cache-control and ID stability. A transcode finish or a takedown must not require rewriting fanned-out timelines.
7. **Eventual consistency is the consistency model for feed delivery.** Linearizable global ordering of all posts in all timelines is not a requirement. Per-author order should be preserved. Cross-author order is best-effort by timestamp/score. Duplicate suppression at read is required because push and pull can overlap during threshold moves and retries.
8. **Deletes, edits, and visibility changes must be cheaper than creates for high-degree authors.** Retracting a celebrity post is an index delete plus cache invalidation of *that author's celebrity index* and of hydrated post records — not a 20-million-key chase.

## Success Criteria for the Design (Not Implementation Metrics)

1. A post from a 20-million-follower account does not enqueue 20 million per-follower timeline writes. Instrumentation would show an index append (and cache set of that index page), not a fanout-job size of 20M.
2. A user who follows a mix of ordinary accounts and celebrities receives a home timeline that includes both, without a 15-second hole after a celebrity post, in the common case (celebrity index hot).
3. p99 home-timeline *metadata* fetch (IDs + hydration of a page, not images) is designed to fit in 100 ms: bounded merge width, bounded cache round-trips, counters from a separate store that may be slightly stale.
4. A viral like-storm does not increase home-timeline p99 in proportion to like QPS. Counter degradation degrades counts, not timeline assembly.
5. Changing a media processing state does not invalidate per-follower timeline keys.
6. Retrying a fanout job does not duplicate posts in a user's timeline.
7. Moving an account across the celebrity threshold does not require a simultaneous rewrite of 20 million timelines as a blocking migration. Backfill is explicit, gated, and abortable.

## Business Rules (Feed-Scoped)

1. The post API writes the canonical post record and then hands off. It does not loop followers.
2. Degree at *post time* selects push vs pull vs hybrid. The client does not choose. Product does not choose per post. A background classifier may move accounts between tiers; that move is a data migration, not a request parameter.
3. Home timeline pages are assembled from: (a) the viewer's pushed timeline (materialized, capped), (b) the celebrity indexes of accounts the viewer follows that are in the pull tier, (c) hydration of post IDs from a post store, (d) counters from the counter service, (e) media URLs resolved by ID at the edge or a media service — not copied from the timeline entry.
4. Timeline length is capped (working default: a few thousand IDs per user push timeline). Older content is not in the hot home timeline; it is search, profile, or a cold store. Infinite scroll of the entire graph history is not this system.
5. Counts displayed on a card may lag the true count. The like *action* is still acknowledged to the acting user immediately (read-your-writes for the actor, not for the world).
6. Authoritative post body, visibility, and deletion live in the post store. Cached timelines are a performance structure. A deleted post must not remain displayable after hydration; hydration is the last-line filter. Do not rely on having won the fanout-delete race.

## Non-Goals

- **Not a ranking / ML relevance engine.** Assume chronological or an externally supplied score. "For You" model training, candidate generation beyond followed accounts, and ads insertion are out of scope. This project is delivery. Teams that smuggle ranking into the fanout rewrite will ship neither.
- **Not spam, abuse, bot detection, or shadow-ban infrastructure.** Visibility rules are consumed as a boolean (or a small enum) on the post at hydration time. Building the policy engine is a different project.
- **Not DMs, groups, or live video.** Different fanout and consistency problems.
- **Not a CDN implementation.** No POP design, no cache-hierarchy, no video packager. Assume an existing CDN and object store. The scope is the *contract*: timeline holds IDs, not bytes; cache-control and invalidation of media do not walk the follow graph.
- **Not cross-region active-active home timelines.** Multi-region is called out as future work. A single-region (or primary-region) design with eventual replica reads is the v1 claim. Active-active merge of push timelines is a different consistency nightmare; do not pretend this ADR set solves it.
- **Not exactly-once, globally consistent like counts.** Approximate + reconcile. If finance-grade counts are required, that is not a social-feed counter; do not put it on the feed path.
- **Not an implementation.** No Redis commands in production config, no Terraform, no worker code. Numbered steps and diagrams only.
- **Not a claim that this is cheap.** The honest alternative — cap push at a few tens of thousands of followers, accept that mega-celebrities are pull, keep MySQL, add Redis only for the push lists that already fit — is a *subset* of this design and may be enough. The full program (counter service, media decoupling, Memcached retirement, gated threshold) is a multi-quarter platform migration. If Phase 0 shows the incident is only hot-row likes, build the counter slice and stop. That distinction is load-bearing; see [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
