# Healthcare Patient Record & DICOM Medical Imaging Sync: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

A multinational healthcare system manages Electronic Health Records (EHR) and high-resolution DICOM medical scans — 100 MB to 4 GB per study — across 150 hospitals. Strict legal frameworks (HIPAA in US facilities, GDPR in EU facilities, plus per-country health-data statutes that are often stricter than either) dictate that **raw patient PII must remain inside the physical borders of its originating region**. Anonymized clinical metadata may be aggregated globally for medical research.

The current system uses localized SAN storage and nightly FTP sync scripts over unstable 1 Gbps WAN connections. Syncs fail frequently. Cross-hospital specialist consultations wait on last night's batch, or on a human copying a study onto a disk. A failed hospital link leaves a partial file that looks complete to the next hop. Nobody can prove, to a regulator, where a given instance actually lives.

The design must answer, concretely:

1. What can plausibly fail at each layer of SAN + nightly FTP *for large DICOM studies specifically*, and why "run the script again" is not a reliability strategy.
2. How raw PHI and pixel data stay in the originating region as an *enforced* property of the system, not a policy slide.
3. How a specialist in another region can still see the study without the study becoming a second copy of PHI in their region.
4. How anonymized metadata reaches a global research fabric without leaking identifiers that DICOM is famous for hiding in unexpected tags and pixels.
5. How physician retrieval is made fast *inside* a region, and merely *tolerable and auditable* across a border.
6. How studies move to cheap archival storage without making an emergency re-read a multi-day outage.
7. What all of that costs in complexity.

This is the "replicate everything so consultation is fast" trap. The naive answer — a global object store, cross-region replication, a CDN in front of DICOM — is the failure. It treats a legal residency constraint as a latency problem. Replication is how you get a 4 GB CT into another country in minutes. It is also how you get a GDPR fine, a HIPAA OCR investigation, and a data-protection officer who will not sign the architecture.

The correct shape is: **raw PHI and pixel data never leave the region they were created in; only de-identified metadata and short-lived, audited, ephemeral views of pixel data cross a border.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true under zero-loss ingestion, unstable WAN, automated regional isolation, DLP that cannot actually prove the pixels are clean, and a cache that must not become a replica.

## The Trap, Stated Directly

FTP of multi-gigabyte DICOM studies over an unstable 1 Gbps WAN, once a night, is a known anti-pattern for both reliability *and* compliance. FTP has no first-class resume, no content-addressed completion, and no notion of a DICOM study as a set of SOP Instances that must all arrive. A 4 GB study on a link that drops every few hours is a lottery. A SAN that "has the file" because the FTP client exited 0 after writing 3.1 GB is a clinical incident waiting on a radiologist who opens a truncated series.

Raising WAN capacity, adding `rsync --partial`, or running the job every six hours instead of nightly does not remove the hop; it just moves the next failure. It also does nothing about residency. The current scripts already copy raw studies between hospitals. If two of those hospitals are in different legal regions, the current system is *already* a compliance finding, not merely a slow one. "It only copies at night" is not a lawful basis.

The expected redesign, and the one people will propose in the first meeting, is **global object storage with cross-region replication**. Those six words are how you make consultation fast. They are also how you put a German patient's CT in `us-east-1`. The architecture that satisfies the legal sentence is slower at the border, more moving parts in every region, and refuses to let "the specialist is waiting" quietly turn into "we replicated PHI." Speed-of-light and sovereignty are not both available. This project picks sovereignty and then spends the rest of the pages making consultation *possible*, not instantaneous.

A second, quieter trap: **de-identification is not a checkbox.** DICOM private tags, burned-in annotations on pixel data, free-text fields, and secondary captures will leak names after a tag-strip that looked complete on a sample. Promoting "anonymized" metadata globally on the strength of a vendor's "HIPAA de-id profile" without a seeded-PII test suite is how research becomes a second copy of the EHR. The global fabric is allowed to hold clinical facts. It is not allowed to hold a patient.

