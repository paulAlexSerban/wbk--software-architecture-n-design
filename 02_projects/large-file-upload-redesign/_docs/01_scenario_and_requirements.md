# Large File Upload Redesign: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

Users report that file uploads fail, but only for large files, and only for some people. The path is browser → nginx → a PHP-FPM application, which then forwards the file to object storage.

The design must answer, concretely:

1. What can plausibly fail at each layer *for large files specifically*.
2. What you would check first, and why that check before anything else.
3. How the upload is redesigned so this class of problem largely stops happening.
4. What that redesign costs in complexity.

This is the pre-signed URL trap. The naive answer — raise `client_max_body_size`, raise `upload_max_filesize`, raise the timeouts, and hope — is the failure. It treats a structural anti-pattern as a config-tuning problem. The limits are real and they must be named, because they *are* what is failing today. They are not the architecture.

The correct shape is: **the client uploads directly to object storage using a short-lived pre-signed URL; nginx and PHP-FPM leave the data path and only authorize, issue, and verify.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true under authorization, multipart, abandoned uploads, malware scanning, and "the client lied about finishing."

## The Trap, Stated Directly

Passing large files through nginx and PHP-FPM to S3 is a known anti-pattern. Every hop on that path has a size limit, a time limit, a memory limit, or a concurrency limit that was never designed for holding a 500 MB video in flight. Raising those limits does not remove the hop; it just moves the next failure further out, and it makes the app a worse proxy: workers stay occupied longer, temp disks fill faster, and a slow client still occupies a PHP-FPM worker for the entire transfer plus the entire re-upload to storage.

The "only for some people" clause is load-bearing. A hard `413 Request Entity Too Large` would fail for *everyone* over the line. Intermittent, user-correlated failure is almost never "the file is too big" in the abstract. It is: this user's network is slower, this user's request landed on a node whose temp disk was already full, this user's upload coincided with enough other large uploads that the FPM pool was exhausted, this user's VPN idle-killed a 90-second PUT. File size is the exposure; the other users and the other hops are the variance.

## Current State (Assumed Starting Point)

A typical first version of this path looks like:

1. Browser `POST`s a `multipart/form-data` body to an app URL behind nginx.
2. nginx buffers the entire body (`proxy_request_buffering on`, the default) then hands it to PHP-FPM.
3. PHP writes a temp file, the application reads it, and a single `PutObject` (or SDK equivalent) forwards the whole object to storage.
4. The HTTP response to the browser is returned only after storage has accepted the object.

That version will appear to work in staging with a 2 MB JPEG on a fast laptop, against an empty FPM pool, with a developer-tuned nginx. It will fail in production the first time a 200 MB file is uploaded from a phone on a train, the first time two such uploads land on the same container, the first time an ALB idle timeout of 60 seconds meets a slow last mile, or the first time `upload_max_filesize` is still `2M` because nobody who shipped the feature checked php.ini.

This project documents the replacement, not a patch of those knobs.

## Layer-by-Layer Fault Tree (Large Files Specifically)

Walk the path. At each layer, name only what fails *because the file is large*, or *because largeness makes a shared resource scarce for some people*. Generic "the server is down" is out of scope.

### Browser / client

- **No resumability.** A transfer that dies at 95% restarts at byte 0. The probability of hitting *any* transient blip scales with transfer duration, not with file size as such. Large files fail more often for a reason that has nothing to do with bytes: they are simply in flight longer.
- **Tab backgrounding / OS throttling.** Mobile browsers deprioritize or freeze background tabs. A 20-minute upload that the user "left running" is a 20-minute bet that the OS will not freeze the socket.
- **Wi-Fi handoffs, cellular drops, corporate VPN idle disconnects.** These events are common on the paths of "some people" (commuters, office VPN users) and rare on the paths of others (wired office LAN). Same file, different last mile, different outcome.
- **The browser's own request timeout / user-aborts.** Some corporate-managed browsers, extensions, or "security" proxies kill long POSTs. This looks like a server bug in the ticket. It is not.

What this layer does *not* explain by itself: a clean, immediate `413`. That is not the client; that is nginx. Do not start here if the status code is already in the log.

### Network / load balancer

