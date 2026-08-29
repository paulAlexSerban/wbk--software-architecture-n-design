# Distributed Video Transcoding & Adaptive Bitrate Pipeline: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

A video-sharing app receives **1,200 hours of user-generated video uploads every minute**, ranging from 15-second mobile clips to 3-hour 4K 120fps files. The ingestion pipeline must validate uploaded files, chunk them into uniform segments, transcode them into multiple resolutions (4K, 1080p, 720p, 360p) and codecs (H.264, HEVC, AV1), assemble HLS/DASH manifests, and distribute assets to edge CDNs **within 2 minutes of upload completion**.

The existing infrastructure relies on **fixed-size EC2 computing pools**, leading to high idle costs during low-traffic periods and processing backlogs **exceeding 5 hours** during viral news events. The platform requires an elastic, event-driven transcoding queue, priority-based workload scheduling, chunk-level fault tolerance, and cost-optimized compute tiering.

The design must answer, concretely:

1. Why "spin up more EC2 when the queue is deep" is not a complete architecture at this volume.
2. How a 2-minute SLA can be honest for both a 15-second clip and a 3-hour 4K file.
3. Which renditions exist for every asset at T+2 minutes, and which are allowed to lag.
4. What that honesty costs in product (some viewers will not get 4K AV1 immediately) and in operations (two fleets, a ladder policy, a popularity plane).

This is the **full-ladder-plus-fixed-pool trap**. The naive answer — keep the same 12-rendition matrix, replace the ASG with a "smarter" one, and promise the same 2-minute clock for every codec of every file — is the failure. It treats a capacity-and-policy problem as a queueing problem. Elasticity is real and it must be named, because the current idle/backlog pain *is* what is failing today. It is not the architecture.

The correct shape is: **transcode GOP-aligned chunks as they arrive during the upload; publish a playable HLS/DASH manifest from a cheap, always-on ladder within 2 minutes of the last byte; defer expensive renditions (4K, HEVC, AV1) behind a measured popularity/priority policy; drain work from priority queues onto a warm baseline plus burst/spot/ASIC tiers.**

That paragraph is the whole architecture. Everything else in this project is the honest cost of making it true under viral spikes, chunk retries, progressive manifests, and a finance team that will eventually see the invoice.

## The Trap, Stated Directly

Fixed EC2 pools fail in the two directions the prompt names: they are too big at 3 a.m. and too small on a breaking-news afternoon. Replacing "fixed" with "autoscaled" without changing **what you encode** and **when you start encoding** produces a third failure: a burst fleet that still cannot finish a 3-hour 4K file × 12 renditions in 120 seconds after upload, and a monthly bill that looks like a hyperscaler's R&D budget.

The "2 minutes of upload completion" clause is load-bearing and, taken as "every rendition of every asset," physically dishonest. A 3-hour file chunked into ~6-second GOP-aligned segments is **~1,800 chunks**. Twelve renditions is **~21,600 independent encodes** for one asset. Starting that work when the last byte lands, and finishing it in 120 seconds, is not "elastic." It is a demand for an instantaneous, fully-warmed, fully-utilized supercomputer sized to the worst file on the worst day.

