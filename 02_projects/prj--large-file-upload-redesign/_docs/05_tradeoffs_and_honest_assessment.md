# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone writes an uploader.

The expected answer is three words: **S3 pre-signed URLs**. Those three words are correct. They are not free. Passing large files through nginx and PHP-FPM is the anti-pattern; listing `client_max_body_size` and `upload_max_filesize` is diagnosis, not design. This page is the cost of the design.

## 1. What I would build

A **control plane** on the existing PHP-FPM app, and a **browser uploader** that talks to object storage.

- **Authorize endpoint**: authn, quota, content-type, mint the key, open a session, pick single PUT vs multipart from declared size.
- **Pre-signed URLs**: minutes of TTL; batch `sign-parts` for multipart so a long upload does not require a long-lived capability.
- **Complete + HeadObject**: the client is a trigger; storage is the truth. Mismatch rejects. [ADR-003](./04_architecture_decision_records.md#adr-003).
- **Lifecycle abort** of incomplete MPUs, plus a boring janitor for session rows.
- **Async scan with quarantine** if bytes used to be inspectable — or if we are about to invite large binaries we never scanned. [ADR-004](./04_architecture_decision_records.md#adr-004).
- **CORS on the bucket** treated as a launch gate, not a ticket for later.

I would not raise nginx/PHP limits as the fix. I would read them in Phase 0 so I know what is failing *today*, then stop treating them as architecture.

If Phase 0 shows the failures are *only* `413` on a 1 MB `client_max_body_size` and the product maximum is 4 MB avatars, this whole system is overkill. Raise the limit, stream, ship. The three-word answer is for when the product actually needs large files, or when concurrency of medium files is already killing the FPM pool. Be honest about which incident you are in.

## 2. What I would give up

Be explicit. These are not "later." They are not in v1, and some of them are never in this design.

**The simplicity of `<input type="file">` plus a form POST.** That UX and that server handler go away. The replacement is a JavaScript uploader with chunking, retries, progress, and a complete call. Most of the project is that client. Teams that budget only the PHP work will ship a server that issues URLs nobody can use correctly.

**Synchronous inspection of bytes in the application.** Virus scan, EXIF strip, "reject if it isn't really a PNG," all of that is either async after landing in the bucket or gone. Pretending PHP still sees the file is how you reintroduce the proxy.

**A single status: "uploaded."** There is now `pending`, `verified`, `pending_scan`, `usable`, `rejected`. If product copy still says "your file is ready" at PUT-200, you will lie during scan lag.

**Origin logs that explain transfer failures.** PHP error logs will be quiet while users fail on CORS, last-mile, or expired URLs. Without client telemetry and storage access logs, "only some people" comes back and you cannot see it.

**Perfect prevention of a leaked URL during its TTL.** Anyone holding the URL can PUT until it expires. Short TTL, unguessable keys, HTTPS, do not log the URL. That is the mitigation. Revocation of a issued URL is not a real S3 feature in the sense people want (you wait for expiry or you rotate signing keys — the latter is a nuclear option).

**Hard, on-the-wire max-size enforcement for every pre-signed PUT.** POST policies can constrain `content-length-range`. PUT signatures are weaker here. We verify after the fact and delete. A hostile client can waste bandwidth in the TTL window. Accepted.

**Cross-session resume.** Close the tab, come back tomorrow, continue. Not v1. Per-part retry in a live session is the reliability we actually need for the reported incident. tus.io on our servers is how we accidentally stay in the data path.

**A custom chunked protocol, a storage abstraction layer, a second cloud.** One bucket, S3 multipart as the protocol. Inventing "our own chunks" is résumé-driven development and a second incomplete-upload sweeper.

**The fantasy that last-mile failure goes to zero.** Slow VPNs, trains, and backgrounded mobile tabs will still fail parts. The design makes that *retry a part* instead of *look like an origin outage*. Support must be told the difference or they will ask you to "put it back through the server so we can see it."

**Cheapness, if the old path was a form and a `move_uploaded_file`.** This is more moving parts. Pay it when large/concurrent uploads are a real requirement. Do not pay it for 2 MB profile photos because an interview question said "pre-signed URLs."

## 3. What I would ask for, even though I expect friction

Ask **once, in writing, in Phase 0**, in parallel with the log diagnosis. Silence must not block the diagnosis.

Ask security / compliance:

1. **Must objects be scanned before they are readable by other users?** If yes, Phase 4 is on the critical path to removing the old route (if the old route scanned) or to calling the new path "done" (if we are newly exposing a bucket to arbitrary uploads). Expected: "yes" from security, "do we have to" from product. Make them both sign the same sentence.
2. **Is a browser writing to the bucket acceptable**, given CORS and a locked-down prefix? Expected: yes with a bucket policy review. If no, the alternative is a dedicated streaming proxy, not PHP-FPM.

Ask product:

3. **What is the actual max file size, and the p50/p95 of current successful uploads?** If max is 5 MB, stop this project after Phase 0. If max is "video, 2 GB," T=64 MB and multipart are justified.
4. **Is "uploaded but not yet available" an acceptable UX** for scan time? If no, they are asking for synchronous scan, which is either fail-closed delay or the old proxy. Make them pick.
5. **Do we need resume after closing the tab?** Expected: "nice to have." Do not build it. If they say it is a must, that is a new ADR and a bigger client.

Ask ops / platform:

6. **Bucket CORS ownership, lifecycle rules, storage access logs, IAM prefix isolation.** Expected: "the app team does it" or "open a ticket." The ticket latency is a Phase 1 risk.
7. **Whether the load balancer idle timeout is 60s** and whether anyone will raise it "instead of" this project. Raising it is a patch for one failure mode and a gift to hanging connections. Note it; do not make it the strategy.

What I would **not** ask for: a new language, Kubernetes, a media microservice, a multi-cloud storage SDK. Those asks spend calendar time that belongs to the uploader and CORS.

## 4. Complexity inventory (what those three words cost)

| You take on | You shed |
| --- | --- |
| JS uploader: parts, retry, progress, complete, re-sign | PHP holding the file, `$_FILES`, temp disk |
| `upload_session` + janitor | Request-lifecycle-as-state |
| CORS, `ETag` expose headers, clock skew | nginx body buffering for uploads |
| Capability-URL hygiene (TTL, no logs) | Long-lived worker occupancy per byte |
| HeadObject verification | Trusting that a 200 from PHP meant S3 succeeded |
| Incomplete MPU lifecycle | Double transfer (ingress + app egress) |
| Async scan + quarantine UX, if required | Synchronous scan *on the app host* (if you even had it) |
| Two protocols (single PUT vs multipart) | One form POST that lied about working |

Net: **more parts, in the right places.** The old design was simple *and wrong at the sizes you care about.* The new design is the standard one, and the standard one is still a few weeks of client work plus a week of IAM/CORS/lifecycle, not an afternoon of php.ini.

### What is not worth building

- Resumable-upload product polish beyond per-part retry, unless product asked in writing.
- A custom chunked protocol instead of S3 multipart.
- A storage-vendor abstraction "in case we leave AWS." You will not leave in this project's lifetime. The second vendor is a new signer.
- Downloading the object back into PHP to scan it.
- Parallel PHP workers to "speed up" the old proxy. That is more disks filling faster.

## 5. When I would not do this

- Product max file size is small (single-digit MB) and logs show `413` / `UPLOAD_ERR_INI_SIZE`. **Tune the knobs, stream the body, ship.** Pre-signed URLs are a flex.
- There are no large-file tickets and the FPM pool is not saturating on uploads. Do not pre-pay this complexity.
- Compliance forbids browser-to-bucket and will not move. Then PHP-FPM is still the wrong proxy; budget a real streaming service. Do not "raise timeouts" and call it architecture.

When I **would** do this: the tickets are already here (large, intermittent, some people), or product is about to invite video/design files, or you have measured FPM exhaustion / temp-disk fill correlated with upload concurrency. Then the three words are the design, and this document is the bill.

## 6. Brutal summary

The clever design is not a bigger `client_max_body_size`. The clever design is **refusing to put the file on the PHP-FPM request at all**, checking logs first so you know which layer is actually on fire, and paying for a real uploader, short-lived URLs, verification, and (if you need it) a scanner.

"S3 pre-signed URLs" is the right three words. The fourth through four-hundredth words are CORS, multipart, HeadObject, lifecycle, quarantine, and a client that retries part 7 without restarting parts 1–6.

If the files are small, do not build this. If the files are large, do not pretend php.ini is a strategy. Either way, Phase 0 is the logs — status code and duration — before anyone opens the AWS console to mint a URL.
