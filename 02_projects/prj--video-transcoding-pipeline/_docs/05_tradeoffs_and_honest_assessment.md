# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone promises "every codec, every resolution, globally, two minutes after upload" at **1,200 hours per minute**, or buys a second copy of last year's viral-peak EC2 pool.

The math, once: **1,200 hours/minute is ~1.73 million source hours/day, ~2.4× YouTube's long-cited public upload rate.** YouTube-class plants use **custom encode silicon**, not a clever ASG. A naive 12-rung ladder (4K/1080p/720p/360p × H.264/HEVC/AV1) at managed-transcode list prices is on the order of **$18–$30 per source hour**, which is **~$31M–$52M per day** before storage and CDN. The 2-minute SLO, applied to a 3-hour 4K 120fps file **starting at EOF**, is ~21,600 chunk-rung jobs in 120 seconds. Designing "elastic EC2 plus a queue" is refusing to do that arithmetic.

## 1. What I would build

A **three-plane VOD ingest plant** with a **small always-on ladder** and a **promotion plane**, not a bigger transcoder ASG.

- **Chunked ingest that the encoder can start before EOF.** Multipart / fragmented upload is part of the media architecture. A 3-hour file that arrives as one PUT has already lost the SLO. I would pick that fight with the client team on day one.
- **GOP-aligned chunk jobs** keyed `(asset, version, chunk, rendition)`, idempotent origin writes, progressive CMAF playlists that never list a 404.
- **Always-on H.264 360p+720p (1080p when source and budget allow)**, capped at source resolution. Playable-start p99 ≤ 2 minutes **in-region**, as a tail after last byte.
- **HEVC, AV1, 4K as deferred**, emitted by priority and popularity, not by completeness anxiety. HLS and DASH share one CMAF store.
- **Isolated queues**, weighted drain, starvation bound on ordinary UGC, shed order that pauses backfill and 1080p before it pauses 360p.
- **Warm cheap fleet at p50**, burst to a dollar/quota ceiling on **backlog age**. Deferred on spot/GPU/ASIC, floor zero, spend cap. Custom silicon when the VM math loses — which, at the prompt's headline rate, I would expect **before** "we scaled HPA for a year."
- **Canaries and split metrics from the first production ingest**: playable-start, overlap rate, cheap vs deferred age, $/source-hour, CDN 404-on-listed-segment as SEV.

If Phase 0 discovers ingest is 50 hours/minute of 15-second 720p clips, this looks slightly heavy. Build the **seams** anyway (chunk keys, isolated queues, playable vs complete, policy-gated rungs). Shrink the plant. Do not shrink the design into "one FFmpeg per file on an ASG" and spend the first viral event re-adding everything the seams were for.

## 2. What I would give up

Be explicit. These are not "later" disguised as principles. Some are never in this design.

**A uniform 2-minute SLO for every rung of every file at every CDN POP.** Playable-start on the cheap ladder, in-region (or well-connected POP), after last byte, with overlap. Global worst-POP and 4K AV1 completeness are different contracts. I would not sign a single sentence that conflates them.

**Encoding 4K / HEVC / AV1 for every upload.** Long-tail 4K sources may stay 1080p H.264 forever. That is how the plant is payable. Viewers on premium/viral get the expensive rungs.

**Upscaling.** A 720p phone clip will not get a 4K rung so the matrix looks rectangular on a wiki.

**Zero backlog under a true viral spike.** Cheap-ladder age stays bounded **up to the funded ceiling**. Deferred freshness goes red on purpose. If ingest exceeds the ceiling, I would rather shed 1080p or circuit-break `standard` ingest than recreate a 5-hour FIFO. "We never drop work" at this volume is "we drop time-to-play instead."

**Scale-to-zero always-on workers.** Cold start eats the SLO. Idle floor is the fee.

**FIFO simplicity.** One queue is how AV1 starves clips.

**Whole-file retry and "publish when 12/12 rungs exist."** Simple operational story; hostile to the SLO and to spot.

**Dual encode for HLS and DASH.** Packaging twice is not completeness; it is waste.

