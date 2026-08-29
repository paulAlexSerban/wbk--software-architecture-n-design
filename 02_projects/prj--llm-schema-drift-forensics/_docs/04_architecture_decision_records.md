# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Schema Fingerprint over Raw Payload Diff

**Status**: Accepted

**Context**: The obvious first move is "diff last week's responses against this week's." LLM payloads are *supposed* to differ on every call. A raw diff reports that everything changed, which is true and useless. The incident is about JSON **keys** (and types, nesting), not about generated text. A second obvious move is to diff against a JSON Schema file in the repo; that answers "does current traffic match what we wrote down," which is Phase 0 / monitor work, and does not date a historical change unless the historical bodies are also checked against that schema — which is fingerprinting with extra steps.

**Decision**: The comparable unit is a **schema fingerprint**: canonical hash of `(path, type)` pairs extracted from a body, plus a **presence-rate vector** against a baseline path universe so optional keys do not look like a new schema every request. Envelope (HTTP API wrapper) and inner payload (parsed model JSON / tool arguments) are fingerprinted as separate layers. Values are discarded. See [System Design §2](./03_system_design.md#2-schema-fingerprint).

**Consequences**:
- (+) Makes "what changed" a set-diff of paths and types, which is the question that was asked.
- (+) Lets a timeseries exist at all: a small number of hashes instead of a snowflake per response.
- (–) Blind to semantic/format changes that keep the same keys (`url` string that used to be `https://…` and is now an opaque id). That is a different detector; claiming schema forensics will catch it is a lie. Call it out in the report if the rumor was actually a format change.
- (–) Optional-key churn must be handled with presence rates or the fingerprint timeseries is garbage. Extra moving parts; necessary ones.
- **Alternative rejected**: embedding-similarity of payloads, or "ask an LLM to summarize the schema change." The first compares answers. The second is circular, expensive, and un-auditable when it invents a rename.
- **Revisit trigger**: you are not parsing JSON (free-text only). This ADR's object disappears; this project is the wrong project.

## ADR-002: Histogram by Default; Bisection Only After a Monotonicity Check

**Status**: Accepted

**Context**: Binary search through an ordered replay log is the clean interview answer and is O(log n) when fingerprinting a cold body is expensive. It assumes a predicate that flips once: old schema, then new schema, no overlap. Vendor rollouts are often canaries, regional, alias-specific, or account-flagged. In those regimes both schemas coexist, the predicate is not monotonic, and bisection returns a T that is an artifact of which mid-points were sampled.

**Decision**: Always compute a **coarse histogram** of fingerprint families (and presence rates) first. Run an **overlap check**. If a clean step is shown — family A then family B, overlap no larger than clock-skew / in-flight noise — bisection (or a linear scan of already-materialized fingerprints) may locate the boundary. If overlap is real, **bisection is forbidden**; the output is the histogram, possibly sliced by metadata, possibly a multi-day mixed window. That window is the answer. [System Design §3](./03_system_design.md#3-timeline-reconstruction-bisection-and-its-kill-switch).

**Consequences**:
- (+) Prevents a confident wrong timestamp, which is worse than a wide window.
- (+) Still uses bisection where it is valid and where cold storage makes it worth it.
- (–) The write-up is less pretty than "we binary-searched and found Tuesday 14:03." Good. Pretty was the trap.
- (–) Overlap check has judgment (noise floor, skew margin). Record the parameters in the report so they can be argued with.
- **Alternative rejected**: always bisect; "we'll notice if it's wrong." You will not notice. The algorithm always returns a T.
- **Alternative rejected**: always full-scan only, never bisect. Fine when fingerprints are already in a table. Keep bisection for the S3-replay case; do not make a religion of either.

## ADR-003: Tolerate Extra Keys; Enforce Required Keys

**Status**: Accepted

**Context**: Vendors add fields. That is how APIs evolve when they are being polite. A validator that fails closed on any extra key will page on every additive, non-breaking change and train the team to ignore the monitor. A validator that ignores missing keys will miss the actual incident (renamed or dropped required fields). "Slightly different JSON keys" in the prompt is usually a required-key miss from *your* parser's point of view, plus maybe extras.

**Decision**: The contract the monitor and ingest validator enforce is a **required `(path, type)` set** owned by the product. Extra keys are allowed and optionally metric'd (warn, do not page). Missing required keys or type changes page (and, per surface, may drop the response from downstream use). Last-known-good updates only by explicit human accept. Fuzzy mapping of new names onto old names is **not** done on the hot path; that is a reviewed parser patch.

**Consequences**:
- (+) Additive vendor changes do not become incidents.
- (+) The actual breakage class pages.
- (–) A "required" list that is stale (you still require `summary` after you patched to `brief`) will keep paging. Updating the contract is part of accepting the change.
- (–) Fail-closed vs fail-open on required miss is a product config, not an architecture global. Default fail-open-with-alert so a monitor bug does not take down chat. Safety-grade surfaces may fail closed.
- **Alternative rejected**: strict JSON Schema equality (no additional properties). Correct for internal RPCs; wrong for an LLM vendor you do not control.

## ADR-004: Fingerprint-First Retention; Sampled Bodies as a Budgeted Exception

**Status**: Accepted

**Context**: Next week's incident is dated in minutes if you retained bodies. Bodies are PII, customer content, storage, and a legal fight. Teams that "just log everything" either get shut down by security or quietly drop bodies after 3 days — which is how *this* incident became a week-later mystery. The forensic primitive is the fingerprint plus timestamp plus model metadata, not the prose.

**Decision**: Default retain **fingerprint ledger rows** (and probe bodies, which can be synthetic/non-PII) for a forensic horizon (starting point: 90 days). Live user bodies: sample, under existing PII policy, at a rate that makes a week-later histogram meaningful (even 0.1% at moderate QPS), or do not retain them at all if policy forbids. Do not build a prompt warehouse in the name of schema monitoring. Do emit cheap **required-key miss logs** on the live path (path name, model, request id, timestamp) — those are rung-3 gold and are not full bodies.

**Consequences**:
- (+) Next incident has a timeseries even when legal forbids body dumps.
- (+) Storage and privacy surface stay small.
- (–) Fingerprints do not recover values for a structural example; probe bodies cover "what does the new shape look like" for synthetic prompts, which may not exercise every optional path user traffic would.
- (–) If legal sets retention to 48 hours, the business has pre-accepted that a week-later "when" is unanswerable. That is a recorded product/legal decision, not an engineering miss.
- **Alternative rejected**: full body capture "just for a month." Will not survive contact with security, and is unnecessary if fingerprints + required-miss logs exist.

## ADR-005: Pin Model Snapshots Where Offered; Treat Floating Aliases as Named Risk

**Status**: Accepted

**Context**: `"gpt-4o"`, `"latest"`, `"claude-3-5-sonnet"` are product names, not schema versions. Providers move them. A silent key change a week ago is often a silent alias move. Some vendors offer snapshot ids, `system_fingerprint`, or dated model names. Many teams do not pin because pinning feels like missing quality improvements.

**Decision**: Production traffic that is parsed as JSON **pins** the most specific version the vendor offers (snapshot id / dated name). Floating aliases, if still used (e.g. a deliberate quality-chasing playground), are a **named exception** with their own golden probes and no expectation of schema stability. The forensic correlator treats a `system_fingerprint` or snapshot flip coincident with the schema step as the primary trigger hypothesis.

**Consequences**:
- (+) Turns a class of silent changes into a deliberate version bump you control.
- (–) You lag vendor quality improvements until you choose to move, at which point you run probes against the new pin *before* flipping production. That is a release process, not an outage.
- (–) Some vendors do not offer pins. Then this ADR is "we asked; we cannot." Probes and ingest validation remain the defense. Do not invent a pin the API does not have.
- **Alternative rejected**: stay on `"latest"` and "just monitor." Monitor is necessary anyway; pinning reduces how often it has to fire for the worst reason.

## ADR-006: Golden Probes Are Production Spend, Few and Fixed

**Status**: Accepted

**Context**: Continuous evaluation products will try to become this monitor: thousands of prompts, nightly eval grids, LLM-as-judge. That is a different program with a different bill. Schema drift of **keys you parse** is a small, cheap, boring signal. Overbuilding the probe set delays it and burns the token budget that was supposed to be for the product.

**Decision**: One (or a handful of) **canonical prompt(s)** per distinct parsed contract, on a 15–60 minute cadence, cache-bypassing, attributed to a dedicated key if possible. Probes do not replace ingest validation; they catch envelope/payload changes even when live traffic is sparse (nights, weekends, a feature flag off). They are not a quality eval suite.

**Consequences**:
- (+) Same-day detection at a token cost a spreadsheet can predict.
- (+) Synthetic prompts keep probe-body retention out of the PII fight.
- (–) A schema change that only appears on a rare user prompt shape may be missed by probes and still caught by ingest validation (required keys) or live fingerprint sampling. That is acceptable; it is why ingest validation exists.
- **Alternative rejected**: replay sampled user prompts as probes. Quality-eval useful; privacy and cache semantics make it a worse *schema* probe.

## ADR-007: Parser Patch Is Not Gated on Forensic Completion

**Status**: Accepted

**Context**: The investigation is interesting. Users are broken now. Current responses already show the new keys. Waiting for a timestamp before accepting `brief` as well as `summary` is how a postmortem becomes the outage.

**Decision**: Phase 0 — tolerant parse of the new shape, using **current** traffic and the parser's required-field list — ships independently of Phases 1–3. Forensics may inform whether to treat the change as rename vs dual-support vs revert-a-prompt, but dual-support of old and new keys is the safe patch when current bodies show both or only the new. The forensic report is a postmortem artifact, not a release blocker.

**Consequences**:
- (+) Blast radius stops growing while someone bisects S3.
- (–) You may dual-support a key you later learn was a one-hour canary. Cheap compared to staying broken. You can remove the old key after the report.
- **Alternative rejected**: freeze production until "when" is known. The prompt asked for investigative reasoning, not for hostage-taking.