## Current State (Assumed Starting Point)

A typical first version of this path looks like:

1. Modalities (CT, MR, US, XA) write DICOM to a hospital PACS, which stores instances on a local SAN.
2. A cron job, often a vendor "auto-forward" or a homegrown script, lists studies produced that day and FTP-pushes them to a regional hub or to peer hospitals that have a sharing agreement on paper.
3. The WAN is 1 Gbps on a good day, shared with EHR, VoIP, and everyone else's backups. It is not dedicated imaging bandwidth. It is unstable: packet loss, overnight maintenance windows, rural last-mile to smaller hospitals.
4. There is no durable buffer distinct from the SAN. If FTP fails, the script retries from byte 0 or from a temp file that may already be partial. There is no checksum of the complete study, no SOP Instance UID inventory, no "this study is closed and verified."
5. Cross-hospital consultation means: wait for tonight's job, or call the sending hospital's IT to "push it again," or walk a USB drive. A specialist in another country waits a day or does not see the study.
6. Research aggregation, if it exists, is a quarterly extract: someone dumps a spreadsheet of accession numbers and a handful of tags. Nobody can swear the dump is de-identified. Nobody can swear it isn't.
7. Archival is "the SAN is full, buy more trays" or a vendor archive that is another SAN in the same room. There is no lifecycle policy that a finance team could audit.

That version will appear to work in a single-country pilot with a 120 MB ultrasound on a quiet night. It will fail the first time a 3.8 GB CT angiography shares a link with a backup window, the first time a hospital in Ireland sends identifiable studies to a US reading group because "that's where the night radiologists are," and the first time a DPO asks for a data map and is handed a shared drive path.

This project documents the replacement, not a patch of those cron jobs.

## Layer-by-Layer Fault Tree (Large DICOM Studies Specifically)

Walk the path. At each layer, name only what fails *because the study is large*, *because the WAN is unstable*, or *because residency was never a property of the system*. Generic "the SAN is down" is out of scope.

### Modality / hospital PACS / SAN

- **Study not closed.** A CT still acquiring is FTP'd as a partial series. The receiving end stores it as complete. The radiologist reads an incomplete study. Size makes this worse because the transfer window is long enough that "still acquiring" and "script started" overlap.
- **SAN as both clinical store and staging disk.** The FTP job reads from the same arrays the PACS is writing to. A large outbound transfer contends with inbound modality traffic. "Some hospitals" fail first: the ones whose SAN was already at 90%.
- **No content hash, no instance manifest.** "File exists" is not "all SOP Instances of this Study Instance UID are present and bit-identical." FTP success is a process exit code.

What this layer does *not* explain by itself: a study that arrived whole in hospital A and is missing in hospital B. That is the WAN or the script. Do not start here if the sending PACS still has a complete study.

### Nightly FTP script

- **No resume that the operator trusts.** Classic FTP restart is optional, often disabled, often wrong across NAT. A 4 GB transfer that dies at 90% restarts at byte 0. Probability of hitting a blip scales with duration, hence with size.
- **Silent truncation.** The client writes a file, the control connection drops, the script logs success because it does not compare size or hash. The next night's incremental job skips the study because a file with that name exists.
- **One failed hospital stalls the batch, or is skipped with a log line nobody pages on.** 150 hospitals, serial or poorly parallelized. A rural site with a bad night never catches up. The catch-up then saturates the WAN for everyone else.
- **Credentials in the script.** FTP (often still unencrypted, or "FTPS if the vendor supports it") with a shared account. This is a security finding independent of size; size just means the window of exposure is a multi-gigabyte identifiable imaging study, not a config file.
- **No DICOM awareness.** The unit of transfer is a zip or a folder of `.dcm` files. The unit of clinical truth is Study / Series / SOP Instance. A missing instance is a wrong diagnosis, not a missing file in a backup report.

### WAN (1 Gbps, unstable, shared)