- **Idle timeouts.** An ALB default idle timeout of 60 seconds kills a slow upload mid-flight even when the client is still sending. The request looks healthy until it vanishes. Slow last-mile users are selected for this; fast users never hit it. That is "only some people" with a round-number duration in the access log.
- **Request/body size limits at the LB.** Some LBs have their own max-body settings independent of nginx. A 413 or a silent reset that never reaches the app is possible here.
- **Path MTU / corporate SSL-inspecting proxies.** Some office networks re-wrap HTTPS and mishandle large request bodies. Again: some people, some networks, not the file.

### nginx

- **`client_max_body_size`.** Default is `1m`. Over the line → `413 Request Entity Too Large`, for everyone over the line. This is the most famous knob and the least likely explanation of *intermittent* "some people" failure — unless "some people" is actually "everyone who tries a file over 1 MB" and the ticket language is sloppy. Check it anyway; it is a 10-second grep.
- **`client_body_timeout` / `proxy_read_timeout` / `proxy_send_timeout`.** Defaults cluster around 60 seconds. A large file on a slow connection hits these; a large file on a fast connection does not. Same size, different people.
- **`proxy_request_buffering on` (the default).** nginx buffers the *entire* request body to disk (`client_body_temp_path`) before PHP-FPM ever sees a byte. Consequences that scale with file size:
  - Disk I/O and wall-clock time are paid twice (buffer, then proxy).
  - Failure is now tied to **available temp disk on that specific node**. Two concurrent 400 MB uploads on a container with 512 MB of ephemeral disk will fail one of them, or both, while a third user on a different node with an empty disk succeeds with the same file. This is a leading candidate for "only some people."
- **`client_body_buffer_size` overflowing to disk** under concurrency, then hitting `ENOSPC`. Same signature: correlated with concurrent large uploads, not with a particular user account.

### PHP-FPM / PHP

- **`upload_max_filesize` / `post_max_size`.** Commonly still `2M` / `8M` on images that "nobody changed." Failure mode is often *silent*: `$_FILES` is empty, or the error code is `UPLOAD_ERR_INI_SIZE`, and the application returns a generic 400/500 that the user files as "upload failed." This fails large files deterministically once they cross the line. If "some people" maps cleanly onto "people who pick files over 8 MB," this is it. Must be *read*, not guessed.
- **`max_execution_time` / pool `request_terminate_timeout`.** These timers often do **not** include the time nginx spent buffering the body (nginx already has the file). They **do** include PHP's own work: open the temp file, stream it (or worse, slurp it) to S3. So they fire specifically on the storage-forward leg, and specifically for large files, which take longer to re-upload. A 30-second `max_execution_time` with a 200 MB `PutObject` on a modest uplink from the app host is a ticking clock, not a mystery.
- **`memory_limit` if the app reads the whole upload into memory** (`file_get_contents`, building a string, an SDK call that buffers). Cost scales linearly with file size. This fails large files and only large files, deterministically, and is independent of "some people" unless some people upload larger files. If the code streams, this is not the cause. If the code does not stream, this is an embarrassingly likely cause.
- **FPM worker pool exhaustion.** Each in-flight upload occupies a worker for the *entire* receive + forward duration. Under concurrent large uploads the pool saturates. *Other* users — including users uploading small files, or hitting unrelated endpoints — get `502` / `504`. The person who filed the "large file upload failed" ticket may be the victim of someone else's 500 MB upload occupying the last worker, or may be the occupier whose own request was then killed. This is the leading candidate for "only some people" that is not actually about the file at all: it is about shared concurrency on a process model that was sized for short PHP requests.

### PHP → object storage leg

- **Single `PutObject`, no multipart.** The whole object must succeed as one HTTP call from PHP to storage. A mid-transfer blip on *this* leg restarts the entire upload from PHP's side. The browser sees only "it failed." The user retries from byte 0 of *their* upload, which then repeats the whole three-leg journey.
- **Three serial legs, three timeout budgets.** Time-to-success is `(client → nginx) + (nginx → PHP) + (PHP → S3)`. PHP-FPM's budget is usually the shortest and the least tuned for this. The storage SDK has its own timeouts, often also ~60s, which are fine for a 5 MB object and lethal for a 500 MB object on a non-gigabit path from the app host.
- **App-host egress.** The file is downloaded from the user (ingress) and then uploaded to storage (egress). You pay transfer twice, you occupy the app host's NIC twice, and you are now sensitive to the *app host's* path to S3, which is a different network than the user's. A regional S3 endpoint vs a cross-region default, a NAT gateway throughput cap, a security-group that forces a proxy — any of these fail large files first.

