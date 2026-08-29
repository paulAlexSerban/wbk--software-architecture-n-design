# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone buys a global imaging mesh or promises "a specialist in another country opens a 4 GB CT like it is on the SAN."

The expected answer is a sentence about **object storage, de-identification, and a CDN**. Object storage is part of a cell. De-identification is a gate, not a checkbox. A CDN is a replica. Passing 4 GB DICOM studies through nightly FTP is the anti-pattern; listing `rsync --partial` is diagnosis, not design. This page is the cost of a design that can survive a DPO and a dropped WAN in the same week.

The hard part is not moving 4 GB files. The hard part is **proving, to a regulator, that a raw file never became a store outside its border, while still letting a physician in another country see it in an emergency.** The architecture buys auditable compliance and reliable ingest. It does not buy speed-of-light global access. Anyone who needs both should stop reading and hire a lawyer who can change the facts; an architect cannot.

## 1. What I would build

A **regional residency cell** per legal jurisdiction, a **global metadata fabric** that only accepts what passed a fail-closed gate, and a **consultation broker** that streams.

- **Site edge buffer + resumable checksummed ingest** into the origin cell only. Manifest of SOP Instances. Verify before `stored_verified`. [ADR-004](./04_architecture_decision_records.md#adr-004).
- **Raw prefix with CMK and an org deny on CRR.** In-region DR later; not this project's excuse to replicate. [ADR-001](./04_architecture_decision_records.md#adr-001).
- **De-id + DLP in origin**, versioned profile, quarantine, **metadata-only** promotion. Seeded-PII suite. [ADR-003](./04_architecture_decision_records.md#adr-003).
- **Broker**: pair matrix, session TTL, origin audit, no foreign `PutObject`. [ADR-002](./04_architecture_decision_records.md#adr-002).
- **Origin cache on; foreign cache off unless legal wrote yes**, then short TTL, purge drills. [ADR-006](./04_architecture_decision_records.md#adr-006).
- **Lifecycle in origin** with a number for rehydrate, holds for active care, no foreign archive. [ADR-005](./04_architecture_decision_records.md#adr-005).

I would not "fix FTP." I would read the data map in Phase 0 so I know whether we are already exporting PHI, then replace the path. I would not enable a specialist viewer for a jurisdiction pair that legal has not signed. I would not promote pixels globally in v1 to make the research demo prettier.

If Phase 0 shows three hospitals in one country, no cross-border reading, and a research extract that can stay a batch job in that country, this whole multi-cell system is overkill. Build one cell, one buffer pattern, a local archive class, and a de-id export. The 150-hospital multinational sentence is what justifies N cells and a broker.

## 2. What I would give up

Be explicit. These are not "later." They are not in v1, and some of them are never in this design.

**True low-latency global access to raw imaging.** Physics (4 GB over a real WAN) and law (no replica) both say no. A first cross-border open of an uncached study takes **real minutes**. The fix is reliability, audit, and maybe a short-TTL cache *inside a session*. It is not teleportation. If clinical leadership will not sign that sentence, they are asking for ADR-001 to be violated. Do not "compromise" by turning on CRR for "just the last 48 hours of trauma CTs." That is a replica of the most sensitive studies.

**A fully automated PII-leak guarantee.** DICOM burned-in annotations, private tags, and free text mean DLP is defense-in-depth, not a proof. v1 contains the blast radius (metadata only, fail closed). It does not let you swear in court that no name ever entered the global fabric. Sampling and seeded tests are how you *reduce* the chance. The residual remains. Anyone selling "we anonymize DICOM" as a solved problem is selling a profile PDF.

**Instant access to archived studies.** Rehydrate is hours-class unless you pay always-hot. Stroke on a 7-year-old study is a runbook and a hold policy, not a hidden foreign SSD.

**A single global database of imaging.** Discovery can be global (de-identified keys). Pixels cannot.

**Zero operational multiplier per new region.** 150 hospitals are not 150 clouds. They are also not one. Each legal region is a cell: keys, IAM, workers, audit sink, on-call. Each hospital is a buffer, a firewall change, and a capacity number.

**The FTP-era specialist workflow of "it's on my PACS."** After cutover, a foreign specialist has a session in a viewer, not a local study they can reopen in six months without a new basis. That is the point. It will feel like a demotion. It is compliance.

**Unmanaged workarounds as architecture.** Email, consumer cloud, unlogged VPN desktop share. If we cannot replace them with a broker that is usable, they will continue and the new system will be theater. Usable includes: login they already have, a wait UX that tells the truth, break-glass that is not twelve clicks. It does not include a replica.

**Perfect viewer lockdown.** Screenshots exist. Watermarks and no-download are what you get. Do not delay the program for a DRM fantasy.

**GDPR erasure as a single `DeleteObject`.** Retention law fights erasure. That fight is legal's, per record class. Engineering provides holds and a request type, not a clever sweep.

**Cheapness.** Per-region cells, 150 site rollouts, a de-id program, a legal matrix, cache drills, and a broker are a **multi-year** program with a privacy office attached. A global bucket is cheaper and illegal. FTP is cheaper still and both unreliable and possibly illegal. Pay this when you are actually multinational with identifiable imaging. Do not pay it as a résumé.

**Cross-region DR of raw PHI.** If the only cloud region in a country dies, those studies are not in `us-east-1` waiting to save you. In-jurisdiction DR is a different design. Accept the residual or fund a second site *in the same legal country*.

## 3. What I would ask for, even though I expect friction

Ask **once, in writing, in Phase 0**, in parallel with the data map and the WAN numbers. Silence must not block the map. Silence **must** block turning on a broker pair.

Ask legal / DPO / privacy:

1. **For each origin jurisdiction × viewer jurisdiction, is ephemeral streaming a lawful transfer, under what basis, until when?** Expected: months of opinions, some pairs "no," some "yes with SCCs and a BAA," some "only break-glass." Record the nos. They are not backlog; they are 403s.
2. **Are short-TTL foreign cache copies allowed, or is even cache a store?** Expected: split by country. Default off.
3. **Break-glass: is it legally available, who may invoke, what review?** Expected: "yes for life-threatening, audit the hell out of it." If no, the emergency path is locum-in-region or patient transfer, not a flag.
4. **GDPR erasure vs imaging retention: who wins, per class?** Expected: a workflow, not an answer that fits in Slack.

Ask clinical / product:

5. **Will you accept minutes for a first cross-border 4 GB open?** If no, they want replicas. Stop or escalate to the board with the legal memo. Do not "see what we can do" in cache TTL.
6. **Rehydration SLA: hours? Which modalities stay hot for D days?** Need a number. "As fast as possible" is always-hot spend.
7. **Is "uploaded/stored but research metadata not promoted" acceptable while quarantine is reviewed?** If research thought they had a live global registry on day one, tell them they do not.

Ask imaging IT / network:

8. **Bytes/day per site, WAN contention, whether a buffer disk distinct from PACS SAN exists.** Expected: many sites have no spare array. Plan contention.
9. **How studies are marked closed today.** If they cannot, quiet-period heuristics and more partial-study incidents.
10. **An honest DICOM tag and pixel audit of this installed base** — ten random studies per major modality, private tags, overlays — before promising DLP coverage. Expected: uglier than the vendor brochure.

Ask security / platform:

11. **Org SCP to deny CRR on raw prefixes, and who can override.** If "cloud center of excellence" can enable CRR from a landing-zone pipeline, the ADR is a wish.
12. **Central logging: will identifiable audit leave the region if we use the global SIEM as-is?** Expected: yes, unless you stop it. Regional sinks are a project.

What I would **not** ask for: a multi-cloud DICOM abstraction, an AI inference platform, a real-time collaborative whiteboard, Kubernetes for its own sake, a new PACS. Those asks spend calendar time that belongs to legal pairs, site buffers, and the seeded-PII suite.

## 4. Complexity inventory (what that one sentence costs)

| You take on | You shed |
| --- | --- |
| N regional cells, N CMKs, N audit sinks | One global bucket that was unlawful |
| 150 edge buffers, occupancy paging, site WAN math | Nightly FTP lottery and silent truncation |
| Manifest + checksum verify | Exit code as integrity |
| Versioned de-id profile, DLP, quarantine staffing | Spreadsheet "anonymization" |
| Legal-basis matrix as a hard API | "The other hospital is in the group" as a basis |
| Consultation broker, session TTL, disk-wipe drills | Durable foreign PACS copies (and the fine) |
| Two cache classes, purge proof, TTL cap as policy | CDN-shaped replica |
| Lifecycle + rehydrate SLA + holds | SAN-full-buy-trays |
| Honest wait UX and glass-rate metrics | The fantasy that consultation is a local open |
| Residual PII and screenshot risk, named | A vendor checkbox that said residual was zero |

Net: **more parts, in the right jurisdictions.** The old design was simple *and* losing files *and* unable to answer where a patient lived. The new design is the standard shape of a lawful imaging fabric, and the standard shape is still years of site work plus a privacy program, not a quarter of S3.

### What is not worth building

- Global pixel lake "only for research" without a clean-room ADR and a legal basis.
- Cross-region CRR "for DR."
- A custom DICOM-aware WAN codec in v1. Multipart plus a manifest is enough.
- Foreign cache warming, "predictive specialist prefetch," 30-day TTL.
- Perfect pixel OCR as a blocker for metadata promotion.
- A new PACS, a new viewer from scratch if an existing one can take a session URL, a multi-cloud storage SDK.
- Parallel-running FTP "until we are sure" with no drain date — that is two systems, one of them still unlawful.

## 5. When I would not do this

- **One country, handful of hospitals, no foreign reading group.** One cell, buffers if the WAN is bad, archive class, de-id batch for research. No broker, no pair matrix. This document would be satire.
- **No identifiable imaging leaves the hospital at all** (purely local PACS, research on-site). Then you need a PACS vendor and an archive, not a multinational fabric.
- **Legal will not approve any streaming and will not staff quarantine.** You can still do in-region ingest+archive. You cannot honestly sell global research or cross-border consult. Building the broker anyway is how it gets turned on in a hurry during a crisis.
- **Nobody will fund 150 site rollouts.** A pilot cell without a rollout program is a demo. Demos do not decommission FTP.

When I **would** do this: you actually operate hospitals in multiple legal regions, specialists actually read across borders (or unlawfully already do), studies are large, WAN is lossy, and a DPO has asked for a data map you cannot produce. Then the one sentence is the design, and this document is the bill.

## 6. Brutal summary

The clever design is not a faster FTP job or a global imaging CDN. The clever design is **refusing to let raw PHI become a store in a second country**, checking the data map first so you know whether you are already breaking the law on a schedule, and paying for cells, buffers, a fail-closed de-id gate, a legal matrix, a stream that does not spool, and a cache that can be proven empty.

"Object storage plus de-id plus CDN" is the wrong three phrases. The right ones are **placement, promotion, session.** The fourth through four-hundredth words are SOP manifests, CMK locality, seeded PII, pair expiry, broker `/tmp`, TTL caps, rehydrate hours, and 150 hospital buffers.

If you are one country, do not build this. If you are many countries, do not pretend replication is architecture. Either way, Phase 0 is the data map and the legal matrix — before anyone opens a cloud console to create a bucket that can replicate.
