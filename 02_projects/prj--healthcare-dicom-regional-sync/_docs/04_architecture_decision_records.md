# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Regional Data-Residency Cells for Raw PHI and Pixel Data (No Bulk Cross-Region Replication)

**Status**: Accepted

**Context**: 150 hospitals across multiple legal regimes. HIPAA, GDPR, and stricter national health-data laws require that raw patient PII remain in the originating region. The current FTP mesh already copies identifiable DICOM between sites, including, in all likelihood, across borders — a legal problem disguised as an integration pattern. The commercially obvious target architecture is a global object store with cross-region replication (CRR) so a specialist in another country has the study locally. That is also the shortest path to a durable second copy of a German CT in a US bucket, and to a DPO who will not sign.

In-region durability (multi-AZ, perhaps a second site in the same jurisdiction) is a real hospital requirement. It is not the same as CRR. Cloud vendors will offer CRR as "DR." Imaging leads will ask for it as "speed." Both asks must be refused for the `raw/` prefix.

**Decision**: Identifiable DICOM instances and re-identification material live only in a **regional cell** bound to the origin jurisdiction. There is no replication rule, no global bucket, and no "temporary" foreign prefix for raw objects. Org-level policy denies CRR on `raw/`. Disaster recovery of raw imaging is an **in-jurisdiction** cell concern, designed separately, not by turning on CRR. The global system of record for *discovery* is de-identified metadata ([ADR-003](#adr-003)), not pixels.

**Consequences**:
- (+) A regulator can be shown placement: objects, keys, and IAM exist in this region and not in that one. That evidence is the product.
- (+) Blast radius of a regional compromise is that region's patients, not the fleet.
- (+) Cost tracks "bytes stored where they must be stored," not "bytes × regions."
- (–) A specialist in another region does not have a local replica. First-open latency is origin egress + WAN. [ADR-002](#adr-002) is the mitigation, not a copy.
- (–) N cells to operate, not one lake. N is legal regions, still more than a single platform team is used to.
- (–) In-region DR still has to be designed (second AZ / second building). This ADR explicitly does not provide cross-border DR of PHI. If a jurisdiction has one cloud region and it burns down, that is a **business continuity and legal** problem (paper, courier, declared emergency), not an excuse to have been replicating all along.
- **Alternative rejected:** Global bucket + CRR + "bucket policy that says EU objects stay in EU." CRR exists to copy. Relying on a prefix convention and hope is how one Terraform apply becomes a reportable breach.
- **Alternative rejected:** Replicate everywhere but encrypt with a key that "never leaves" the origin. If the ciphertext is in another country, many regulators still treat it as a transfer; if the foreign region can ever decrypt (because the app role is global), it is definitely a transfer. Split-key theater is not this project.
- **Revisit trigger:** A jurisdiction *requires* identifiable imaging to be readable in a specific foreign country as a durable store (not a view). That is a new cell or a lawful export program, not CRR for everyone. Or: the organization shrinks to one country — then this ADR is overkill and a single cell is enough ([Trade-offs](./05_tradeoffs_and_honest_assessment.md)).

## ADR-002: Cross-Region Consultation via Ephemeral Audited Streaming under Explicit Legal Basis, not Data Copy

**Status**: Accepted

**Context**: The clinical reason this project exists is that a specialist in another hospital — sometimes another country — must see a study. The FTP answer is a copy. The cloud-naive answer is also a copy. Copies are durable PHI in the destination. They outlive the consult, get backed up, get cached, get found in the next audit.

Streaming (or origin-signed ranged GET) can move pixels through a specialist's workstation without a second system of record. It cannot prevent a screenshot. It can prevent a PACS in country B from holding a million CTs from country A "in case."

Streaming without a **lawful basis** for that pair of jurisdictions is just a faster unlawful transfer. Technology does not create GDPR Article 6/9 bases or HIPAA BAAs. The broker **enforces** a matrix legal fills in. An empty cell in the matrix is a 403, not a TODO.

**Decision**: Cross-border access is a **session**: authenticated specialist, authorized relationship or break-glass, **legal_basis_pair** that is unexpired, short-TTL capability, origin-region bytes, full audit in origin. The broker must not `PutObject` raw instances in the viewer region. Foreign cache, if any, is [ADR-006](#adr-006) and is off unless legal allows ephemeral copies. This ADR is technical enforcement of a legal decision; it is not a substitute for legal sign-off. Phase 3 does not go live for a pair that Phase 0 did not approve.

**Consequences**:
- (+) Consultation is possible without a replica mesh.
- (+) Every view has a who/when/what/basis record in the origin region.
- (+) Pairs can be turned off at expiry without deleting a foreign archive that should never have existed.
- (–) First uncached 4 GB open across an ocean is **minutes**, not a local SAN. Product and clinical leadership must accept this in writing or they will demand replicas after the first angry radiologist.
- (–) Viewer and broker complexity (tokens, no disk spool, CORS or proxy). A "just VPN to the origin PACS" workaround will appear; it must be treated as an unmanaged path and either banned or brought under the same audit.
- (–) Screenshot residual. Watermarks and disabled downloads are mitigations, not proofs.
- (–) Break-glass will be abused if the happy path is too slow. Glass rate is an operational metric, not a shame metric — if it is the real path, the legal matrix or the UX is wrong.
- **Alternative rejected:** Nightly pre-position of "likely" studies into the specialist's region. That is replication with a heuristic. The heuristic will be "all of them."
- **Alternative rejected:** "The broker is in a global region and stores the working set." Then the broker *is* a foreign store. Broker placement for the control plane can be global; **byte persistence** cannot.
- **Alternative rejected:** Trust the existing VPN desktop-share of a workstation. Unauditable, unresumable, and already how PHI leaks. The broker exists to replace that workaround, not to coexist forever.
- **Revisit trigger:** Legal opinion that even ephemeral streaming to jurisdiction B is forbidden. Then this pair stays on a human export (anonymized stills, travel of the patient, in-region locum). Do not "stream anyway with extra logging."

## ADR-003: Automated De-identification plus DLP as a Hard Promotion Barrier to the Global Metadata Fabric (Residual Pixel Risk Contained, not Claimed Solved)

**Status**: Accepted

**Context**: Research is allowed to aggregate **anonymized** clinical metadata globally. DICOM is a hostile format for that sentence: standard tags, private tags, free text, SR documents, secondary captures, burned-in overlays on pixel data. A vendor "HIPAA Safe Harbor profile" applied to a sample of CTs will look clean and will still leak a name from a US private tag or a burned-in PA chest.

If promotion is "best effort, ship with a flag," the global fabric becomes a second EHR with extra steps. If promotion waits for perfect pixel redaction on every slice of every study, research waits forever and someone will open a backdoor share.

v1 needs a door that is **closed by default**, an automated gate that catches the boring leaks, a quarantine for the rest, and an honest statement that burned-in PII detection is not a proof. v1 also needs to **not send pixels globally at all**, so a missed overlay cannot leave the region as an object — only (possibly) as a string in a tag the DLP failed to catch.

**Decision**:
- De-id runs **in the origin cell** against a **versioned** profile.
- DLP on text tags is mandatory for promotion. Pixel burned-in detection is in-scope for a listed set of classes and is still not a guarantee.
- Fail closed: fail or low-confidence-on-required-checks → regional quarantine, **no** global publish.
- Global fabric receives **metadata only** in v1. Re-identification material stays in-region.
- A seeded-PII test suite is a release gate, not a demo.

**Consequences**:
- (+) Research gets a lawful-ish (still not a lawyer's sign-off by itself) aggregated view without a pixel lake.
- (+) Residual risk of a missed tag is limited to metadata fields; residual risk of a missed overlay does not create a global pixel object in v1.
- (+) Profile version on each record makes later science reproducible-enough.
- (–) Quarantine will be large at first. If HIM/privacy staffing cannot review it, promotion volume stays low. That is the correct failure. Hiring is the fix, not auto-promote.
- (–) Researchers will ask for pixels. The answer is a later clean-room ADR inside a lawful region, not a flag on this bus.
- (–) DLP will false-positive (dates, device serials). Tune; do not fail open.
- **Alternative rejected:** "Safe Harbor tag strip, no DLP, promote." The first PatientName in a Comment field is a reportable event.
- **Alternative rejected:** Hold v1 until pixel OCR is perfect. That is using research as hostage; metadata can ship with a tag gate. Pixel export cannot.
- **Alternative rejected:** Reversible global pseudonyms so research can join to the EHR. That is an identifier. Join is a region-local legal process.
- **Revisit trigger:** A regulator or an incident proves metadata still identifies patients at rate X. Halt promotion, retract, tighten profile. Or: a funded pixel-redaction product exists — new ADR for de-identified pixels in a research cell, still not CRR of raw.

## ADR-004: Durable Store-and-Forward Edge Buffer plus Resumable Checksummed Multipart Transfer, Replacing Nightly FTP

**Status**: Accepted

**Context**: Nightly FTP over unstable 1 Gbps shared WAN of 100 MB–4 GB studies fails in the ways [Scenario](./01_scenario_and_requirements.md) lists: no trusted resume, silent truncation, exit-code-as-integrity, batch-window head-of-line, no SOP Instance manifest. Tuning cron and enabling FTPS does not produce zero-loss ingest.

The replacement is the boring reliable-transfer design: persist locally, transfer in parts, resume, verify against a manifest, then and only then mark complete. This is the same honesty as direct-to-storage uploads in other projects in this workbook; the sender is a hospital buffer rather than a browser.

**Decision**: Each site gets an **edge ingestion buffer** that acks the PACS locally and forwards to the **origin cell only** with resumable multipart transfer. Completion is control-plane verification of per-instance size and checksum plus SOP UID inventory. FTP is retired **per site** only after that path is evidenced (Phase 1 gate). The buffer is not allowed to target any non-origin region.

**Consequences**:
- (+) WAN drops become resumes, not clinical missing-slice incidents.
- (+) PACS is decoupled from WAN. Scanners do not wait on Ireland's weather.
- (+) "Complete" has a definition a radiologist's missing-image ticket can be checked against.
- (–) 150 buffers to deploy, monitor, and capacity-plan. This is most of the calendar time in the program. The cell is the interesting architecture; the buffers are the project.
- (–) If the buffer sits on the same SAN as PACS, contention remains. Phase 0 site survey; do not pretend a daemon fixed spindles.
- (–) Local ack means PACS thinks the study is "sent" before origin verify. Operations must watch `closed_but_not_verified` backlog or HIM will believe a lie. This is explicit: **local ack is for modality uptime; clinical 'it is in the region' is `stored_verified`.**
- **Alternative rejected:** rsync/FTP with `--partial` forever. Better than classic FTP; still no DICOM manifest, still easy to point at the wrong country, still a nightly batch culture.
- **Alternative rejected:** Modalities C-STORE directly to a cloud TLS endpoint with no local buffer. Every WAN blip hits the scanner workflow. Rural sites will fail. Buffer exists because the WAN is unstable **by requirement.**
- **Alternative rejected:** A global "ingest bus" that lands bytes wherever capacity is. That is ADR-001's rejected alternative with extra Kafka.
- **Revisit trigger:** A site's measured production bytes/day cannot converge on `stored_verified` even with resume (structural bandwidth deficit). That site needs network investment; do not lower verify standards to "make the dashboard green."

## ADR-005: Tiered Lifecycle Archival with a Stated, Imperfect Rehydration SLA (Not Always-Hot)

**Status**: Accepted

**Context**: Medical imaging retention is years to decades. Keeping everything on hot SAN (or hot object class) at 150 hospitals is how the current SAN panic was born. Always-hot in object storage is cheaper than SAN but still the wrong asymptote. Always-delete is illegal. The adult option is tiering **in the origin region** plus a number for "how long until a cold study is readable again."

That number will be hours-class for deep archive, not seconds. Emergency medicine will hate it. Hiding a hot copy in another region "for stroke" is ADR-001's trap wearing a clinical badge. The mitigations that *are* allowed: do not archive last-N-days; active-care holds from EHR or manual flag; in-region warm class; a runbook.

**Decision**: Origin objects transition hot → warm → cold under policy. Legal hold and active-care hold block descent. Rehydrate returns bytes to origin warm/hot only. SLA is documented (Phase 0 input; working planning assumption **hours**, not seconds, not "next week"). Missed SLA is an incident in origin, not a trigger to copy to the requester's region. Foreign cache is not a lifecycle tier.

**Consequences**:
- (+) Storage bill at year 5 is compatible with keeping the studies at all.
- (+) A finance-auditable policy exists, unlike "buy trays when paging."
- (–) A cold trauma workup from 6 years ago will wait. Clinical ops must know. If they refuse any wait, they are asking for always-hot and must pay for it — still in-region.
- (–) Active-care holds need a feed or a human. v1 may be manual flags plus "do not archive studies newer than D days." Incomplete holds mean the wrong study is cold; that is accepted as v1 if D is conservative (e.g. 90 days hot).
- (–) Retrieval fees and staff time at 3 a.m. are real. The runbook is part of the design.
- **Alternative rejected:** Always hot. Fine for a POC cell; not for 150 hospitals × years of 4 GB CTs.
- **Alternative rejected:** Vendor tape in the basement with no SLA. That is the current state.
- **Alternative rejected:** Archive to a cheaper *region*. Forbidden by ADR-001.
- **Revisit trigger:** Clinical leadership signs that missed-rehydrate risk is unacceptable even with conservative D and holds — then always-hot (or always-warm) for defined modalities, paid for, still in-region. Or object-store archive class in that cloud region cannot meet the signed SLA — pick a different class or vendor **in region**, do not go cross-region.

## ADR-006: Region-Scoped, TTL-Bound Edge Caching; Foreign Cache Must Not Become a Replica

**Status**: Accepted

**Context**: Physicians will not tolerate origin WAN on every scroll of a study they opened ten minutes ago. Origin-region cache is obvious and lawful: the bytes are allowed to live there. Cross-region cache is the foot-gun. A "smart edge cache" with a 30-day TTL and a warmer is a replica network with extra steps. Product will ask to raise TTL the first time a specialist re-opens a study after lunch. Platform will ask to "pre-warm popular studies." Both asks are how this ADR dies in production.

Legal may also forbid even short-TTL foreign copies. Then cache is off for that pair and ADR-002 streaming is the entire path.

**Decision**:
- **Origin cache:** read-through, long-but-bounded TTL, encrypted, access-logged.
- **Foreign cache:** optional, **off by default per pair**, on only with written legal allowance for ephemeral copies; populated **only** from an authorized session; encrypted; TTL short (minutes–hours) with a **platform cap** (working cap 24 h); purge on session end **and** on TTL; no warming job; capacity cap; cache hit still audited as a view.
- A purge drill that proves emptiness is a Phase 4 gate. Finding entries past TTL is a **compliance incident**, not a bug ticket.
- Raising the platform cap or adding a warmer requires revisiting this ADR plus legal. An env var change without that is a policy violation.

**Consequences**:
- (+) Repeat in-region reads are fast. Repeat in-session (or within TTL) foreign reads can be fast where allowed.
- (+) A DPO can be shown a cap, a purge, and a drill, instead of a CDN PO.
- (–) After TTL, the specialist pays origin latency again. Correct.
- (–) Two cache classes to operate. Mixing them (replicating origin-cache entries abroad) is the failure mode to test for.
- (–) Legal "no foreign cache" pairs are slower. Do not "help" them with a cache flag.
- **Alternative rejected:** CDN in front of DICOM globally. CDNs are replicas. Some offer "geo fencing"; none of that is a substitute for "we do not put the object there."
- **Alternative rejected:** Foreign cache with lifecycle to archive "because storage is cheap." That sentence is a replica plus a forgotten archive in the wrong country.
- **Alternative rejected:** No cache at all. Origin cache is not the risk; omitting it makes in-region UX worse than the SAN for no compliance gain. Foreign cache is the risk; it is optional.
- **Revisit trigger:** Audit finds foreign objects past TTL, or a warming job in a repo, or TTL cap raised in prod without legal. Halt foreign cache fleet-wide, incident, this ADR is in breach until proven clean. Or legal withdraws ephemeral-copy allowance — cache off for those pairs.