### Infra around the app

- **Ephemeral disk on the instance/container.** nginx temp buffering + PHP's `upload_tmp_dir` can both live on the same small volume. Concurrent large uploads fill it. The next request — possibly a small one — fails with a 500 that mentions nothing about disk. "Some people" is really "some node, some moment of concurrency."
- **Horizontal scaling that does not help.** Adding PHP-FPM workers or app containers without adding disk and without taking the file off the path just multiplies the number of places a large upload can land and fill a disk. Scaling the proxy is not a substitute for not being the proxy.

## What to Check First, and Why That One First

**Check first: nginx and load-balancer access + error logs, filtered by status code and request duration, correlated against the reported file sizes and timestamps.**

This is a read-only, no-repro-needed check. It partitions the entire fault tree in minutes.

| What you see | What it isolates | Why it is cheap |
| --- | --- | --- |
| `413` at nginx (or the LB) | `client_max_body_size` (or the LB equivalent). Stop. That is the cause for everyone over the line. | One grep. No reproduction. |
| Duration clustered on a round number (~60s, ~30s) then a `408` / `499` / `504` | A timeout knob at that hop. Compare nginx timeouts vs LB idle timeout vs PHP `request_terminate_timeout`. The round number tells you which clock fired. | Durations are already in the access log. |
| `502` / `504` from nginx with no matching nginx timeout in error log | PHP-FPM: worker exhaustion, `request_terminate_timeout`, or PHP fatal (`memory_limit`). Next stop is FPM slow log / `pm.max_children` vs active workers at that timestamp. | Distinguishes "proxy timed out waiting" from "proxy itself timed out the body." |
| Failures that correlate with *concurrent* upload volume, not with file size alone | Shared-resource contention: temp disk, FPM pool. This is the "only some people" signature. | Overlay upload-start timestamps. If failures cluster when two large uploads overlap, stop blaming the file format. |
| Failures that correlate with a particular client subnet / ASN / "corporate VPN" User-Agent class | Last-mile / proxy path, not the origin. | Geo/IP is already in the log if you log it; if you do not, that is a finding for Phase 0, not a reason to skip logs. |
| App log shows empty `$_FILES` or `UPLOAD_ERR_INI_SIZE` | `upload_max_filesize` / `post_max_size`. Deterministic, and often misreported as a "random" failure because the app's user-facing error is generic. | One PHP error code. |

**Why not reproduce first.** Reproduction requires the reporter's file, the reporter's network, and the production concurrency at the moment of failure. You will not get all three. The log already has the status code and the duration. Start there.

**Why not raise the limits first.** Raising `client_max_body_size` to `2g` and `upload_max_filesize` to `2G` will make a 413 go away and will make a 50 MB file start working in staging. It will not fix FPM pool exhaustion, temp-disk fill, ALB idle timeouts, or the double-transfer. You will have spent the incident converting a cheap, diagnosable failure into a more expensive, rarer one. Diagnose, then decide whether the redesign is justified. The redesign is justified when large files are a real product requirement, not when a 413 is annoying.

**Second check, only after the log partition:** php.ini and the FPM pool config (`upload_max_filesize`, `post_max_size`, `memory_limit`, `max_execution_time`, `request_terminate_timeout`, `pm.max_children`), *and* whether the application slurps the file into memory. Third: disk usage on `client_body_temp_path` and `upload_tmp_dir` at the time of failure (or a canary that alerts on inode/space). Fourth: the storage SDK call — single PUT vs multipart, timeout, region.

## Target Users

- **Owning engineer**: implements the upload path; needs a diagnosis order they can run at 2 a.m. and a redesign they can defend when someone asks why the browser talks to S3.
- **On-call**: needs to know, from status code and duration, which layer failed, without reproducing a 400 MB upload from a phone.
- **Security**: needs to know that bytes no longer transit the app, so synchronous inspection is gone, and what replaces it.
- **Product**: needs to know that "just make big uploads work" is not a config change; it is a client rewrite plus a control plane.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which file types the product accepts, the progress-bar copy) are out of scope.

