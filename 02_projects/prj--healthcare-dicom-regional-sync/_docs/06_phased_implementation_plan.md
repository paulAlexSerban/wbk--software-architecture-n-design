# Healthcare DICOM Regional Sync — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not "we already know we need S3."** Building a consultation broker against an unsigned legal matrix is how you ship a faster unlawful transfer. Phase 6 is site grind; compressing it by skipping per-site verify is how FTP never dies.

Rollback/kill criteria at the bottom apply at every phase.

Calendar is not a quarter unless the organization is already one cell. A realistic Phase 0 is weeks to months (legal). A realistic first ingest pilot (Phase 1) is a small number of hospitals in **one** region. Fleet FTP decommission is measured in sites, not sprints. Do not put "150 hospitals live" on a slide that funds a single bucket.

## Phase 0 — Discovery and Legal Baseline (before any cell is a production store of PHI)

**Objective**: Replace "we have 150 hospitals and HIPAA/GDPR" with a jurisdiction map, a data-flow map of **current** FTP/PACS forwards, a PII-in-DICOM sample, WAN numbers, and a written legal position per jurisdiction pair. See [Scenario — What to Check First](./01_scenario_and_requirements.md#what-to-check-first-and-why-that-one-first).

**Deliverables**:
- Inventory of sites: country, legal jurisdiction (not "EU"), current PACS vendor, SAN role, whether a distinct buffer disk is possible.
- **Data map**: for each site, where identifiable DICOM is sent today (other hospitals, teleradiology groups, vendor clouds, research shares), with destination jurisdiction. Script configs, firewall flows, vendor "auto-forward" settings — not interviews alone.
- Immediate legal action list: flows that are already a cross-border PHI transfer without a recorded basis. This may mean **stopping jobs** before any new system exists. Technology does not get a veto.
- DICOM PII audit: sample per major modality (CT, MR, US, XA, CR/DX, SR): standard tags, private tags, burned-in overlays. Record what a naive tag-strip would miss.
- WAN: bytes/day (or week) per candidate pilot site, loss/failure rate of current FTP, p50/p95 study size, contention windows.
- Product/clinical numbers: max study size, whether foreign reading is a must, rehydration SLA they will sign, D days to keep hot.
- Legal matrix v0: every origin×viewer pair is `approved` (basis, expiry, cache allowed y/n), `denied`, or `pending`. **Pending is not approved.**
- Break-glass policy draft: who, when, review SLA.
- Unknowns log: each item `observed` / `ruled out` / `still open`. Open items that change the design (e.g. "jurisdiction forbids even stream") flagged.
- Written ask outstanding: SCCs/BAAs, erasure-vs-retention workflow. Do not wait to finish the data map.

**Exit Gate**:
- [ ] Data map exists. At least one of: confirmed no current cross-border identifiable flows, **or** a dated legal/ops action for those that exist (stop, or documented exceptional basis).
- [ ] Site → jurisdiction → intended `region_id` mapping for all 150 (may group; none may be "TBD" for a site that will send PHI).
- [ ] Pilot region and 1–N pilot hospitals named, with WAN and buffer-disk facts.
- [ ] Rehydration SLA and hot-window D written down (even if "always warm for CT for 90 days").
- [ ] Legal matrix v0 published internally. Phase 3 may only enable `approved` pairs. `pending`/`denied` have a named fallback (manual export, locum, nothing).
- [ ] PII sample recorded; de-id profile v0 draft exists (may be incomplete; Phase 2 tightens).
- [ ] Go/no-go: **multinational + cross-border need or unlawful current state → proceed.** **Single jurisdiction, no foreign read → kill the broker and N-cell program; do a one-cell ingest/archive if WAN/SAN justify it.** Both outcomes are successful Phase 0.

Do not "stand up the global bucket in parallel" before this gate. Parallel is how CRR gets enabled in a landing zone.

## Phase 1 — Regional Ingestion Pilot (zero-loss, one cell, FTP still default elsewhere)

**Objective**: Prove that a closed study can leave a hospital buffer and become `stored_verified` in the **origin** cell under simulated WAN failure, with a SOP manifest, without writing another region.

**Entry Gate**: Phase 0 go for at least one cell. Pilot sites have a buffer plan (even if "same SAN, here is the occupancy budget").

**Deliverables**:
- One origin cell: bucket/prefix, CMK, org deny of CRR on `raw/`, ingest control plane, inventory.
- Edge buffer on pilot sites: local ack, resumable multipart **to origin only**, manifest.
- Verify path: checksum + SOP inventory; mismatch → `transfer_quarantine`.
- Metrics: closed vs verified, resume count, buffer occupancy, verify-fail reasons.
- Drill: kill WAN mid-study ≥ 1 GB (preferably ~product p95); show resume; show bit-identical verify.
- Drill: complete-without-verify is impossible (force a truncated last part; study must not become `stored_verified`).
- IAM review: no role in another account/region can `PutObject`/`GetObject` this `raw/` except the designed broker **later**; in Phase 1 the broker does not exist — **no foreign GetObject either** except break-glass ops in-region.
- Legacy FTP for pilot sites **still running** unless legal already halted a cross-border job. Dual-write is allowed only if the FTP destination is **in-region** and understood as drain-later. Dual-write **across** a border is not a Phase 1 convenience.

**Exit Gate**:
- [ ] WAN-kill drill observed (not "the SDK would resume"): completed parts not re-sent, verify green, instance count matches PACS.
- [ ] Truncation drill: not `stored_verified`.
- [ ] CRR deny tested (attempted replicate job fails).
- [ ] Buffer occupancy alert fires in a fill drill.
- [ ] `closed_but_not_verified` dashboard exists and is watched.
- [ ] No PHI from the pilot landed in another region's buckets (account inventory / access logs).
- [ ] Decision on buffer-on-same-SAN contention: acceptable for these sites or hardware on order. Do not silently scale to 20 sites on a lie.

Phase 1 does **not** decommission fleet FTP. Claiming "sync is fixed" after one cell is a failed gate.

## Phase 2 — De-identification and Global Metadata Fabric (pilot region)

**Objective**: Promote only what passes a fail-closed gate. Prove a seeded identifier cannot be queried globally.

**Entry Gate**: Phase 1 exit green. De-id profile v0 from Phase 0. Quarantine reviewers named (HIM/privacy), with a capacity number. If nobody can review, **do not turn on promotion**; quarantine-only is allowed as a dry run.

**Deliverables**:
- De-id workers in origin, profile versioned, re-id map in origin only.
- DLP on tags; pixel checks for the in-scope list (may be empty in v1 except the seeded overlay test).
- Regional quarantine queue + reviewer workflow (even if ticket-based).
- Global metadata fabric that accepts **only** promotion events. No pixel bus.
- Seeded-PII suite: phantom PatientName/PatientID in tags, Comment-field leak, burned-in overlay on a test series. Automated run in CI or a controlled pipeline.
- Retract procedure: if a bad record is found in global, delete/tombstone and halt class.

**Exit Gate**:
- [ ] Seeded tag PII never appears in global query after promotion path; Comment-field leak quarantines.
- [ ] Burned-in overlay: either detected and quarantined, **or** explicitly **not promoted as pixels** (v1 metadata-only already) **and** metadata fields do not contain the overlay text. If overlay text was OCR'd into a metadata field, that is a fail — halt.
- [ ] Re-id table inaccessible from the global account (IAM test).
- [ ] Quarantine is not auto-emptying. Reviewer SLA defined; backlog visible.
- [ ] Profile version stored on each global record.
- [ ] Research user can query de-identified fields and **cannot** fetch raw objects from this path.

If seeded tests fail, **stop promotion**. Do not "skip the phantom, ship." That is a kill criterion for this phase's traffic, not a waiver.

## Phase 3 — Cross-Region Consultation Broker (approved pairs only)

**Objective**: A specialist in an **approved** viewer jurisdiction can view an origin study as a session, with audit, without a durable foreign copy. Unapproved pairs 403.

**Entry Gate**: Phase 2 exit (so we are not streaming studies we cannot even classify). Legal matrix has at least one `approved` pair **or** this phase is built in a lab with synthetic data and **does not** see production PHI until a pair is approved. Production PHI + unapproved pair = forbidden.

**Deliverables**:
- Broker: authn (existing IdP), authz (relationship or glass), pair check, session TTL, origin audit open/close, token revoke.
- Pixel path: origin-signed ranges or proxy **without durable spool**; disk-wipe / tmpfs drill.
- Break-glass: reason mandatory, distinct audit, review queue.
- Viewer integration sufficient to open a CT series (not a new PACS). Download/save disabled where the stack allows.
- Manual-export runbook for `denied`/`pending` pairs (human legal path).
- Metrics: fail reasons (`no_pair`, `authz`, `expired`, `ok`), glass rate, session duration, bytes.
- IAM: broker `GetObject` origin raw as needed; **no** `PutObject` on any raw prefix in the viewer region.

**Exit Gate**:
- [ ] Approved pair: end-to-end view of a real-sized study (or production-like phantom in the cell).
- [ ] Denied pair: 403 in production-like config; no bytes.
- [ ] Expired pair: session cannot start; in-flight session cut on ticker (drill).
- [ ] Broker kill mid-stream: no recoverable `.dcm` on broker disk (forensic pass).
- [ ] Audit row in **origin** contains who, study key, basis, times.
- [ ] Glass creates a review ticket.
- [ ] Foreign `PutObject` of raw from broker role fails IAM test.
- [ ] Clinical/product signed the "first open may take minutes" sentence for this pair.

Do not enable foreign cache in this phase. That is Phase 4, and only if the pair's matrix says cache allowed.

## Phase 4 — Edge Caching and Retrieval Performance

**Objective**: Fast in-region repeats; optional foreign short-TTL cache that can be **proven empty** after purge. Cache must not become a replica.

**Entry Gate**: Phase 3 sessions work. Legal matrix `cache allowed` is yes or no **per pair**. Default no.

**Deliverables**:
- Origin read-through cache, bounded TTL, access-logged.
- Foreign cache implementation **behind a per-pair flag**, TTL short, platform cap, session-end purge, sweeper, capacity cap, no warmer.
- Audit on cache hits (still a view).
- Drill: after TTL/session end, forensic pass in viewer region finds no study bytes (or only encrypted debris that the sweeper then removes — define pass criteria).
- Drill: attempt to set TTL > cap fails.
- Metric: entries_past_ttl ≈ 0; alert ≠ 0.

**Exit Gate**:
- [ ] Origin cache improves repeat-open time in-region (measured).
- [ ] For a `cache allowed=no` pair, foreign cache remains empty under a view load test.
- [ ] For a `cache allowed=yes` pair, populate → hit (audited) → purge → emptiness probe green.
- [ ] No warming job in the repo or in cron.
- [ ] Runbook: treat `entries_past_ttl > 0` as compliance incident.

If emptiness probe fails, **foreign cache off fleet-wide** until fixed. Origin cache may stay.

## Phase 5 — Lifecycle Archival (origin)

**Objective**: Move cold origin bytes to cheaper class without breaking holds or inventing a foreign copy. Measure rehydrate against the Phase 0 SLA.

**Entry Gate**: Phase 1 inventory is trustworthy (`stored_verified` is real). Holds: at least "age < D days stay hot" plus a manual legal_hold flag. EHR active-care optional.

**Deliverables**:
- Policies: hot → warm → cold in origin; legal_hold; active_care_hold if available; never cross-region.
- Rehydrate API/runbook; SLA clock; page on breach.
- Cost report: storage class mix vs all-hot projection (even a rough one).
- Drill: archive a phantom, rehydrate, time it, view via origin and (if a pair exists) via broker **after** origin is warm — not by copying cold to viewer region.
- Emergency runbook: cold study, clinical emergency, in-hours vs 3 a.m.

**Exit Gate**:
- [ ] A study older than policy is in the intended class; a held study is not.
- [ ] Rehydrate drill meets SLA **or** SLA is renegotiated in writing before expanding policy (do not quietly miss).
- [ ] No lifecycle rule targets a foreign bucket.
- [ ] Finance can see class mix. Clinical ops has the emergency runbook.

If SLA cannot be met with the chosen archive class, **stay warmer** or change class **in region**. Do not "fix SLA" with CRR.

## Phase 6 — Multi-Region Rollout and Legacy Decommission

**Objective**: Repeat the cell pattern per region; onboard hospitals behind per-site gates; remove SAN/FTP scripts only when that site's Phase-1-equivalent is green and in-region dual-write has drained.

**Entry Gate**: Phases 1–2 green in the pilot cell. Phase 3 only for pairs that are approved as those regions go live. Do not require Phase 4–5 for the second region's ingest; do require Phase 0 mapping for that region (legal is not copy-paste).

**Deliverables**:
- For each new region: cell (store, CMK, CRR deny, ingest, de-id workers, audit sink), matrix rows, on-call.
- For each site: buffer, occupancy budget, WAN math, dual-run with **in-region** legacy only, then FTP disable date.
- Fleet dashboard: sites `ftp_only` | `dual` | `new_path` | `blocked` (buffer full / legal / WAN).
- Time-box per site on `dual`. Dual forever is a kill criterion for "we rolled out."
- Stop-the-line: any site found FTP'ing identifiable studies to a foreign destination after its legal action date.

**Exit Gate** (program-level; may be years):
- [ ] Every site is `new_path` or `blocked` with an exec-visible reason — none are forgotten `ftp_only` in a non-pilot country.
- [ ] Cross-border FTP jobs are zero (access/firewall evidence).
- [ ] Each live region has CRR deny, re-id isolation, promotion gate.
- [ ] Broker only serves `approved` pairs; glass rate reviewed quarterly.
- [ ] Foreign cache still empty for `cache allowed=no` pairs (spot checks).

This phase is successful if it is slow and honest. It is failed if it is "done" on a slide while FTP still runs.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop, roll a flag back, halt promotion, disable a pair, or kill the multinational scope — do not "keep it on to see if it settles" — if any of the following hold:

1. **Phase 0 says one country / no foreign read.** Building N cells and a broker is résumé-driven. Kill that scope; a one-cell ingest is a different, smaller plan.
2. **Legal cannot approve a pair.** That pair **never** gets live streaming. Manual fallback only. An engineer flag is a firing offense, not a shortcut.
3. **Data map finds ongoing unlawful FTP and ops will not stop it.** Do not add a second path that "might" replace it. Escalate. The new system is not cover.
4. **Seeded-PII test fails, or production sampling finds identifiers in the global fabric.** Halt promotion for the class; retract; do not ship research access.
5. **Broker or any foreign worker can PutObject raw, or CRR is on.** Halt cross-region features; incident; IAM/SCP before any new session.
6. **Foreign cache retains data past TTL, or a warmer appears.** Foreign cache off; compliance incident. [ADR-006](./04_architecture_decision_records.md#adr-006).
7. **Broker disk forensic finds identifiable instances after a kill drill.** Do not expand pairs; fix spooling.
8. **Site buffer structurally full / WAN cannot converge on verified.** Do not onboard the next hospital. Network or disk first. Do not relax verify.
9. **Glass rate is the dominant path** and nobody is changing legal matrix or UX. Stop pretending the happy path exists; executive review. Do not "make glass quieter."
10. **Pressure to enable CRR for DR or for "the radiologists are angry."** That request is a kill criterion for quality of this architecture. The alternative is a signed always-hot in-region spend or a signed clinical acceptance of wait time — not replication.
11. **Identifiable audit or DICOM dumps in a global SIEM.** Stop the feed; regionalize; treat as a transfer.
12. **Dual FTP+new path with no drain date after the time-box.** The program is lying. Reset the date or declare blocked.

Rollback is always to the last phase whose exit gate was honestly green — typically "broker off, promotion off, ingest still up in-region" or "flags off, FTP in-region only if still lawful." After a kill of the multinational scope, the honest output is the Phase 0 map plus a one-cell plan if warranted. The output is not a global bucket with CRR "temporary" and a wiki that still says residency cells.
