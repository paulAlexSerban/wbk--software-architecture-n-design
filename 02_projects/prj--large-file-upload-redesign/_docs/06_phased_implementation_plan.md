# Large File Upload Redesign — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not "we already know it's nginx."** Building pre-signed URLs against a guessed root cause is how you ship CORS bugs on top of an untouched `413`. Phase 4 closes gaps the redesign opens; cutting over without it is allowed only when Phase 0 proved there was nothing to close.

Rollback/kill criteria at the bottom apply at every phase.

Calendar is not a one-week death march unless the incident is. A realistic first cut (Phase 0–1) is days; multipart + cutover is longer because of the client. Do not compress Phase 2 by skipping a forced part-kill drill.

## Phase 0 — Diagnose and Confirm (before any redesign work)

**Objective**: Name the layer(s) that are actually failing, with log evidence, and decide whether this project is a pre-signed-URL redesign or a php.ini incident. Replace "large files fail for some people" with a partitioned fault tree. See [Scenario — What to Check First](./01_scenario_and_requirements.md#what-to-check-first-and-why-that-one-first).

**Deliverables**:
- Access and error logs from nginx and the load balancer, for the ticket window, with status code and request duration. Table of counts: `413`, `408`/`499`, `502`/`504`, `200` with long duration, others.
- Correlation: failures vs reported file size; failures vs concurrent in-flight uploads; failures vs client ASN/VPN class if IP is logged.
- php.ini and FPM pool values actually loaded in production (`upload_max_filesize`, `post_max_size`, `memory_limit`, `max_execution_time`, `request_terminate_timeout`, `pm.max_children`), not the values in a repo sample.
- Whether the application slurps the upload into memory or streams.
- Disk: size and free space of `client_body_temp_path` and `upload_tmp_dir` on app nodes; any `ENOSPC` in the window.
- Storage SDK path: single `PutObject` vs multipart; timeouts; region.
- Product numbers: max allowed size, p50/p95 of *successful* uploads, whether scanning exists on the current path.
- A one-page "unknowns log": each failure mode is `observed`, `ruled out`, or `still open`. Open items that would change the design (e.g. "compliance forbids browser-to-bucket") are flagged immediately.
- Written ask to security: scan-required yes/no. Do not wait for the answer to finish the log work.

**Exit Gate**:
- [ ] Root cause(s) named with evidence — a status code, a duration cluster, a php.ini value, a disk event — not "probably nginx."
- [ ] Go/no-go: **large-file / concurrency / timeout class → proceed to Phase 1.** **Deterministic `413` / `UPLOAD_ERR_INI_SIZE` at a size the product actually wants, and no pool/disk story → tune limits, stream, stop this project.** Both outcomes are successful Phase 0.
- [ ] If proceeding: max size and scan-required are written down (scan-required may still be "awaiting security"; then Phase 4 is assumed required until a written no).
- [ ] Feasibility: browser-to-bucket is not already forbidden. If it is, stop and design a streaming proxy; do not quietly start Phase 1.

Do not "start the uploader in parallel" before this gate. Parallel is how the wrong system gets a head start.

## Phase 1 — Small-file Pre-signed PUT, Additive (flagged)

**Objective**: Prove the control plane and CORS with files that do not need multipart, without taking the old path off the air.

**Deliverables**:
- Authorize + complete + `HeadObject` verification for `protocol = single_put`.
- `upload_session` persisted; keys server-minted; URL TTL in minutes.
- Browser PUT to storage for a subset of traffic (flag, internal users, or size < T).
- Bucket CORS for the real frontend origin, with a documented origin list.
- Old POST-the-file path still default for everyone else.
- Minimum metrics: authorize, complete, complete-fail-by-reason, flag exposure.

**Exit Gate**:
- [ ] Internal (or flagged) users can upload a file below T end-to-end in production (or production-like), object lands, session becomes `usable` (or `pending_scan` if scanner already exists).
- [ ] Complete is idempotent on double-submit.
- [ ] A deliberately too-large or wrong-type object is `rejected` and not usable.
- [ ] Full pre-signed URLs are not in application logs.
- [ ] Old path still works for unflagged users. This phase does not "fix large files" yet; claiming it does is a failed gate.

If CORS fails this gate, **do not start Phase 2**. Multipart will fail the same way N times per file.

## Phase 2 — Multipart for Large Files

**Objective**: Take the files that caused the tickets off the proxy path, with per-part retry and session tracking.

**Deliverables**:
- Server `CreateMultipartUpload`, server-chosen part size, `sign-parts` batching, complete with ETags, then `HeadObject`.
- Client: part PUT, retry of a failed part without re-sending completed parts, re-sign on expired URL.
- Bucket lifecycle: abort incomplete MPUs after D days.
- Janitor: expire `pending` sessions and attempt `AbortMultipartUpload`.
- Drill script/runbook: kill the network during part N; confirm parts 1..N-1 are not re-uploaded.

**Exit Gate**:
- [ ] A forced mid-transfer kill on one part resumes without re-uploading completed parts (observed, not "the code looks like it would").
- [ ] A session abandoned without complete is aborted by lifecycle within D days (or by janitor in a drill with a shortened D in a non-prod bucket).
- [ ] A 10,000-part-limit / min-part-size violation cannot be produced by the client using the server's P at the product's max size (arithmetic on paper is enough; do not upload 160 GB to prove it).
- [ ] `ETag` is exposed in CORS; complete actually receives ETags from the browser (this is the Phase 2 equivalent of the Phase 1 CORS gate).
- [ ] Flag can send size ≥ T through the new path in the same environment Phase 1 used.

## Phase 3 — Cutover

**Objective**: Default all uploads to the new path. Keep the old proxy path as a documented, time-boxed fallback only.

**Deliverables**:
- Flag default ON for new uploads.
- Old route: authenticated fallback or explicit 410 after the time-box, not a silent second way to fill temp disk.
- Error-rate and duration dashboards comparing before/after for small and large; FPM busy workers and temp-disk usage on app nodes (those should fall).
- Support note: last-mile part retries vs origin outage; "uploaded vs available" if scan exists.

**Exit Gate**:
- [ ] Proxy-path upload traffic near zero (define near: < 1% or only the explicit fallback).
- [ ] Large-file success rate improved vs Phase 0 baseline. Small-file success rate **not regressed**.
- [ ] FPM pool exhaustion / temp-disk incidents on upload correlated load have dropped or disappeared. If they have not, the file is still on the path — find the leftover route.
- [ ] Time-box date for old path removal is on a calendar, not "when we are sure."
- [ ] If Phase 0 said the old path **scans** and Phase 4 is not live: **do not remove the old path yet.** Fallback remains until the scanner gate passes. Cutover of *default traffic* may still proceed only if those uploads are either still scanned (old path) or quarantined (new path). Do not default large unsanned binaries to usable. See kill criteria.

## Phase 4 — Close the Gaps the Redesign Opened

**Objective**: Make the new path honest about inspection and leftover proxy machinery.

**Entry Gate**: Phase 3 default is on, or Phase 3 is blocked only on this phase's scanner. Do not use Phase 4 as a place to hide an incomplete uploader.

**Deliverables**:
- Async scanner wired to object-created; session `pending_scan` → `usable` | quarantined; fail closed on scanner outage.
- Verification enforced (already designed; confirm it is not still a TODO behind a flag).
- Old nginx/PHP upload body limits and the POST-the-file handler removed or 410'd; `client_max_body_size` returned to a JSON-sized default on those hosts if it was raised as a bandage.
- Runbook: rejected objects, abandoned MPUs, leaked-URL response (wait out TTL; rotate signing keys only if mass leak).

**Exit Gate**:
- [ ] If scanning is required: a dirty test object never becomes `usable`; a scanner-down drill leaves objects in `pending_scan` and pages.
- [ ] If scanning is not required: a written security acceptance of that risk exists, dated.
- [ ] Old file-body route returns 410 or is gone. Temp-disk capacity planning for uploads is deleted from the app-host runbook.
- [ ] `upload_max_filesize` is no longer part of the upload architecture (it may still exist in php.ini for unrelated reasons).

This phase may be short (no scanner required, old path already 410) or the longest (scanner procurement). Both are successful if the gaps are named and either closed or accepted in writing.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop, roll the flag back, or kill the project — do not "keep the new path on to see if it settles" — if any of the following hold:

1. **Phase 0 says tune-the-knobs.** Proceeding to pre-signed URLs anyway is résumé-driven. Kill this project; raise the limit; stream.
2. **Small files get worse after Phase 1/3.** Roll the flag back. Fix the client/CORS. Do not force multipart onto avatars to "standardize."
3. **Browser-to-bucket is forbidden** and will not be approved. Kill; do not hide a proxy in a Lambda that then has the same timeouts.
4. **Old path scanned, new path would mark usable without a scanner.** Do not remove or default-off the scanning path. Phase 3 default-on for the new path is blocked for types that required scan until Phase 4 lands — or the new path must stay `pending_scan` forever, which is a user-visible outage. Pick: delay cutover, or fail closed with a banner, not silent unsanned usable.
5. **Incomplete MPU bill growing with no lifecycle.** Do not expand traffic. Fix the sweeper. This is a cost incident in slow motion.
6. **Full pre-signed URLs in logs or analytics.** Treat as credential leak; shorten TTL; scrub; do not proceed to higher traffic.
7. **Pressure to skip HeadObject verification** so complete "feels faster." That request is a kill criterion for quality, not a performance suggestion.

Rollback is always to the last phase whose exit gate was honestly green — typically "flag off, old path default." After a kill, the honest output is the Phase 0 diagnosis plus whatever knob change is justified. The output is not a half-enabled uploader that still POSTs 500 MB through PHP-FPM when the flag is off, undocumented.
