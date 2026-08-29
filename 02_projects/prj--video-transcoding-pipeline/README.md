# prj--video-transcoding-pipeline

Architecture and system design documentation for a video-sharing ingest pipeline that must turn **1,200 hours of user-generated video per minute** into adaptive-bitrate HLS/DASH at the edge, **within 2 minutes of upload completion** — without a fixed EC2 pool that idles all week and then backlogs 5 hours on a viral news day.

Documentation-only project: no FFmpeg command, no MediaConvert job template, no autoscaling group, no Terraform lives here. This is the design specification a build phase would implement against.

The defining fact is arithmetic, not a preference for Kubernetes. 1,200 hours/minute is **2.4× YouTube's long-cited public upload rate**. Encoding every asset into the naive 12-rendition ladder (4K / 1080p / 720p / 360p × H.264 / HEVC / AV1) on a managed transcoding service lands on the order of **~$30 per hour of source**, which at this volume is **~$50 million per day** before storage and CDN. The 2-minute SLA, taken literally for a 3-hour 4K 120fps file after the last byte lands, is a fleet-sizing lie. The design is therefore not "elastic EC2 plus a smarter queue." It is **pipeline overlap with the upload**, a **progressive rendition ladder** that does not encode 4K AV1 for every 15-second clip, **chunk-level jobs** so a failed GOP does not restart a 3-hour file, and **compute tiering** that treats ASICs and spot burst as the steady-state bill, not as an optimization ticket.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the scale math that makes "transcode everything into every codec" a finance incident, and the SLA reinterpretation that makes "2 minutes after upload" survivable.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built and why the system is three planes plus a ladder policy, not a bigger EC2 ASG.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": GOP-aligned chunks, progressive manifests, priority draining, the 2-minute tail budget, and hardware mapping.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for the answers this scenario actually asks for: what to build, what to give up, why "just add more workers" is not a full answer, and how the design changes if the mix is mostly 15-second clips instead of 3-hour 4K.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout that refuses to size silicon off a guessed content-length distribution.
