# High-Fanout Social Feed — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not "we already know it's fanout."** Building Redis and a merge path against a guessed root cause is how you ship duplicate tweets on top of an untouched hot `like_count` row. Later phases close gaps; skipping to a cache migration because it is visible is how dual-write lasts forever.

Rollback/kill criteria at the bottom apply at every phase.

Calendar is not a two-week death march. A realistic Phase 0 is days to a couple of weeks of instrumentation and one news-like load test if you cannot wait for a real event. Phase 1 (pull for the extreme tail) can be weeks if the follow-graph can already list "followers of X" and you can flag merge. Redis cutover, counters, and media decoupling are **quarters**. Do not compress Phase 2 by skipping a forced mid-fanout kill drill. Do not hold the 15-second celebrity fix hostage to a Memcached retirement.

## Phase 0 — Measure and Confirm (before any serving-path rewrite)

**Objective**: Replace "celebrities break the feed" with a partitioned fault tree: degree vs fanout cost, cache thrash vs hot rows vs blob size vs worker deadlock. Decide whether this is a hybrid-pull program, a counter split, a cache-size incident, or some combination. See [Scenario — What to Check First](./01_scenario_and_requirements.md#what-to-check-first-and-why-that-one-first).

**Deliverables**:
- Follower-count **histogram** of authors who posted in incident windows (and a week of baseline). Percentiles: p50, p95, p99, max. Count of authors above 10k / 100k / 1M / 10M.
- Fanout-job duration and write-ops vs `follower_count` scatter (or an honest statement that jobs do not log degree — that statement *is* a deliverable).
- Timeline-cache hit rate **over time**, annotated with high-degree post timestamps; slab/eviction stats; average blob size (IDs-only vs hydrated vs media).
- MySQL QPS and lock waits split by table/query: `posts` updates (counters), `home_timeline` if it exists, `follows`, post primary-key reads.
- Propagation delay: time from post commit to appearance in **sampled** follower caches, **split by author degree**. Canary accounts if sampling production is too hard: one user who follows only mega-accounts, one who follows only small accounts.
- Home-timeline p99 as measured today (metadata vs fully painted including images — say which).
- How "hybrid" is actually implemented (code path, config, tribal cutoff). Job grain (one per follower vs one per post).
- Memory model: `active_users × K × bytes_per_id` vs current Memcached RAM; whether Redis is economically plausible.
- Written asks to product: following-feed vs ranking SLO; approximate counts; pull-tier for authors above a named `T_celeb`.
- A one-page unknowns log: each failure mode `observed`, `ruled out`, or `still open`.

**Exit Gate**:
- [ ] Root cause(s) named with evidence — a scatterplot of delay vs degree, a lock-wait on `posts`, a blob-size number — not "probably cache."
- [ ] Go/no-go:
  - **Heavy tail + delay/thrash tracking degree → proceed to Phase 1** (pull for that tail).
  - **Hot counters dominate, tail mild → Phase 3-shaped work (or a smaller counter project); do not start a merge platform.**
  - **Blobs huge with media, degree mild → Phase 4-shaped decoupling; maybe skip celebrity pull.**
  - **No tail, RAM too small, no hot row → buy cache / fix TTL / stop this program.**
  All of these are successful Phase 0 outcomes.
- [ ] If proceeding with pull: draft `T_push`, `T_celeb`, `T_hard`, `C_max`, `K` written down as parameters to revisit, not as brand promises.
- [ ] Product has answered pull-tier-for-mega-accounts yes/no. If no, **stop** (kill criterion 3).
- [ ] Feasibility: follow-graph can enumerate followers in chunks *or* Phase 2 includes that work; `pull_followees(viewer)` is possible or is a Phase 1 deliverable.

Do not "stand up Redis in parallel" before this gate unless it is a sandbox. Parallel is how the wrong store gets a head start.

## Phase 1 — Pull-Tier for the Extreme Tail, Additive (flagged)

**Objective**: Prove that a 20M-follower post can be visible via **one index + merge** without 20M timeline writes. Leave the old path on for everyone else. This phase is allowed to run **on the existing cache/store** if that is the fastest way to get an index key and a merge branch; Redis migration is not a Phase 1 requirement.

**Deliverables**:
- Classification job: mark authors with `follower_count ≥ T_celeb` (start **higher** than the eventual default if unsure — e.g. only the top N accounts — to keep `C_max` trivial).
- Celebrity index write on post for those authors; **planner skips fanout** for them (feature-flagged).
- Merge path for flagged viewers (internal, or viewers who follow flagged authors): home blob/list **plus** those indexes; **dedupe by post_id**.
- Canary: user who follows only flagged celebrities. Propagation probe for that canary.
- Metrics: fanout job size for flagged authors (must collapse); merge fan-in; merge p99; duplicate rate.
- Old path still default for unflagged authors, including pushing mid-tier as today.

**Exit Gate**:
- [ ] A flagged celebrity post does **not** produce a fanout job of size ≈ follower_count. Observed in metrics, not "the code looks like it wouldn't."
- [ ] Canary sees the post through merge in well under the old 15 s (target: sub-second in-region index visibility under test). If merge is slower than the old push *for this canary*, fix merge before expanding the flag — but compare fairly: old push *to 20M* was "fast for some, 15 s for most."
- [ ] Duplicate suppression works for at least one author moved through **hybrid** or dual-written during test (post appears once).
- [ ] Unflagged users and small authors unchanged. This phase does not "fix Memcached." Claiming it does is a failed gate.
- [ ] Rollback: flag off restores push for those authors (knowing that rollback **reintroduces** amplification — it is still the safety valve).

If `pull_followees` cannot be answered cheaply, **do not** scan the follow table on every home load. Fix that query or cache before expanding the flag.

## Phase 2 — Checkpointed Async Push for the Remaining Graph

**Objective**: Take remaining push off the request path and off uncheckpointed loops. Bound blast radius of a 9,999-follower author and of a worker crash. Still do **not** push `≥ T_hard`.

**Deliverables**:
- Queue + chunked jobs + cursor checkpoints + visibility timeout + DLQ.
- Idempotent prepend (sorted-set members or equivalent). Forced drill: kill a worker mid-chunk; confirm no duplicate display and no skipped chunk after retry.
- Backpressure policy: shed push when queue age exceeds SLO; **never** enqueue pull-tier as push.
- Fanout metrics **split by tier**.
- Optional: begin dual-writing push lists into Redis-class store alongside Memcached if Phase 0 said Redis is required; serving can still read old store. If Phase 0 said lists can stay where they are until later, do not start a storage migration here.

**Exit Gate**:
- [ ] Post API does not iterate followers. Load test a `T_push`-sized author; API latency stays in ordinary request bounds.
- [ ] Mid-chunk kill drill observed (not theoretical).
- [ ] Poison job does not stall the queue; DLQ has a runbook.
- [ ] A mis-tagged high-degree author still cannot enqueue above `T_hard` (force pull). Test this on purpose.
- [ ] Queue-age alert pages people who know not to "fix" a celebrity event with more push consumers.

## Phase 3 — Engagement Counter Service

**Objective**: Remove `like_count` (and siblings) from the post hot row / timeline blob so viral engagement does not serialize feed reads. May start earlier if Phase 0 isolated counters as a co-equal incident; then this phase can run **in parallel with Phase 1**, not after Phase 5.

**Entry Gate**: Phase 0 said counters are on the hot path, **or** Phase 1/2 serving still hydrates counts from `posts` and a viral-post drill shows lock waits. Do not build a counter platform because it is fashionable.

**Deliverables**:
- Idempotent like/repost/comment events; sharded projection; batch read API; reconcile job.
- Merge/hydration reads counters from the new path, **fail-open**.
- Dual-write with old column during soak; then stop updating `posts.like_count` on the hot path.
- Actor read-your-writes for button state (not for the global integer).

**Exit Gate**:
- [ ] Viral-like drill: feed p99 does not track like QPS; old row lock waits gone or irrelevant.
- [ ] Duplicate idempotency_key does not double-count (observed).
- [ ] Counter outage drill: home timeline still 200; counts stale or omitted; **page** on counter health, not on feed 5xx.
- [ ] Product sign-off that displayed-count drift is acceptable, dated.

## Phase 4 — Media Reference Decoupling

**Objective**: Timeline and post serving payloads carry stable media IDs; CDN/object-store lifecycle does not walk the follow graph. May run in parallel with Phases 1–3 if blob size was a Phase 0 finding.

**Deliverables**:
- Post schema/payload: `media_ids`; strip durable-looking signed URLs from list caches.
- Client or edge resolves IDs (flagged).
- Takedown runbook: post/media tombstone + CDN purge; **no** 20M list rewrite as the success condition.
- Hydration drops taken-down media; feed JSON still returns.

**Exit Gate**:
- [ ] Timeline stored values do not grow with media metadata/URL churn (size metric).
- [ ] Transcode-complete does not invalidate per-follower timeline keys (trace a video post).
- [ ] Takedown drill: object gone at CDN; cards do not show the media; worker fanout of retract is not required for pull-tier and is not the takedown SLO.
- [ ] Flagged clients render media. Unflagged clients: explicit compatibility plan (temporary dual fields), time-boxed.

## Phase 5 — Serving Cutover and Retirement of Memcached-as-Timeline

**Objective**: Default all authors to the tiered planner; default all viewers to merge+push-lists on the new list fabric; stop using Memcached blobs as home timelines. Old path is a documented, time-boxed fallback.

**Entry Gate**: Phase 1 flag has covered the real tail in production, not only three test accounts. Phase 2 workers are the only push implementation. If Redis was the chosen fabric, dual-write has soaked; read path can flip by flag.

**Deliverables**:
- Flag default ON for planner + merge for 100% (or a staged % ramp with automatic halt).
- Breaking-news **load test** or a planned soak across a real news window: celebrity post rate, app-open spike, probe SLOs, Redis/CPU/queue dashboards **by tier**.
- Memcached timeline keys: stop writes, then stop reads, then drop. Time-box on a calendar.
- Support note: approximate counts; media may load after text; pull-tier creators are not "deprioritized"; ordinary push may lag under shed.
- Inactive-user memory policy only if Phase 0 math requires it (optional; do not invent it at cutover night).

**Exit Gate**:
- [ ] Fanout write QPS no longer tracks celebrity posts (celebrity writes stay at index QPS).
- [ ] Celebrity canary propagation stays within the new SLO through a news-like spike.
- [ ] Home metadata p99 meets the **written** SLO (100 ms if still the target after Phase 0 measured reality) **or** the SLO is revised in writing with cause (merge width, hydration, not "Redis was the wrong brand").
- [ ] Small-author and small-follower success/latency **not** regressed vs Phase 0 baseline.
- [ ] Memcached timeline traffic near zero; removal date set. If traffic does not drain, a leftover writer exists — find it; do not add RAM.
- [ ] Counter and media flags in their done state, or explicit exceptions dated (e.g. counters still dual-writing for one more quarter).

## Standing Rollback / Kill Criteria (apply at every phase)

Stop, roll the flag back, or kill the project — do not "keep merge on to see if duplicates settle" — if any of the following hold:

1. **Phase 0 says this is not a tail-fanout problem.** Proceeding to celebrity pull anyway is résumé-driven. Kill or shrink to the slice (counters or media) that evidence supports.
2. **Following-feed p99 or error rate for ordinary users gets worse after Phase 1/5.** Roll the flag back. Fix merge/dedupe/timeouts. Do not "standardize" by pulling everyone.
3. **Product/creators will not accept a pull tier** and leadership will not overrule. Kill. Do not async-push 20M and label it hybrid.
4. **Merge fan-in saturates `C_max` in production** and the proposed fix is "raise timeouts" or "uncap." Halt expansion; raise `T_celeb` or cut merge sources with a product-visible rule.
5. **Push queue is used for pull-tier or "online" celebrity delivery.** Halt. That is the architecture regressing.
6. **Counter path fail-closes the feed.** Roll back to last-known counts or omit counts; do not ship fail-closed.
7. **Redis/list-store OOM or failover empties feeds** with no rebuild story. Halt traffic expansion; persistence/replicas/rebuild runbook is a gate, not a follow-up. Do not treat the cluster as Memcached-with-ZADD.
8. **Dual-write to Memcached and Redis has no time-box.** After Phase 5 entry, an open-ended dual-write is a kill criterion for the *migration*, not a cozy steady state. Pick a date or roll back to one store.
9. **Ranking, CDN rebuild, or active-active is declared in-scope to "finish" the feed.** Split the program or kill the extra scope. This project's kill is better than a two-year bundle that never cuts over.
10. **Takedown depends on finishing a 20M retract.** Stop treating retract as the safety control; tombstone + hydrate + CDN first.

Rollback is always to the last phase whose exit gate was honestly green — typically "flag off, old fanout default." After a kill, the honest output is the Phase 0 diagnosis plus whatever cap, counter split, or blob-size fix is justified. The output is not a half-enabled merge that still writes 20 million Memcached keys when the flag is off, undocumented.