**Managed transcode (MediaConvert-class) as the system of record at 1,200 hours/minute.** Fine for a prototype slice. As production volume, the list-price math is a finance incident even after volume discounts. Overflow "just for spikes" has a way of becoming the median.

**Live linear / DVR** smuggled into this VOD plant. Different topology.

**Bitexact global quality parity across codecs at launch.** AV1 will lag; presets will be "good enough for UGC." Per-title encoding is Phase 3 vanity until playable-start is real.

**The fantasy that more workers fix a 12-rung policy.** If the policy is wrong, N=10,000 copies of wrong.

## 3. Cost, in the units that actually hurt

**Encode-minutes of expensive rungs, not "number of instances," is the scary number.**

- Full-ladder managed NTM: ~2,700 (30 fps floor) to ~4,500 (blended) per source hour → **~$18–$30/hour list** → **~$31M–$52M/day** at the prompt rate. Teams that only quote "$0.015 per normalized minute" without multiplying by twelve rungs × 1.73e6 hours are lying by omission.
- Dropping HEVC, AV1, and 4K from the default path cuts **work** by roughly **~5–9×** on the 30 fps worked example (always-on H.264 three rungs ≈ 300 NTM-equivalent vs 2,700). Mix can do better (phone 720p → two rungs) or worse (everything is 4K 120fps). Phase 0.
- Self-hosted/ASIC then applies another efficiency factor (public YouTube-class claims ~20–33× vs CPU for their VCUs — **their** silicon, **their** mix, not a purchase order you can copy this quarter). Even a boring reserved CPU fleet beats NTM list **if it is busy**. Busy is a function of overlap + mix + not encoding garbage rungs.

**Idle capacity is the second scary number — the one the prompt already has.**

- The old fixed pool pays peak-sized idle 20 hours a day. The new floor pays **p50 cheap-ladder** idle. That is still not free. If finance shrinks it to p10, the 2-minute p99 is theater.
- Spot deferred can approach zero in the trough. Preemption waste is bounded by chunk size **only if** jobs are chunk-scoped. Whole-file spot is how you throw away 2.8 hours of GPU.

**CDN egress will eventually rival or beat transcode.**

- That is the only good reason AV1/HEVC exist here. Spend those minutes on **watch-hours**, not on **ingest-hours**. Encoding AV1 for a clip with 12 views is lighting money on fire to save twelve times a few megabytes.

**Storage of sources and unused rungs is a quiet killer.**

- Keep-forever 4K 120fps mezzanine + 12 outputs is a second plant. Lifecycle is architecture. Takedown order (playlists first) is legal architecture.

**Engineering time dominates year one if the mix is real UGC.**

- GOP nightmares, `moov` at end, player-specific playlist bugs, assembler 404s. Not the Kubernetes conference talk. A two-week "we picked MediaConvert vs self-hosted FFmpeg" bake-off that skips Phase 0 mix measurement is how you buy the wrong size of the right encoder.

## 4. Why "just add more workers" is not a full answer

This is the bar the scenario sets for a serious design. Horizontal workers are a **throughput** tool. They are not a strategy.

**The 2-minute clock does not start when you scale.** If work begins at EOF, duration is already behind you. 10,000 workers cannot encode chunks that were uploadable two hours ago. Overlap is the strategy; workers are how the tail fits.

**Cold start is inside the SLO.** Burst VMs that become useful in four minutes do not rescue a file that completed sixty seconds ago. Warm floor exists because of this. "Elastic" from zero is a trough-cost story, not a tail-latency story.

**FIFO + more workers still starves the wrong work.** If the extra capacity pulls 4K AV1 and backfill first (or at random), 15-second clips still wait. The 5-hour backlog can happen on a **large** fleet. Isolation and tokens are the strategy.

**GPU/ASIC quotas and spot capacity are finite.** A viral day is when the whole industry's spot pool is also on fire (sports, news, other video apps). Your scale-out plan that assumes infinite `p4d` in one AZ is a slide. Shed order is what you do when the ceiling is real.

**Manifest correctness does not improve with N.** Two workers racing a non-idempotent write, or an assembler that lists a segment early, get **worse** under more concurrency. Chunk keys and "durable then advertise" are the strategy.