The correct reading of the SLA, which this design will defend in writing and refuse to let product management quietly un-read, is: **a viewer can start playback of a useful adaptive ladder (at least H.264 360p and 720p, preferably 1080p) within 2 minutes of upload completion, globally via CDN, with remaining rungs appearing as they complete.** Anything stricter is a different system with a different silicon budget. See [ADR-001](./04_architecture_decision_records.md#adr-001) and [ADR-002](./04_architecture_decision_records.md#adr-002).

## Current State (Assumed Starting Point)

A typical first version of this path looks like:

1. Client uploads the whole file to object storage (or worse: through the app; that is a different project — [large-file-upload-redesign](../../prj--large-file-upload-redesign/README.md)).
2. An `ObjectCreated` event lands on a single FIFO or SQS queue.
3. A worker pulls the whole object, runs a monolithic FFmpeg (or MediaConvert) job that emits the full ladder, writes segments, writes manifests, invalidates or pushes CDN.
4. The worker fleet is an EC2 ASG with a **fixed desired capacity** sized to "a busy Thursday," because last quarter's viral event caused a 5-hour backlog and someone swore never again — so the fleet now idles at 40% on ordinary days and still backlogs when a 4K 120fps dump coincides with a news spike.

That version will appear to work in staging with a 30-second 720p phone clip. It will fail in production the first time a 3-hour 4K file retries from byte 0 after a mid-job OOM, the first time AV1 encodes occupy the entire pool while 15-second clips wait, and the first month finance asks why transcode is a nine-figure line item.

This project documents the replacement, not a patch of the ASG min/max.

## The Math (the actual requirement)

This is the constraint every other document in this project exists to respect. It is not a preference for CMAF. It is a capacity, latency, and cost ceiling.

### 1,200 hours/minute is hyperscale, not "a popular app"

| Quantity | Working value | Why it is load-bearing |
| --- | --- | --- |
| Ingest rate (stated) | 1,200 hours of source video **per minute** | The number in the prompt. |
| Per hour | 72,000 hours of source / hour | 1,200 × 60. |
| Per day | **1,728,000 hours of source / day** | 1,200 × 1,440. |
| YouTube's long-cited public figure | ~500 hours/minute (~720,000 hours/day) | Held roughly since ~2019 in public statements. Working comparison, not a claim we have YouTube's internal number. |
| This scenario vs that figure | **~2.4×** | YouTube runs warehouse-scale transcoding on **custom ASICs** (Argos-class VCUs), quoted publicly as ~20–33× more efficient than CPU. "We will use elastic EC2" is not how that comparison closes. |

**The conclusion, which is not optional:** this volume is a **hyperscaler media platform**, not a startup that outgrew its ASG. A design that only talks about Kubernetes HPA has not finished reading the prompt. Phase 0 must still measure the *mix* (clip vs long-form, 360p phone vs 4K 120fps), because mix dominates the bill — but the headline rate, if taken as stated, already forbids a pure pay-per-use managed-transcode architecture. See [Trade-offs §5](./05_tradeoffs_and_honest_assessment.md#5-what-changes-if-the-content-mix-is-not-the-horror-story).

### The naive 12-rendition ladder is a finance incident

Four resolutions × three codecs = **12 output renditions per source hour**, if every asset gets everything. Transcoding is billed (and costed internally) on **output minutes**, scaled by resolution, frame rate, codec, and quality passes. AWS Elemental MediaConvert's public **normalized transcoding minute (NTM)** model is used here as a **stand-in for generic cloud transcode list price**, not as a vendor commitment. Self-hosted cost is a different (better) number; the NTM model exists to show why "just call a managed API" dies.

Working multipliers (Professional-tier shape, labeled as such):

| Attribute | Working multiplier |
| --- | --- |
| SD (≤720p exclusive; we treat **360p as SD**) | 1× |
| HD (**720p and 1080p**) | 2× |
| 4K | 4× |
| ≤30 fps | 1× |
| ≤60 fps | 2× |
| >60 fps (the 120fps case) | 3× |
| H.264 / AVC | 1× |
| HEVC or AV1 | 2× |
| Single-pass | 1× |
| Multi-pass | 1.5× |

**Worked example A — 1 hour of source, 30 fps, single-pass, full 12-rung ladder** (this is a **floor**, not a typical 4K 120fps file):

| Rung | Res × codec | NTM for 60 output minutes |
| --- | --- | --- |
| 360p × H.264 / HEVC / AV1 | 1×1 + 1×2 + 1×2 | 60 + 120 + 120 = **300** |
| 720p × H.264 / HEVC / AV1 | 2×1 + 2×2 + 2×2 | 120 + 240 + 240 = **600** |
| 1080p × H.264 / HEVC / AV1 | 2×1 + 2×2 + 2×2 | 120 + 240 + 240 = **600** |
| 4K × H.264 / HEVC / AV1 | 4×1 + 4×2 + 4×2 | 240 + 480 + 480 = **1,200** |
| **Total** | | **2,700 NTM per source hour** |

**Worked example B — mixed-rate working number** (some 60 fps HD/4K, still single-pass): 1080p and 4K at 60 fps doubles those rungs → 1080p 1,200 NTM + 4K 2,400 NTM, 360p/720p unchanged at 30 fps → **4,500 NTM per source hour**. This is the **working blended figure** used in the rest of these docs. A 4K **120 fps** source that is also output at 120 fps is worse (3× frame-rate on the 4K rungs). Multi-pass HQ is worse again (1.5×).

Public volume-discount professional rates (US East, over 2M NTM/month — we are *always* over 2M) are on the order of **$0.0066 per NTM**. Floor example A: 2,700 × $0.0066 ≈ **$18 per source hour**. Blended example B: 4,500 × $0.0066 ≈ **$30 per source hour**.

At 1,728,000 source hours/day:

| Cost model | Per day | Per 30-day month |
| --- | --- | --- |
| Managed NTM, example B (~$30/source-hour) | **~$52 million** | **~$1.55 billion** |
| Managed NTM, example A floor (~$18/source-hour) | **~$31 million** | **~$930 million** |

This is **transcode compute list price only**. It excludes: mezzanine/source storage, rendition storage (12 packed ladders are not free), CDN egress (usually the *other* terrifying number, and the reason AV1/HEVC exist), packaging, DRM, and the control plane. It also assumes you actually encoded the full ladder for **every** hour, including the 15-second clip that will be watched twice on a phone.

**The conclusion, which is not optional:** the architecture spends its complexity on **not encoding that ladder**, not on a prettier queue. Self-hosted CPU/GPU/ASIC can cut the dollar figure by a large factor (YouTube-class silicon quotes 20–33× vs CPU; even ordinary reserved GPU/CPU fleets beat NTM list). They do not cut the **work**. A 20× efficiency win on a $1.55B NTM-equivalent still leaves a hyperscale plant. Popularity-gated rungs and a cheap always-on ladder are how the work itself shrinks. See [ADR-002](./04_architecture_decision_records.md#adr-002) and [Architecture — Cost](./02_architecture_document.md#cost-analysis).

### The 2-minute clock is a tail, not a batch window

| Assumption | Working value | Why it is load-bearing |
| --- | --- | --- |
| Segment duration | ~6 seconds, GOP-aligned | HLS/DASH convention; tension with seek granularity and per-job overhead. See [System Design §2](./03_system_design.md#2-chunking). |
| 3-hour source | 10,800 seconds ≈ **1,800 chunks** | 3 × 3,600 / 6. |
| Full ladder jobs | 1,800 × 12 = **21,600 encodes** | One asset. |
| Encode time per 6s chunk | Highly codec/preset/hardware dependent; **1× realtime is optimistic for quality H.264, fantasy for AV1 on CPU** | Used only to show the burst math, not as an SLO. |

If work starts **after** upload completes, finishing 21,600 jobs in 120 seconds requires an absurd parallel burst **for that one file**, plus every other file that finished in the same two minutes. If work is **overlapped with a chunked/multipart upload**, 1,799 chunks can already be in the cheap ladder (or further) by the time the last part lands. The 120-second budget then covers: last-chunk validate + last-chunk cheap encode + manifest publish + CDN origin fetch/TTL. That is a system. The other thing is a wish.

Short clips do not get a free pass on the overlap argument: a 15-second clip is ~3 chunks, so overlap buys less. They **do** get a free pass on parallelism: three cheap H.264 rungs are a small, warm-pool job. The SLA is designed around **playable start**, which short clips naturally meet if the cheap ladder is never starved by 4K AV1. That starvation is the current 5-hour backlog's usual cause, not "we needed more of the same instances." See [ADR-004](./04_architecture_decision_records.md#adr-004).

## Target Users

- **Platform / media-pipeline engineer**: owns ingest, queues, workers, manifests. Needs a design they can defend when someone asks why 4K AV1 is not on every video at T+2m.
- **On-call**: needs backlog age **per priority class and per rung**, not a single SQS depth, so a viral spike is a degraded-mode event with a runbook, not an undifferentiated 5-hour graveyard.
- **Finance / capacity**: needs the NTM-equivalent math and the "what we refuse to encode" policy in writing, because the alternative is a surprise nine-figure bill.
- **Product / creator tools**: needs to know that "available" means "playable on a useful ladder," and that 4K/AV1 is a promotion, not a human right of every upload.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (player chrome, comments, recommendations) are out of scope.

1. **Ingest must not wait for the last byte to start useful work.** Chunks are validated and cheap-ladder-encoded as they become available. The 2-minute SLA is a **post-completion tail**, not a batch window. See [ADR-001](./04_architecture_decision_records.md#adr-001).
2. **A playable adaptive ladder must exist within 2 minutes of upload completion** for the cheap, always-on rungs (working default: H.264 360p + 720p, 1080p if budget allows). This is the SLO. "All 12 rungs" is not. See [ADR-002](./04_architecture_decision_records.md#adr-002).
3. **Expensive rungs (4K, HEVC, AV1) are policy-driven**, not automatic. Promotion is a control-plane decision (priority class, measured popularity, creator tier, source resolution). Encoding 4K AV1 for a 360p-source 15-second clip is a bug, not completeness.
4. **The worker fleet is elastic and event-driven**, scaled primarily on **per-tier queue depth and backlog age**, with a **warm baseline sized to steady p50 cheap-ladder load**, not to peak full-ladder load. See [ADR-003](./04_architecture_decision_records.md#adr-003).
5. **Scheduling is priority-class, not FIFO.** A viral spike delays backfill and deferred rungs, not the cheap ladder of newly uploaded clips. Starvation of low-priority work is bounded, not infinite. See [ADR-004](./04_architecture_decision_records.md#adr-004).
6. **Faults are at chunk/rung granularity.** A failed GOP or a preempted spot encode retries that `(asset_id, chunk_index, rendition_id)` job. The asset does not restart. Manifests are published **progressively** and remain playable with a subset of rungs. See [ADR-005](./04_architecture_decision_records.md#adr-005).
7. **HLS and DASH share a CMAF/fMP4 segment store.** Dual independent encodes for two packaging formats are forbidden at this volume. See [ADR-006](./04_architecture_decision_records.md#adr-006).
8. **Compute is tiered by job cost**, not one instance class. Cheap H.264 SD/HD on dense CPU (or ASIC); HEVC/AV1/4K/high-fps on GPU/ASIC/spot with a cost ceiling. See [ADR-007](./04_architecture_decision_records.md#adr-007).
9. **CDN distribution is part of the 2-minute tail**, not a follow-up ticket. Origin must be fetchable (pull) or pre-positioned (push for hot/priority) such that a viewer in a remote POP can start playback inside the SLO under ordinary cache-miss conditions — or the SLO is a lie about "our origin."
10. **Validation rejects garbage early** (not a container, truncated last part, codec the pipeline cannot decode, malware if required) without occupying transcode workers. Failed validation is a coverage hole on that asset, not a silent empty manifest.

## Success Criteria for the Design (Not Implementation Metrics)

All numeric targets below are **starting points to be calibrated in Phase 0**, not facts.

1. **Playable-start p99 ≤ 2 minutes** after upload completion, measured as: first CDN-reachable HLS/DASH master playlist containing at least the **always-on ladder**, at the agreed QPS/ingest mix. p50 is a vanity metric if p99 is the contract.
2. **Cheap-ladder backlog age p99** stays inside a few minutes under a **rehearsed viral-spike test** (Phase 3). Deferred-rung backlog is allowed to grow; cheap-ladder backlog is not allowed to become the old 5-hour graveyard.
3. **A injected chunk failure** (kill a worker mid-GOP) does not restart the asset; the chunk is retried; the manifest never advertises a segment that is not actually fetchable.
4. **Idle cost of the cheap-ladder warm pool** is an accepted, budgeted line — not an accident of sizing to last quarter's peak. Spot/burst for deferred rungs scales toward zero when those queues are empty.
5. **Cost per source hour** (internal, all tiers) is tracked against a budget derived from the ladder policy, not against "we encoded 12 rungs so of course it is large."
6. **Operator toil**: a viral event is a dashboard and a priority-shed runbook, not a war room that `desiredCapacity += 500` by hand.

## Business Rules (Pipeline-Scoped)

1. The always-on ladder is encoded for every **accepted** asset whose source resolution and duration justify it (do not upscale 360p sources to 4K; do not skip 360p for 4K sources).
2. Source resolution is a **cap**, not a target. A 720p upload never receives 1080p or 4K rungs. Upscaling is a quality and cost bug.
3. Manifests are rewritten as rungs and segments complete. Players must tolerate additional variants appearing (standard HLS/DASH). Removing a published segment is a defect.
4. Priority class is assigned at ingest (and may be raised by the popularity service). Workers must not be allowed to "just pull from the global queue" under load; that is how the 5-hour backlog returns.
5. Spot interruption is an expected completion path: checkpoint or restart **that chunk job**, not the asset.
6. An asset is **playable** when the always-on ladder's segments through the last fully-uploaded chunk are in origin (and, for the SLO, fetchable at edge under the CDN design). It is **complete** when all **policy-selected** rungs exist. Those are different states. Completeness is not the 2-minute SLO.

## Non-Goals

- **Not live linear streaming.** This is VOD with pipelined ingest. Low-latency live, DVR windows, and ad-stitched live are a different architecture (always-on encoders, different SLA, different CDN). Do not smuggle them in.
- **Not a DRM / content-ID / copyright-match product.** Those can subscribe to "asset became playable." They are not this pipeline. If the legal team requires a scan before *any* playback, that scan is on the 2-minute critical path and Phase 0 must say so — it is a different SLO.
- **Not a player or client SDK.** Manifest correctness and segment naming are in scope; UI is not.
- **Not a multi-cloud transcode abstraction.** One primary compute fabric. A second region is DR/capacity, not a plugin framework.
- **Not an implementation.** No FFmpeg flags, no Terraform, no Kubernetes YAML. Numbered steps and diagrams only.
- **Not a claim that every asset gets every codec at T+2m.** That claim is the trap.
- **Not a claim that elastic VMs replace custom silicon at YouTube-exceeding volume.** Burst VMs are how you survive the day. ASICs/reserved dense encode are how you survive the year. Phase 0/3 decide when the latter is mandatory; the docs do not pretend EC2 spot is a personality.

## Constraints the Prompt Hides (Phase 0 exists to name them)

| Unknown | Why it is load-bearing | Fallback assumption until measured |
| --- | --- | --- |
| Content-length mix (15s vs 3h) | Overlap benefit, chunk count, SLA difficulty | Working: heavy short-form tail, thin long-form that dominates encode minutes |
| Source resolution / fps mix | 4K 120fps is a different plant than 720p 30fps | Working: most hours are HD 30fps; 4K is the expensive tail |
| What "2 minutes" actually means to product | Playable start vs full ladder vs global CDN hit | **Playable start, always-on ladder, CDN pull with origin warm** |
| Whether audio is a first-class ladder (multiple languages, Atmos) | Can dominate packaging; ignored in the 12-rung video math | Stereo AAC, one language, muxed or CMAF audio track — revisit if false |
| DRM / pre-play scan | Adds a serial gate on the SLO | Out of v1 critical path unless legal forces it |
| Geographic ingest vs viewership | CDN push vs pull, multi-region encode | Single primary encode region, global CDN pull |
| Peak/p50 ingest ratio on viral days | Warm pool vs burst | Working: 5–10× p50 on named events; design must not size warm pool to that |

Until Phase 0 replaces these, every hardware number in these docs is a **working assumption labeled as such**, not a fact.