- **Shared capacity.** 1 Gbps is the *link*, not the imaging budget. EHR replication, Windows updates, and a second hospital's FTP job are on the same path. A 4 GB study at a lucky 200 Mbps still takes ~3 minutes; at 20 Mbps with loss it takes most of an hour and will not finish before the next drop.
- **Head-of-line with a nightly window.** Everything queues for 02:00. One bad night is a multi-hospital backlog. "Nightly" is a schedule, not a backlog algorithm.
- **Cross-border links are the same scripts.** The WAN does not know about GDPR. If the script's destination is another region, PHI left. The failure mode here is not loss; it is **successful unlawful transfer**. The logs will show success. That is the incident.

### Receiving SAN / "sync complete"

- **Partial object treated as complete.** No `HeadObject`-equivalent, no instance count vs. sending manifest.
- **No regional fence.** The receiving hospital stores whatever arrived. There is no control plane that would refuse to persist a study whose origin region is not this region.
- **Overwrite / name collision.** Accession numbers are not globally unique. Two hospitals' "study-20260301-001" collide. One study vanishes into the other. This is not theoretical in a 150-site namespace that was never designed as a namespace.

### Cross-hospital consultation (human path)

- **Latency is one night plus retry.** A stroke or trauma consult cannot wait for FTP. People use workarounds (email, consumer cloud, VPN desktop share of a diagnostic workstation). Those workarounds are unlogged PHI disclosure.
- **"Push it again" as architecture.** Reliability is a phone call. The specialist's time is the SLA, and it is not met.

### Research extract

- **Spreadsheet de-identification.** Tags that look empty. Private tags that are not. Pixel data with burned-in name and date of birth. A quarterly dump is a quarterly leak.
- **No promotion gate.** Whatever can be queried locally can be copied to the research share. There is no DLP step because there is no pipeline; there is a person.

### Archival (or the lack of it)

- **Capacity crisis, not a lifecycle.** Hot SAN fills. Someone deletes "old" studies or buys disk. Retrieval of a 7-year-old study is a tape legend or a "we think it's on the old EMC."
- **No rehydration SLA** because there is no tier. Everything is hot until it is gone.

## What to Check First, and Why That One First

**Check first: a data map — which hospitals send identifiable DICOM to which destinations, including destinations that are "just another hospital in the group" in another country — and whether those transfers have a written lawful basis.**

This is a read-only, no-repro-needed check. It partitions the entire problem into "we are already breaking the law on a schedule" versus "we are only unreliable inside a region." The architecture changes if the current FTP jobs already cross a border.

| What you see | What it isolates | Why it is cheap |
| --- | --- | --- |
| FTP destination IPs/hostnames in another legal region | Unlawful or at-best-unreviewed PHI export, happening nightly | Script configs and firewall logs; no imaging expertise required |
| Transfer logs with exit 0 and receiving size << sending size | Silent truncation; "success" is a lie | Compare bytes in / bytes out for a sample of studies |
| Failures clustered on a few sites, all night | WAN or SAN contention at those sites, not a DICOM format problem | Overlay site, duration, byte count |
| Duration clustered near a round window (e.g. job killed at 06:00) | The batch window is the architecture; large studies lose | Cron and job-scheduler config |
| Studies "present" on receiver missing SOP Instance UIDs vs sender | Folder-level FTP without a manifest | One study dumped through `dcmdump` / a PACS query on both sides |
| Research share contains PatientName, PatientID, or burned-in pixels | De-id does not exist; global aggregation is currently a copy of the EHR | Open ten random files; do not wait for a vendor report |
| No inventory of KMS keys, bucket regions, or even a region list | Residency cannot be enforced because "region" is not a system concept yet | Ask for the region list; if it does not exist, that is the finding |

**Why not buy object storage first.** Object storage without a region model, a de-id gate, and a consultation path that does not copy is a faster way to put PHI in the wrong country. The first check is *where data already goes*, not *how to store it better*.