1. **Uploads must succeed for files far larger than convenient HTTP request-body sizes.** "Convenient" here is a few megabytes. Product sizes (video, design files, archives) are tens to hundreds of megabytes, sometimes gigabytes. The data path must not be an HTTP request to PHP-FPM.
2. **Failure must not correlate with concurrent load from other users.** Occupying an FPM worker or a node's temp disk for the duration of someone else's upload is not an acceptable coupling.
3. **A retry must not mean start over from byte 0 for large transfers.** Per-part retry (multipart) is in scope. Cross-session resume after the user closes the tab is *not* a v1 requirement; see non-goals and [ADR-002](./04_architecture_decision_records.md#adr-002).
4. **The application must not need to hold the whole file in memory or on local disk.** Local disk is an accident of the current path, not a feature.
5. **Authorization must still gate who can upload what**, even though the server no longer sees the bytes. A pre-signed URL is a capability. Issuing it is the authorization event.
6. **The object is not trusted until the server has verified it.** Client "I'm done" is a hint. `HeadObject` (size, content-type) and, where required, a checksum comparison against what was authorized, are the accept step. See [ADR-003](./04_architecture_decision_records.md#adr-003).
7. **Malware / content scanning, if it existed on the proxy path, must have an explicit replacement.** "We no longer see the bytes" is not a scanning strategy. See [ADR-004](./04_architecture_decision_records.md#adr-004).

## Success Criteria for the Design (Not Implementation Metrics)

1. A 500 MB upload from a slow client does not occupy a PHP-FPM worker for the transfer, and does not write the object to the app host's disk.
2. Killing the network during part N of a multipart upload, then retrying, does not re-upload parts 1..N-1.
3. A concurrent spike of large uploads does not produce `502`s on unrelated small requests via FPM pool exhaustion (the data plane is no longer in that pool).
4. An expired or leaked pre-signed URL cannot be used to write an object the issuer would not have authorized at issue time (object key, content-type, size range, expiry). Perfect protection against a leaked URL *during its lifetime* is not claimed; short expiry is the mitigation.
5. An object is not marked usable by the rest of the application until server-side verification has passed, and (if scanning is required) until scan status is clean or the product has explicitly accepted quarantine-visible.
6. Abandoned multipart uploads are cleaned up by a storage lifecycle rule without an engineer running a script.

## Business Rules (Upload-Scoped)

1. The HTTP handler on PHP-FPM issues authorization and verifies completion. It does not accept the file body.
2. Pre-signed URLs are short-lived (minutes, not hours). Long-lived URLs are a leak with a timer.
3. Size class selects the protocol: below the threshold, a single pre-signed PUT; above it, multipart. The threshold is a design parameter (see System Design), not a product feature.
4. The client may not choose the object key. The server mints the key at authorization time.
5. Completion is server-driven: the client reports "parts uploaded" (with ETags); the server calls `CompleteMultipartUpload` (or confirms the single PUT via `HeadObject`) and only then updates application state.
6. Quota, virus-scan, and "this user may upload this content-type" are decided at issue time and re-checked at complete time. They are not enforced per-byte on the data path, because the app is not on the data path.

## Non-Goals

- **Not a general media-processing pipeline.** No transcoding, no image variants, no CDN invalidation design. Those can subscribe to "object became usable." They are not this project.
- **Not a virus-scanning UX product.** Scanning is an explicit gap the redesign opens and an explicit Phase 4 close. The UX of "your file is in quarantine" is a product decision, not an architecture one, except that the object must not be treated as usable while quarantined.
- **Not a multi-cloud storage abstraction.** One object store (S3 or S3-compatible). A second vendor is a new signer, not a plugin framework designed up front.
- **Not an implementation.** No PHP, no JavaScript uploader, no Terraform. Numbered steps and diagrams only.
- **Not cross-session resume / tus.io / a custom chunked protocol.** Per-part retry within a live multipart session is in. "Close the laptop, open it tomorrow, continue" is a different product. Do not build it to make the architecture look complete. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- **Not a claim that this is cheap.** The honest alternative — raise the nginx and PHP limits, stream the body, pray the FPM pool is large enough — is cheaper to ship and will work until files get large enough or concurrent enough. This design is justified when that until has already arrived, or is about to. It is overkill for an avatar-photo uploader whose maximum is 5 MB. That distinction is load-bearing; see [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
