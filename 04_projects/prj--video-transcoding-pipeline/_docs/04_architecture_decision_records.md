# Architecture Decision Records

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Pipeline Overlap with Upload over Process-After-EOF

**Status**: Accepted

**Context**: The prompt's SLO is "within 2 minutes of **upload completion**." The naive pipeline waits for `ObjectCreated` on the whole file, then encodes. For a 15-second clip that is almost fine. For a 3-hour 4K file, completion is the moment **1,800 GOP windows** become available at once. Finishing a full ladder in 120 seconds after that instant is not elasticity; it is an unbounded burst plant. Meanwhile those 1,800 windows were sitting in object storage for hours during the upload, and the cheap-ladder fleet was idle or working on someone else's already-finished file. UGC clients that PUT a progressive MP4 with `moov` at the end, or a single non-multipart object, make overlap hard — which is an ingest-protocol problem, not a reason to keep EOF-batch as the architecture.

**Decision**: Always-on transcode jobs are enqueued as GOP-aligned chunks **become available during upload**. The 2-minute SLO is a **tail** covering last-chunk cheap encode, playlist publish, and in-region origin/CDN fetch. Assets that cannot overlap (`assets_no_overlap`) are a measured defect class; the SLO is not secretly redefined to make them green. Mechanics: [System Design §2](./03_system_design.md#2-chunking) and [§6](./03_system_design.md#6-latency-budget-the-2-minute-tail).

**Consequences**:
- (+) Long-form playable-start becomes a function of the last ~6s of source, not of duration × rung count.
- (+) Cheap workers stay busy during multi-hour uploads instead of stampeding at EOF.
- (–) Upload protocol is now in this system's blast radius: multipart/fragmented ingest is required for the SLO to apply to long files. A "storage team" that only offers single-PUT will miss the SLO by construction.
- (–) Segmenter must handle incomplete files, aborts, and `moov`-at-end. More moving parts than `ObjectCreated` → FFmpeg.
- **Alternative rejected**: "start after EOF; just buy more workers." Does not create time that already passed during the upload; still loses to AV1-sized work if the ladder is naive ([ADR-002](#adr-002)).
- **Revisit trigger**: ingest is proven ≥95% short clips (<30s) *and* product accepts that long-form is a different SLO. Then overlap is still useful but no longer load-bearing. Measure in Phase 0; do not assume.

## ADR-002: Progressive, Policy-Gated Ladder over Full 12 Rungs for Every Asset

**Status**: Accepted

**Context**: Four resolutions × three codecs is twelve output encodes per source hour. Using public managed-transcode **normalized minutes** as a list-price stand-in, a blended full ladder is on the order of **4,500 NTM / ~$30 per source hour**, which at 1,728,000 hours/day is **~$50 million/day** before storage and CDN — [Scenario — The Math](./01_scenario_and_requirements.md#the-math-the-actual-requirement). Even on owned silicon the **work** remains. Most UGC minutes are never watched in 4K AV1. Encoding that rung for every 15-second clip is how a transcode plant becomes a charity for the CDN of nobody. The SLO, honestly stated, is **playable adaptive playback**, not codec completeness.

**Decision**: An **always-on ladder** (working: H.264 360p and 720p, 1080p when source and budget allow) is encoded for every accepted asset, capped at source resolution (no upscaling). 4K, HEVC, and AV1 are **deferred** and emitted only by policy (priority class, promotion, editorial). Playable vs complete are different asset states. Manifests grow as deferred rungs finish. Details: [System Design §3](./03_system_design.md#3-rendition-ladder-policy).

**Consequences**:
- (+) Encode-minutes drop by a large factor versus 12 rungs (order-of-magnitude on the 30 fps full-ladder worked example if HEVC/AV1/4K drop off the default path). This is the actual cost architecture.
- (+) Cheap-ladder SLO is isolatable from AV1 runtime.
- (–) Some viewers will not get 4K/HEVC/AV1 at T+2m, and long-tail assets may never get them. Product must say this out loud.
- (–) Promotion policy can be wrong (encode too late after virality, or encode too much). That is a tunable; the alternative is encode everything always.
- **Alternative rejected**: "full ladder for every asset; elasticity will save us." Elasticity multiplies a unit cost; it does not shrink it. See [Trade-offs §3](./05_tradeoffs_and_honest_assessment.md#3-cost-in-the-units-that-actually-hurt).
- **Alternative rejected**: "only 360p H.264 always-on." Fails as an **adaptive** product for a video-sharing app except as a shed mode.
- **Revisit trigger**: dedicated silicon makes AV1 as cheap as H.264 **and** CDN savings demand it on the default path. Then AV1 can move always-on **for supported clients**, still without 4K-on-720p-source.

## ADR-003: Warm Baseline + Queue-Age Autoscaling over Fixed-Size EC2 Pools

**Status**: Accepted

**Context**: The current pain is named in the prompt: fixed pools idle in the trough and backlog >5 hours on viral events. The naive fix is HPA on CPU. CPU of a mixed encode pool is a lagging, lying signal (AV1 pins cores while 360p waits; or cores look idle during I/O and you scale down into an SLO miss). Scaling **from zero** cannot meet a 2-minute tail: image pull and process start can consume the entire budget. Scaling the cheap fleet to **last quarter's peak, 24/7** recreates the idle bill, just with YAML.

**Decision**:
- **Warm floor** on the always-on fleet sized to **p50** cheap-ladder encode demand (cost-weighted tokens, not raw job count).
- Scale that fleet toward a **budgeted ceiling** on **backlog age** (and secondarily depth) of always-on channels.
- Deferred fleet **floor zero**, spot/GPU/ASIC, **spend cap**.
- Never a single mixed ASG for all codecs. See [System Design §7](./03_system_design.md#7-compute-tiering).

**Consequences**:
- (+) Trough idle is bounded (cheap floor only, not peak-sized everything).
- (+) Spike capacity exists without pretending cold VMs serve the file that just finished.
- (–) Idle floor is a real invoice. It is SLO insurance. Finance must see it that way or they will shrink the floor until p99 dies.
- (–) Ceiling means a hard "we will shed 1080p / miss SLO / circuit-break ingest" conversation when the funded plant is exceeded. That conversation is healthier than a 5-hour silent queue.
- **Alternative rejected**: fixed desiredCapacity at peak. The prompt's current state.
- **Alternative rejected**: scale-to-zero serverless for always-on. Cold start vs 120s SLO; GPU attach latency; concurrency limits at this volume. Serverless may exist for control-plane glue, not for the encode plant.
- **Revisit trigger**: custom silicon with a different cost curve (always-on ASICs that are cheaper running than VMs idling). The **queue isolation** still holds.

## ADR-004: Priority-Class Weighted Draining over FIFO

**Status**: Accepted

**Context**: FIFO at this mix is how a handful of 3-hour 4K AV1 jobs (or a backfill reprocess) occupy the plant while 15-second clips miss the SLO. Viral news is not "more of the same FIFO"; it is a **class of work that must jump the line** without permanently starving ordinary creators. The old 5-hour backlog is usually **undifferentiated work** plus **too much work per asset** ([ADR-002](#adr-002)), not a lack of `maxReplicas`.

**Decision**: Separate channels for `breaking` / `premium` / `standard` / `backfill`, split again by always-on vs deferred. Consumers use **weighted drain** with a **starvation bound** on `standard` always-on. Shed order is documented and excludes "make it FIFO because we are on fire." Mechanics: [System Design §4](./03_system_design.md#4-priority-scheduling).

**Consequences**:
- (+) News-day degradation is "4K AV1 and backfill wait," not "the app has no new videos."
- (+) Backfill cannot eat the SLO.
- (–) Priority assignment can be gamed (every creator is breaking). Editorial flags need access control; popularity raises are rate-limited.
- (–) More queues, more dashboards, more ways to consume the wrong one. Operational cost is real; one FIFO is simpler and wrong.
- **Alternative rejected**: FIFO plus "we'll put breaking on a faster instance type." Fast instances still pull the wrong jobs if the queue is shared.
- **Alternative rejected**: strict priority with no starvation bound. A week of news can withhold `standard` indefinitely. That is a product outage of a different shape.

## ADR-005: Chunk-Level Idempotent Jobs + Progressive Manifests over Whole-File Retry

**Status**: Accepted

**Context**: Whole-file FFmpeg is simple. A crash at 94% of a 3-hour 12-rung job repeats days of encode-minutes. Spot preemption, OOM, and bad GOPs are **normal** at UGC scale, not edge cases. Gating the manifest until every rung of every chunk exists recreates the "2 minutes for 21,600 jobs" lie. Listing segments that 404 is worse than a backlog: the player breaks.

**Decision**: The work unit is `(asset_id, source_version, chunk_index, rendition_id)` with idempotent origin keys. Failures retry that unit. Manifests advertise **only durable** segments and **only rungs that have a playable prefix**. Always-on holes do not skip time in v1; they stop extending or fail playable. Details: [System Design §5](./03_system_design.md#5-chunk-level-fault-tolerance).

**Consequences**:
- (+) Preemption waste is bounded by one chunk-rung.
- (+) Playable-start does not wait for AV1 chunk 1799.
- (–) Job-system complexity vs one PID per file. State machine, visibility timeouts, and assembler correctness are now the product.
- (–) Non-bitexact GPU encodes complicate "checksum to dedupe races." First durable wins.
- **Alternative rejected**: whole-file job, checkpoint via encoder-specific state. Non-portable, still coarse, still blocks manifests on the slowest rung.
- **Alternative rejected**: publish complete ladder or nothing. Maximizes time-to-first-play. Opposite of the SLO.

## ADR-006: Shared CMAF/fMP4 Origin for HLS and DASH over Dual Encode

**Status**: Accepted

**Context**: HLS and DASH are **manifest formats**. Encoding the same rung twice into `.ts` and `.m4s` (or two independently-gop'd ladders) nearly doubles transcode and storage at a volume where one ladder is already a plant. CMAF exists to make one set of fMP4 fragments serve both. Dual pipelines survive in enterprises that started in 2012 and never paid this invoice.

**Decision**: Encode once to CMAF/fMP4 segments + init segments. HLS `m3u8` and DASH `mpd` are generated over those objects. No second encode to MPEG-TS as v1 architecture. Packaging bugs are assembler bugs, not extra worker fleets.

**Consequences**:
- (+) ~2× encode-minute and storage reduction vs naive dual ladder.
- (+) One GOP alignment, one quality story.
- (–) Ancient HLS-TS-only players (legacy STBs) are not a first-class target. If they are the product, that is a **third** packaging path with a documented audience size — not the default.
- (–) CMAF + HLS + DASH still means two playlist implementations to get wrong. Cheaper than two bitstreams.
- **Alternative rejected**: "MediaConvert / FFmpeg HLS group + DASH group as separate outputs." Convenience in the lab; malpractice at 1,200 hours/minute.
- **Revisit trigger**: a mandated TS-only partner with enough volume to fund a transmux (not re-encode) path. Transmux from CMAF to TS is a packaging job, still not a second encode.

## ADR-007: Hardware Mapped to Job Cost over One Instance Type

**Status**: Accepted

**Context**: H.264 360p 30fps and AV1 4K 120fps are not the same job. A fleet of `c6i.4xlarge` (or a fleet of `p4d`) for everything is either slow-and-expensive on AV1 or idle-and-expensive on 360p. Spot is a good deal for deferred work that can die; it is a bad deal for the always-on SLO if preemption coincides with the last chunk of a breaking video. GPUs/ASICs win on some codecs and lose on others; the bake-off is Phase 3, the **split** is v1.

**Decision**: Always-on H.264 (≤1080p, ordinary fps) runs on a **dense CPU or measured encoder-ASIC/NVENC** pool with a warm floor. Deferred HEVC/AV1/4K/high-fps runs on **GPU/ASIC/spot** with floor zero and a spend cap. Jobs carry **cost tokens** so scheduling is not "12 jobs = 12 jobs." Mapping table: [System Design §7](./03_system_design.md#7-compute-tiering).

**Consequences**:
- (+) Unit economics can improve without touching the ladder policy.
- (+) Spot storms do not 404 a playable ladder.
- (–) Two (or more) node pools, images, autoscalers, on-call graphs.
- (–) Risk of "overflow AV1 onto CPU because GPUs are full" quietly destroying the cheap SLO. Overflow default is **off**.
- **Alternative rejected**: one instance type, simplest Terraform. The prompt asked for cost-optimized compute tiering; this is that, not a reserved keyword in an ASG.
- **Alternative rejected**: everything on GPU. GPU-idle $ at p50 360p load is how you outperform the old EC2 idle bill in the wrong direction.
- **Revisit trigger**: Phase 3 bake-off shows one silicon (e.g. a VCU ASIC) dominates **both** always-on and deferred at this mix. Then pools may merge **physically**; queues must stay **logically** isolated ([ADR-004](#adr-004)).
