# Distributed Video Transcoding Pipeline — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not documentation theater** — sizing an encode plant off a guessed clip-vs-4K mix is how you buy a GPU farm that idles on 15-second videos and then "add more workers" in a war room when a 3-hour dump lands.

Phases 0–4 are sequential. Phase 5 is ongoing operations after serving production ingest. A later phase must not start because a calendar slide said so if the previous gate is yellow.

Rollback/kill criteria at the bottom apply at every phase. In particular: **never take production ingest without playable-start, cheap-vs-deferred backlog age, and "listed segment 404" alerts on the serving path.** That is not a follow-up ticket.

Calendar is *not* "two sprints." Phase 0 might be a week if logs already exist. A correct always-on ladder on a **sample** might be weeks. A plant that absorbs **1,200 hours/minute** is a function of mix, silicon, and CDN — **months to years** — and is not an exit gate of Phase 1. Anyone who schedules "full 12-rung global 2-minute SLO at headline rate" at the end of month one has not read [Scenario — The Math](./01_scenario_and_requirements.md#the-math-the-actual-requirement).

## Phase 0 — Measure the Mix, the SLO, and the Upload Protocol (before silicon)

**Objective**: Replace the load-bearing guesses (duration/resolution/fps mix, what "2 minutes" means, whether uploads can overlap, whether 1,200 h/min is literal) with measurements and a written SLO. Refuse to size the cheap floor until this gate is green.

**Deliverables:**
- **Ingest rate named in writing**: confirm 1,200 hours/minute vs actual. If actual is 10× smaller or larger, the rest of the docs still apply; the **plant** does not. See [Trade-offs §5](./05_tradeoffs_and_honest_assessment.md#5-what-changes-if-the-content-mix-is-not-the-horror-story).
- **Stratified sample** of real uploads: duration histogram (p50/p95/p99), source width/height/fps/codec, GOP length, `moov` placement / fragmented vs progressive, multipart vs single PUT.
- **Overlap feasibility**: `% of ingest-hours` that could have emitted a closed GOP before EOF with the current client. If this is ~0, the SLO conversation changes **now**.
- **Playable-start SLO written down**: always-on rungs listed; "2 minutes" bound to `upload_completed_at` → in-region CDN GET of master + segment 0; explicit **non-goals** (full ladder, worst POP, AV1). Product signature.
- **Deferred freshness target** as a number or "none, best effort" — do not leave implied.
- **CDN POP definition** for the SLO (which regions count).
- **Legal scan** on or off the playable path, in writing.
- **Golden fixtures**: 15s phone clip, 3-min 1080p, worst-GOP sample, one long-form 4K if it exists in the corpus (even if rare).
- **NTM-equivalent / token model v0** from the sample (encode-minutes per source hour for the proposed always-on ladder vs full 12 rungs).
- One-page unknowns log: each item `measured` or `open, fallback assumption is X`. Open items that kill feasibility (literal 1,200 h/min of median 4K 120fps, 2-minute **full** ladder, no overlap, no ASIC budget) are flagged immediately.

**Exit Gate:**
- [ ] Mix histograms exist from production (or a declared synthetic mix if this is a greenfield showcase — then every hardware number stays labeled **hypothetical**).
- [ ] Playable vs complete SLO is unambiguous in the design header.
- [ ] Overlap feasibility is a percentage, not a hope.
- [ ] Always-on rung list is signed; 4K/HEVC/AV1 are in or out of the 2-minute clock **explicitly**.
- [ ] Feasibility call: **always-on token rate at p50 fits a fundable warm floor and last-chunk physics fit 120s → proceed.** **Headline rate × full 12 rungs × EOF-batch × 120s × managed list price → kill/escalate**, do not quietly enter Phase 1 as if GPUs will appear.

Do not buy the full GPU/ASIC fleet in Phase 0. Buy enough to time last-chunk encodes of the fixtures on candidate hardware.

## Phase 1 — Ingest, Segment, Always-On Ladder on a Sample (correctness)

**Objective**: Prove the data path: chunked ingest → validate → GOP segment → H.264 always-on rungs → CMAF origin → HLS **and** DASH from the **same** segments. No autoscaling. No priority fabric yet (single cheap queue). No deferred rungs. Correctness over scale.

**Deliverables:**
- Upload path that can emit parts before EOF (even if the production app still also allows single-PUT — that class is metriced).
- Validator writes `source_profile`; rejects garbage; **no upscale** jobs exist in the template.
- Segmenter per [System Design §2](./03_system_design.md#2-chunking) with stable `chunk_index` and `source_version`.
- Cheap workers: always-on rungs only; idempotent `segment_key`; ack after durable PUT.
- Manifest assembler: progressive rules; **never lists missing segments**; HLS + DASH share CMAF ([ADR-006](./04_architecture_decision_records.md#adr-006)).
- Fixtures fully processed; player matrix (two browsers, one mobile, one TV-class if in-product) plays to end without GOP-glitch at boundaries.
- Tests: kill worker mid-chunk → no 404 in playlist; retry same job_id → one playable timeline; 720p source → no 1080p/4K objects.
- `playable_start_ms` and `assets_no_overlap` implemented on the sample.

**Exit Gate:**
- [ ] Fixtures play from HLS and DASH against the same origin bytes.
- [ ] Injected worker death does not advertise a 404 segment.
- [ ] No upscaled renditions in origin for a sub-1080p fixture.
- [ ] Overlap path demonstrated on a **long** fixture (minutes, not 15s): jobs exist before EOF.
- [ ] No production traffic. This gate is not a launch.

If GOP-glitch rate on the real sample is catastrophic, **stop and fix segment/mezzanine** before any scaler. Do not "make up for it with more bitrate."

## Phase 2 — Queues, Priority, Chunk Fault Tolerance, Instrumented Tail Budget

**Objective**: Put the production control shape on the sample (or a larger slice): isolated always-on channels, weighted drain, DLQ, progressive playable flip, per-stage tracing of the 2-minute tail. Prove **wait vs encode vs CDN** before multiplying workers.

**Deliverables:**
- Priority fabric per [System Design §4](./03_system_design.md#4-priority-scheduling); backfill channel exists even if unused.
- Starvation-bound test: flood `breaking` and show `standard` still drains within bound.
- Shed-1080p kill-switch tested; metric `assets_shed_1080p`.
- DLQ + hole policy (do not skip time on always-on) tested.
- Tracing: last-part close, queue wait, encode per rung, origin PUT, playlist rewrite, CDN GET.
- Load test at **sample** ingest rate, not at 1,200 h/min. Record p50/p95/p99 vs the [ledger](./03_system_design.md#6-latency-budget-the-2-minute-tail).
- Game day: FIFO-merge "incident fix" is **blocked** by design (consumers cannot read the wrong channel without a one-way config that pages).

**Exit Gate:**
- [ ] p99 playable-start on this cluster is **explained by stages**. If wait dominates, do not proceed to "need GPUs."
- [ ] Breaking flood does not permanently starve standard (bound fires).
- [ ] Listed-segment 404 synthetic test pages.
- [ ] Still no deferred fleet required for this gate.

## Phase 3 — Compute Tiering, Cost Dashboards, Rehearsed Spike

**Objective**: Split hardware classes; put money on a graph; prove the viral story against a **ceiling**, not against infinite quota.

**Deliverables:**
- Cheap fleet with **floor** (p50 from Phase 0 tokens × measured encode rate) and **ceiling**.
- Autoscaler on **backlog age**, not mixed CPU ([ADR-003](./04_architecture_decision_records.md#adr-003)).
- Deferred pool (can be small): one expensive rung on spot or GPU for **fixtures only**, preemption retry proven ([ADR-007](./04_architecture_decision_records.md#adr-007)).
- Job **tokens** used in scheduling (a 4K chunk is not "one job").
- Cost dashboard: $/source-hour, encode-minutes by rung, idle floor $, spot waste.
- **Spike test**: N× sample ingest for a defined window (working: 5× for 1 hour, or whatever finance will fund). Observe: always-on p99, deferred freeze, scale-up lag vs SLO, shed order.
- Cold-start measurement: time from scale-up signal to first useful encode. If > SLO slack, **document that burst does not save in-flight tails** — floor remains mandatory.

**Exit Gate:**
- [ ] Spike test: always-on playable-start holds **or** shed/circuit-breaker behaves as designed and the miss is classified (ceiling too low vs bug).
- [ ] Deferred preemption does not 404 always-on playback.
- [ ] Overflow of deferred onto cheap consumers is **off** and tested (attempting it pages).
- [ ] Kill criterion: if the only way to meet 120s is a floor sized to **peak full-ladder** tokens, **stop** — that is the old idle bill. Reduce always-on rungs or renegotiate SLO.

Do not point production's headline ingest at this plant until the spike test is green on a **representative mix slice**. Pouring 100% into an unbounded ASG is the current incident.

## Phase 4 — Promotion Policy, CDN Automation, Representative-Scale SLO

**Objective**: Production-shaped completeness: popularity/editorial promotion of deferred rungs, CDN pull + targeted prefetch for `breaking`, then raise ingest toward the real rate without converting every asset into 12 rungs.

**Deliverables:**
- Promotion service v1 (editorial flag + creator tier + a **measured** watch-start rule). Threshold in config, not code folklore.
- Deferred freshness metric; spend cap actually stops pulls.
- CDN: short playlist TTL, long segment TTL, cache-bust on playable flip; prefetch **only** breaking/hot. Origin toaster optional.
- End-to-end SLO on a **representative** ingest slice (Phase 0 mix), including in-region CDN GETs, not origin-only.
- Takedown runbook: playlists first, then segments.
- Encoder-generation path: new keys, not in-place segment mutation; rollback = old playlist generation.

**Exit Gate:**
- [ ] Canary 15s and long fixture meet playable-start SLO **through CDN** in the signed regions.
- [ ] A promoted asset gains a deferred variant without restarting always-on.
- [ ] Spend cap drill: deferred stops; always-on p99 unchanged.
- [ ] Prefetch is not firing on 100% of assets (metric).
- [ ] Coverage: fraction of hours on always-on ladder vs deferred is reported daily; "we encoded everything" is not a success metric.
- [ ] Headline rate is either matched **or** a labeled partial ingest (rate-limited) is an accepted product state. Silent 5-hour backlog to "absorb" the rest is a failed gate.

## Phase 5 — Production Operations (ongoing)

**Objective**: Make "the pipeline got slow" and "the bill exploded" detectable without a quarterly postmortem. Entry requires Phase 2 tracing and Phase 4 CDN canaries; this phase is the rest of the observer.

**Entry Gate:** Real creators, even if ingest is still rate-limited below 1,200 h/min. Monitoring is not delayed until "full scale."

**Deliverables:**
- Dashboards + pages: playable-start p99 by class and duration bucket, cheap vs deferred age, `assets_no_overlap`, shed flags, DLQ, origin 4xx on segment GET, $/source-hour vs budget.
- Canaries on a clock **through production** publish path (not a sidecar encoder).
- Game day: deferred flood, spot storm, playlist TTL misconfig, GOP poison file.
- Quarterly mix re-sample (phones change GOP behavior). Floor tokens retuned.
- Ladder-policy review: promotion threshold vs CDN $ saved vs encode $ spent.

**Exit Gate** (re-checked continuously; never "done"):
- [ ] A staged regression (merged FIFO, 1080p always-on forced, playlist TTL=1 day, upscale enabled) is **detected by the intended signal** in a game day.
- [ ] Full-ladder-for-everything cannot ship without a cost sign-off checkpoint (policy).
- [ ] Mix sample is not older than 90 days.
- [ ] Idle floor $ is still explained as SLO insurance, not as waste to harvest blindly.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop and escalate — do not "keep the queues draining" — if any of the following hold:

1. **Mix miss**: sampled tokens make a 2-minute always-on tail or a fundable floor impossible, and SLO/rung/rate changes are refused. Honest output: "this requirement is not feasible as stated." Adding workers until the idle bill equals the old system is not a workaround. See [Trade-offs §4](./05_tradeoffs_and_honest_assessment.md#4-why-just-add-more-workers-is-not-a-full-answer).
2. **EOF-batch long-form** still the default upload while the SLO assumes overlap. Fix ingest or narrow the SLO. Do not scale-encode as compensation.
3. **Launch without split observability**: no playable-start, no cheap-vs-deferred age, no listed-segment 404 alert. Block production ingest. This is not a P3.
4. **Cheap and deferred consumers merged** to "help with the spike." Immediate rollback. Treat as a SEV even if average encode FPS looks great.
5. **Full 12-rung default** reintroduced without a written NTM/$ model and finance signature. Kill the deploy.
6. **Upscale** jobs observed in origin. Kill; it is a cost and quality defect.
7. **Manifest 404** reproduced (playlist lists missing object) and not fixed before more ingest. Stop promotions; this is player-breakage, not eventual consistency.
8. **Managed transcode overflow** exceeding a small prototype cap after Phase 3. Prototype debt becoming the plant is a kill criterion.
9. **Pressure to promise global worst-POP 2-minute full ladder** to hit a PR date. Degraded/regional/cheap-ladder is the contract; expanding it is a new design.

Rollback is always to the last phase whose exit gate was honestly green (including the previous encoder generation / playlist generation). After a kill, stakeholders still get the measured mix, the tail ledger, the $/source-hour of whatever ladder was real, and a recommendation: reduce rungs, change SLO, fund silicon, change ingest protocol, or throttle ingest. They do not get a confident 1,200 hours/minute × 12 codecs × 2 minutes we never had.