**Why not "just enable TLS on FTP."** Encrypted unlawful transfer is still unlawful, and truncated encrypted files are still truncated.

**Second check, only after the data map:** WAN failure rates and byte-level success for a sample of large studies (p50/p95 size, time-to-complete, retry count). Third: SAN free space and whether the FTP staging area is the clinical array. Fourth: what tags and pixel overlays actually contain PII in *this* installed base — not in a DICOM standard annex. Fifth: legal, in writing, per jurisdiction pair, whether ephemeral cross-border viewing is even allowed, under what basis (adequacy, SCCs, consent, public-interest healthcare provision, break-glass statute).

**Phase 0 exists because several of those answers can kill parts of this design.** A jurisdiction that forbids even ephemeral viewing is not a broker configuration; it is a pair that stays on a manual, legally reviewed export. Building the broker first is how you ship a product legal cannot turn on.

## Target Users

- **Hospital PACS / imaging IT**: needs a buffer that does not eat the clinical SAN, a transfer that resumes, and a definition of "the study has left the building" that is a checksummed manifest, not an FTP log line.
- **Treating physician and remote specialist**: needs to open a study. Inside the origin region, that should feel like today's PACS. Across a border, that should be possible, audited, and honest about wait time for a cold or uncached 4 GB study.
- **Compliance / legal / DPO**: needs a system that can answer "show me that this instance never persisted outside region R" and "show me every cross-border view, who, when, under what basis." They need this to be evidence, not a slide.
- **Research data consumer**: needs de-identified metadata and, where approved, de-identified pixel access *inside a research environment*, not a second EHR.
- **Platform SRE**: needs per-region blast radius, a WAN backlog they can see, and a cache purge they can prove.
- **Owning engineer**: needs a diagnosis order and a design they can defend when someone asks why the specialist cannot have a replica "just for this week."

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which viewer, which hanging protocol, which EHR vendor) are out of scope.

1. **Zero-loss ingestion of studies in the 100 MB–4 GB range over unstable WAN.** A dropped link must resume. Completion is verified (checksum + SOP Instance inventory), not assumed from a process exit code. The clinical SAN must not be the only buffer.
2. **Raw patient PII and identifiable pixel data must remain inside the originating legal region.** This is enforced by placement, IAM, KMS locality, and the absence of a replication rule for raw objects — not by a policy document that the object store does not read.
3. **Anonymized clinical metadata may be aggregated globally for research.** Promotion to that fabric is gated on automated de-identification and DLP. Fail closed: a record that does not pass stays region-local.
4. **A specialist in another region must be able to view a study without the study becoming a durable copy in their region.** Viewing is an ephemeral, legal-basis-gated, fully audited session. "View" is not "sync."
5. **Physician retrieval inside the origin region must be fast**, using regional edge cache / hot storage as a normal read-through. Cross-region retrieval may use a short-TTL cache that is explicitly not a replica and is purgeable to empty.
6. **Automated lifecycle migration to lower-cost archival storage**, per region, with a stated rehydration SLA. "Always hot" is not a cost model at this volume. "Archive and hope" is not a clinical model.
7. **Every cross-border pixel view is attributable**: who, from where, which study, which legal basis (including break-glass), when the session started and ended. Audit logs that contain patient identifiers stay in-region; a de-identified audit summary may leave.
8. **The application must not need a single global namespace of raw objects.** Global identity exists for de-identified study keys and for session IDs. Raw object keys are region-scoped.

## Success Criteria for the Design (Not Implementation Metrics)

