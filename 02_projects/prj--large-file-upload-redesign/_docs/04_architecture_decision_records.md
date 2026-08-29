# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Pre-signed URLs / Direct-to-Storage over Proxy-through-App

**Status**: Accepted

**Context**: The current path is browser → nginx → PHP-FPM → object storage. Users report that large uploads fail, for some people. Every hop has a size, time, memory, or concurrency limit. PHP-FPM workers and node temp disks are shared. Raising `client_max_body_size`, `upload_max_filesize`, and timeouts is the obvious patch. It leaves the app as a proxy: double transfer, worker occupancy proportional to file size and last-mile slowness, temp disk as a contention point. That class of failure does not go away; it moves.

The expected redesign, and the one this project commits to, is **S3 pre-signed URLs**: the client uploads directly to storage. The app issues a short-lived write permit and later verifies the object. nginx and PHP-FPM leave the data path.

**Decision**: Do not proxy file bytes through nginx/PHP-FPM. Authorize and verify in the existing PHP-FPM app. Transfer with pre-signed URLs (single PUT or multipart) against the object store. The old POST-the-file route is a time-boxed fallback during rollout, not the architecture.

**Consequences**:
- (+) Worker occupancy and temp-disk contention stop scaling with file size. "Only some people" caused by *which node was full* largely stops.
- (+) Last-mile retries can be per-part instead of restarting three serial legs from byte 0.
- (+) App-host egress of user bytes goes away.
- (–) New client uploader. A form POST is no longer enough. This is most of the engineering cost. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- (–) Bytes are invisible to the app in flight. Synchronous inspection is gone. [ADR-004](#adr-004).
- (–) CORS, signature clock skew, and capability-URL leakage become operational concerns that did not exist when the browser only talked to nginx.
- **Alternative rejected**: "Just raise the limits and stream to S3 from PHP." Cheaper this sprint. Still a proxy. Still occupies a worker for the whole transfer. Still two network legs. Still fails on ALB idle timeout for slow clients unless those timeouts are raised into "we now hang connections for 30 minutes," which is a different outage.
- **Alternative rejected**: A tus.io (or similar) server we host. Resumability is real, but we still terminate the data path. We would be rebuilding a worse S3 multipart. Use storage's protocol.
- **Revisit trigger**: object storage that cannot pre-sign, or a compliance regime that forbids browser-to-bucket. Then you need a dedicated streaming proxy sized for long requests (not PHP-FPM). That is a different system, not a return to `upload_max_filesize = 2G`.

## ADR-002: Multipart Above a Threshold; Single PUT Below

**Status**: Accepted

**Context**: Multipart is how large objects get per-part retry and how S3 wants large objects. It is also ceremony: `CreateMultipartUpload`, N part URLs, ETags, `CompleteMultipartUpload`, min part size 5 MB, max 10,000 parts. Forcing that on a 200 KB avatar is how the redesign makes small uploads worse than the broken path they replaced.

A single PUT for a multi-hundred-MB object reintroduces "any blip restarts the whole object" on the *client-to-storage* leg. That is still better than three legs through PHP, but it is not the large-file design.

**Decision**: Default threshold **T = 64 MB**. Below T: one pre-signed PUT; a failure retries the object. At or above T: server-created multipart, server-chosen part size (default 16 MB), client retries failed parts only. The client does not choose the protocol.

**Consequences**:
- (+) Small files stay a short, understandable flow. Phase 1 can ship this without multipart.
- (+) Large files get the retry property that actually matches the incident ("died at 90%").
- (–) Two code paths in the client and the complete handler. Tests must cover both. A bug that sends a 200 MB file down the single-PUT path will look like the old incident on a new URL.
- (–) 64 MB is a guess that should be confirmed against real last-mile: if a large fraction of "large" failures are 20–40 MB on slow mobile, T may need to drop. That is a parameter change, not a new ADR, unless someone proposes T = 0 (always multipart) or T = infinity (never multipart).
- **Alternative rejected**: always multipart. Punishes the common small file; more complete-bugs in production; more incomplete MPUs to abort.
- **Alternative rejected**: always single PUT. Leaves the original problem for the files that caused the tickets.
- **Not in v1**: cross-session resume (close the tab, continue tomorrow). Per-part retry *within* a live session is required. Persisting part progress across a new browser session is a product feature. Do not build a custom chunked protocol to get it.

## ADR-003: Server-Side Post-Upload Verification over Trusting the Client Callback

**Status**: Accepted

**Context**: After a direct upload, the client calls the app to say it is done. That call is authenticated, but the *body* of the claim ("I uploaded 12 MB of `video/mp4`") is not evidence. The client can lie, can have failed the PUT and reported success, can have PUT a different object to a leaked URL. Storage is the system of record for what bytes exist.

**Decision**: Completion always `HeadObject`s (and for multipart, the server calls `CompleteMultipartUpload` with the ETags, then still `HeadObject`s). Compare size and content-type to the session. Mismatch → `rejected`, no application file record. The client callback is a trigger, not a source of truth.

**Consequences**:
- (+) Quota and type policy have a second enforcement point after the capability URL has been used.
- (+) Complete is idempotent against double-submit if status is checked first.
- (–) Extra storage API call per upload. Negligible.
- (–) Pre-signed PUT does not perfectly enforce max size on the wire (POST policies do this better). Verification is *after* a too-large object may already exist; delete on reject. A hostile client can still cost a short burst of storage/bandwidth until expiry + complete. Short URL TTL limits the window. This is accepted, not solved.
- **Alternative rejected**: mark usable when the client reports 200. Cheaper. False. The first abusive or buggy client will fill the bucket with objects the app thinks are 5 MB avatars.
- **Alternative rejected**: download the object back through PHP to "inspect" it. Reintroduces the anti-pattern on the read path.

## ADR-004: Asynchronous Post-Upload Scanning with Quarantine, not Synchronous Proxy Inspection

**Status**: Accepted

**Context**: Direct-to-storage means PHP never sees the bytes. If the old path scanned (ClamAV on the temp file, a content-type sniff, a "strip EXIF" pass), that capability disappears at cutover unless it is replaced. Many proxy-through-app designs *claimed* they could scan and never did; Phase 0 must say which world this product is in.

Synchronous scan on a proxy path also had a cost: it extended worker occupancy by scan time. Replacing it with "scan in PHP after HeadObject by downloading the file" is the anti-pattern with extra steps.

**Decision**: If scanning is required, it is asynchronous: storage object-created event → scanner → write `clean` | `dirty` onto the session. Objects stay `pending_scan` (not usable, not served) until clean. Dirty → delete or quarantine prefix. Scanner outage → fail closed (`pending_scan` remains). If Phase 0 finds the old path did **not** scan, shipping without a scanner is an explicit accepted risk documented to security, not an accidental gap — and it is still recommended to add a scanner before inviting arbitrary large binaries.

**Consequences**:
- (+) Does not put bytes back through PHP-FPM.
- (+) Scan latency is decoupled from upload occupancy.
- (–) "Uploaded" and "available" are now different states. Product UX must say so, or support will field "I uploaded it and I cannot see it" during scan lag or scanner outages.
- (–) A scanner is a real service (Lambda + a scanning engine, a vendor, etc.). It is the largest *new* operational cost of doing this honestly. Pre-signed URLs do not include it.
- (–) Fail-closed during scanner outage will look like "uploads are broken." Fail-open will look like "we skipped security." The decision is fail-closed unless security signs fail-open in writing.
- **Alternative rejected**: block cutover forever until a perfect DLP suite exists. If the old path did not scan, this is using the redesign as a hostage. Scan is still the right shape; it is Phase 4, with a kill criterion: do not *remove* an old path that *did* scan until the new scanner is live. See [Phased Implementation Plan](./06_phased_implementation_plan.md).
- **Alternative rejected**: trust content-type and a file extension. That is not scanning.

## ADR-005: Short-Lived Pre-signed URLs plus Lifecycle Cleanup of Abandoned Multipart Uploads

**Status**: Accepted

**Context**: A pre-signed URL is a capability. Long expiry (hours, days) means a leaked URL in a log, a referrer, or a support HAR file remains a valid writer. Short expiry (seconds) dies on clock skew and on any pause.

Multipart uploads that are never completed leave parts in the bucket. S3 bills those. Users close tabs. Clients crash. Without a sweeper, this is a slowly growing bill and a mess of orphan parts.

Signing all part URLs at t=0 with one expiry makes a 2-hour upload impossible under a 15-minute URL TTL.

**Decision**:
- URL TTL is **minutes** (5–15). Session TTL may be **hours** for multipart.
- Multipart part URLs are issued in **batches** (`sign-parts`), so a long upload keeps getting fresh URLs without lengthening any single capability.
- Bucket **lifecycle** aborts incomplete multipart uploads after **D days** (1–7). An application janitor marks sessions expired and attempts `AbortMultipartUpload` as backup, not as the only sweeper.

**Consequences**:
- (+) Leaked URL window is bounded.
- (+) Incomplete MPU cost is bounded without a human.
- (+) Large uploads are not racing a single URL issued at start.
- (–) More `sign-parts` calls (small). Client must handle 403-expired with a re-sign, not a full restart.
- (–) Lifecycle D that is too short aborts a legitimate paused upload; too long costs money. Pick a number, put it in ops notes, do not make it a user-facing setting.
- **Alternative rejected**: 7-day pre-signed URLs so the client never re-signs. Convenient. A week-long write permit in the first access log that gets shipped to a vendor.
- **Alternative rejected**: manual `aws s3api list-multipart-uploads` when the bill spikes. That is not a design.