**CDN physics does not improve with N.** Encoding faster in `us-east-1` does not PUT bits into a POP in Johannesburg. Pull vs targeted push is the strategy. Push-everything is another infinite-worker fantasy, on the network side.

**Unit work does not shrink with N.** 12 rungs × 1.73e6 hours/day is a plant at N=100 and a larger plant at N=10,000. Policy ([ADR-002](./04_architecture_decision_records.md#adr-002)) is the strategy.

**Quality bugs replicate.** Bad GOP split, upscaling, TS+fMP4 dual encode: more workers copy the bug faster and more expensively.

What I would do instead, in order: measure mix and overlap fraction; **cut default rungs**; overlap ingest; isolate cheap vs deferred; token-weight jobs; warm-floor p50; burst on **age** to a **ceiling**; spend-cap deferred; promote expensive codecs on watch-hours; talk silicon when VMs lose. That list is ADRs 001–007. A scaling RFC that only contains a new `maxReplicas` is incomplete and I would send it back.

## 5. What changes if the content mix is not the horror story

The prompt gives a **range** (15 seconds to 3-hour 4K 120fps) and a **headline rate**. The architecture is the same shape; the **plant and the panic** are not. Name the mix in Phase 0 or every capacity meeting is fiction.

| If the real world is… | Encode plant (order of) | What I would actually do |
| --- | --- | --- |
| **1,200 h/min as stated, mixed, with a 4K/long tail** (this design's default reading) | Hyperscale; ASICs on the table in year one | Full design as written. Policy-gated ladder, overlap, isolated fleets. Managed transcode is a lab. |
| **1,200 h/min but ~all 15s 720p 30fps phone clips** | Still enormous **ingest count**, much smaller **encode-minutes per hour of source** (two H.264 rungs, overlap almost irrelevant, 2-minute SLO easy if queues are isolated) | Keep seams. Size cheap fleet to **job QPS** (millions of tiny jobs) more than to 4K tokens. Promotion of AV1 still on virality. Watch queue overhead (millions of 6s jobs can DDoS the scheduler — batch tiny clips). |
| **Rate was off by 10× (120 h/min)** | Large, not YouTube-exceeding | Same design, smaller ceiling; reserved CPU might win for longer before ASICs. Still no full 12-rung default. |
| **Rate was off the other way, or 4K 120fps is the median hour** | The 2-minute even-on-cheap-ladder tail may fail for last-chunk 4K-downscale + re-GOP | Phase 0 kill/escalate: drop 1080p from always-on, lengthen SLO for long-form, or fund a much larger floor. Do not "add workers" past the point last-chunk physics lose. |
| **Almost no multipart; everything is moov-at-end single PUT** | Overlap dead | Either change the client (the real fix) or admit the SLO applies only below duration D. Designing the encoder as if overlap existed is malpractice. |
| **Legal requires pre-play scan of full decode** | Scan plant on the critical path | Recast SLO; may need scan-as-you-upload too. This design's default (scan off the playable path) is then wrong. |

If the business will not fund Phase 0 measurement, I would refuse to size the encode floor. Guessing that "average video is 45 seconds at 720p" to two significant figures is already a professional risk; buying GPUs on it without sampling production uploads is malpractice.

## 6. Brutal summary

The clever design is not a bigger worker pool. The clever design is **treating transcode as a policy and a tail**: overlap so duration is not the enemy, encode a cheap adaptive ladder for everyone, spend HEVC/AV1/4K where watch-hours pay, isolate queues so news days delay the expensive work instead of the playable work, size a warm floor to p50, and tell the truth about what "2 minutes" and "edge CDN" mean.

A 2-minute playable-start at this scale is feasible **if** ingest is chunked, the always-on ladder is small, cheap workers are warm and unstarved, and last-chunk work is ~seconds. It is not feasible if the ladder is 12 rungs, work starts at EOF, AV1 shares the FIFO, and "distributed to edge" means every POP is primed for every clip.

If they wanted FFmpeg on Kubernetes with HPA, this document is too long. If they wanted 1,200 hours a minute in production without a nine-figure surprise, it is the minimum honesty.