1. A simulated WAN drop during transfer of a 4 GB study resumes and completes with a bit-identical object and a matching SOP Instance manifest; the receiving regional store never marks the study complete without that match.
2. No raw PHI object (identifiable DICOM instance) is ever created in object storage, disk, or cache **outside its origin region**, including as a "temporary" file on a consultation broker host in another region that survives the session. The broker may transit bytes; it may not persist them. Phase 4's cache is the only allowed cross-region byte landing, and it is TTL-bound and encrypted; see [ADR-006](./04_architecture_decision_records.md#adr-006).
3. A seeded PII string (known PatientName / PatientID / date of birth, plus a burned-in overlay on a test series) **never appears** in the global metadata fabric after promotion. If DLP cannot detect the overlay, that class of object is not promoted; it is not "promoted with a warning."
4. A specialist in an approved jurisdiction pair can open an origin-region study through the consultation broker; the session expires; a subsequent disk/cache audit in the requesting region finds no recoverable copy after TTL (or finds only the designed short-TTL cache entries, which then purge).
5. A jurisdiction pair **without** written legal approval cannot start a streaming session. The API fails closed. The fallback is a human legal/export process, not a flag flip by a helpful engineer.
6. An archived study is retrievable into hot/warm within a documented rehydration SLA (working assumption: hours, not seconds, not days — the number is a Phase 0 product/legal input). Emergency access to a cold study is a runbook, not a hidden second hot copy in another region.
7. Nightly FTP for a pilot region is gone only after (1)–(3) are evidenced for that region. Removing FTP before zero-loss ingest is a kill criterion, not a milestone.

## Business Rules (Residency- and Imaging-Scoped)

1. Origin region is assigned by **hospital site → legal jurisdiction → region**, not by where the patient later travels and not by where the specialist sits.
2. Raw instances are written only to the origin region's store, under a CMK that does not leave that region.
3. De-identification runs **in the origin region**. Re-identification material (salt, mapping tables, keyed hashes) never leaves that region.
4. Global metadata contains no direct identifiers and no reversible pseudonyms that this system can invert without the region-local key. If a research use case needs linkage back to the patient, that linkage is a region-local break-glass, not a global join key.
5. Cross-region view requires a recorded legal basis for that **pair** of jurisdictions, a named requester, and a session TTL measured in minutes to a small number of hours — not days.
6. Break-glass (emergency access without the usual clinical relationship) is a distinct basis, with a distinct audit trail and a post-hoc review queue. It is not "the same API with a comment."
7. Edge cache in a non-origin region is a performance optimization of a view, not a store. TTL is short. Encryption at rest. Purge must be demonstrable. A cache hit does not relax audit (the view is still logged).
8. Lifecycle policies apply per region to origin objects. A view cache is not a lifecycle tier; it does not get "promoted" to archive in the wrong country.

## Non-Goals

- **Not a PACS replacement.** Acquisition, worklist, hanging protocols, reporting, and the diagnostic viewer UX remain the incumbent PACS/VNA problem. This system ingests, places, gates, streams, caches, and archives. It does not become the radiologist's workstation.
- **Not an AI diagnostic product.** No inference in the hot path. A later research environment may consume de-identified data; that is a different project.
- **Not real-time collaborative viewing** (two physicians annotating the same series with sub-second sync). That is a product. This design gives one physician a view. Collaboration can sit on top; it is not a reason to replicate the volume.
- **Not a promise that a first cross-border open of a 4 GB uncached study is "instant."** Physics and the legal refusal to pre-position replicas forbid it. The honest UX is progress, a wait, and a cache for the next open *inside the TTL*.
- **Not a single global database of raw imaging.** That is the trap.
- **Not a multi-cloud storage abstraction.** One object-store API (S3-compatible is the working assumption) **per region**. A second vendor is a new cell implementation, not a plugin framework.
- **Not a claim that automated de-identification is complete.** Residual risk of burned-in PII and private tags is accepted and mitigated by fail-closed promotion and sampling — not by a vendor checkbox. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- **Not an implementation.** No DICOM toolkits, no Terraform, no viewer. Numbered steps and diagrams only.
- **Not a claim that this is cheap.** Per-region cells, a de-id pipeline, a broker, and a legal program are a multi-year, multi-team system. A 3-hospital single-country network should not build this. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
