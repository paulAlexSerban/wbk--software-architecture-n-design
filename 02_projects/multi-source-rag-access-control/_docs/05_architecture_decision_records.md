# Architecture Decision Records

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Group-Fanout Pre-Filter over Per-User ACL Lists on Chunks

**Status**: Accepted

**Context**: Query-time authorization needs a predicate the search engine can apply. The obvious denormalization is `acl_user_ids` containing every principal who can read the resource. That matches how people talk ("does Alice have access?") and matches Drive's share-to-person UI. It fails at the two scales that actually appear: (1) company-wide documents would carry thousands of user IDs and would need a metadata rewrite on every join/leave; (2) filtered ANN / inverted-index filters with huge arrays and huge `OR` lists are a known recall/latency cliff. Meanwhile a typical employee is in tens to low hundreds of IdP groups. Share-to-person still exists and must work.

**Decision**: Index-time ACL denormalizes **group IDs** as the default atom, plus a **small** `acl_user_ids` list only for explicit user grants. Query time intersects the caller's **materialized group set** with `acl_group_ids`, or matches `principal_id` on `acl_user_ids`. Nested IdP groups are expanded in the identity resolver, not stored as nested structures on the chunk. Public/org-wide access is an explicit group (`all_employees`), never an empty list.

**Consequences**:
- (+) Join/leave of `all_employees` is one group membership change, not a corpus rewrite.
- (+) Filter cardinality tracks **the user**, which is bounded ([System Design §1.3](./03_system_design.md#13-nested-group-expansion)).
- (+) Share-to-person still works without inventing a 1:1 group per file.
- (–) Group expansion correctness **is** the security of group-based docs. Nested depth caps can false-deny. Directory hygiene (duplicate groups, cycles) becomes our problem.
- (–) Unmapped source groups fail closed (pending resource) — quality holes until directory mapping is complete.
- **Alternative rejected**: flatten to user IDs at index time. Write amplification and filter cardinality.
- **Alternative rejected**: store only resource IDs on chunks and join ACL at query time against Postgres for every candidate. That *is* post-filter with extra latency unless you pre-filter candidates somehow; at k=50 it is the live-check trap's cousin. A hybrid "search then join" without a search-side predicate reintroduces unauthorized candidates into the engine.
- **Revisit trigger**: a retrieval engine that cannot overlap-filter ~512 group IDs inside SLO. Then consider **lossy-forbidden** compaction only of *identical* groups, or source partitions — not per-user flattening.

## ADR-002: Pre-Filter as the Control; Post-Filter as Assertion; Source Partitions as Coarse Fences

**Status**: Accepted

**Context**: The scenario's architecture angle is where the check lives. UI-only is indefensible for RAG (the model already read the text). Post-filter is the demo default and has a documented leakage profile (existence, k-occupancy, rerank/logs, single-gate bugs). Live vendor checks blow p99 and fail open under 429s. Source-scoped indices cannot express share-to-person.

**Decision**:
1. **Primary control:** metadata pre-filter inside **both** BM25 and ANN, on every retrieve including hydrate-by-id and agent hops.
2. **Defense in depth:** assertion post-filter that must drop **zero** hits; any drop is sev-1.
3. **Coarse fences:** optional physical partitions (HR not mounted; Slack private vs public) that **still** carry membership/group filters.
4. **Not v1 primary:** live Slack/Drive/Notion ACL GETs on the query path.

**Consequences**:
- (+) Unauthorized text should never enter rerank, prompt, or result cache.
- (+) Assertion makes pre-filter bugs visible instead of silent.
- (–) Stale metadata is now the residual stale-allow window. We pay for ACL sync and a signed SLO instead of pretending we are strongly consistent with Slack.
- (–) Filtered-ANN recall is a quality work item. Forbidden "fix": unfiltered k.
- **Alternative rejected:** post-filter only. Cheapest. Leakiest.
- **Alternative rejected:** one index per team. Does not model real sharing; operational explosion.
- **Revisit trigger:** a legally mandated "check source of truth on every read" for a tiny corpus. Then step-up live checks on that class **fail closed**, not as a global pattern.

## ADR-003: Normalized ACL Model with Per-Source Connectors

**Status**: Accepted

**Context**: Drive, Slack, Notion, and Postgres do not share an ACL language. Embedding each vendor's JSON onto chunks ("slack-shaped metadata here, drive-shaped there") forces the query path to be a switch statement that *will* miss a case. Reimplementing each source's permission evaluator at query time is four live-check APIs.

**Decision**: Connectors translate native permissions into **effective** `(resource, principal_type, principal_id, read)` grants in a shared store, then denormalize onto chunks. The query path speaks only the normalized predicate. SQL is the exception: it does **not** use this grant table for rows ([ADR-004](#adr-004)).

**Consequences**:
- (+) One retrieval filter. New sources add a connector, not a query-path fork.
- (+) Effective-ACL recompute on folder share is explicit and testable.
- (–) Translation bugs are security bugs. Each connector is a product. Slack Connect, Notion guests, Drive "anyone with the link" will be wrong in v0 of the mapper — fail closed on unmapped.
- (–) We are **not** the system of record. Drift vs native UI is inevitable; reconcile jobs exist because of this ADR.
- **Alternative rejected:** query-time adapter per source. Does not scale with k, SLO, or vendor 429s.
- **Alternative rejected:** "exports are already filtered by who ran the export." The exporter is usually an admin. That is god-mode ingest.

## ADR-004: SQL Authorized by RLS / Session Identity, Not by Prompt Constraints

**Status**: Accepted

**Context**: Text-to-SQL is the second retrieval path. A shared app role with `SELECT` on the schema plus a system prompt "filter to the current user" is prompt-injection bait and a confused deputy. Application-layer row filters duplicated from business logic will drift from what the tickets UI actually enforces.

**Decision**: Generated or canned SQL executes in a read-only sandbox **as the caller**: RLS policies and/or GRANTs the DBA already (or will) maintain. The executor role cannot `BYPASSRLS`. If RLS/views are not ready for a schema, that schema is **not** on the assistant. Prompt text is not an ACL. Allowlists, timeouts, and row caps are blast-radius controls, not substitutes for RLS.

**Consequences**:
- (+) The database remains the row-level system of record. Correctness tracks the product, not a second Python implementation.
- (+) Malicious `SELECT salary FROM employees` returns what RLS allows — ideally nothing.
- (–) Many companies **do not have RLS** on the tables an assistant would want. Then v1 SQL is curated views only, or SQL is delayed. This ADR will stall the SQL phase honestly rather than ship a superuser tool.
- (–) Connection pooling with leftover session variables is a cross-user leak. Transaction-scoped pooling is mandatory. [System Design §6](./03_system_design.md#6-sql-execution-path).
- **Alternative rejected:** "the LLM will add the right WHERE." Not a control.
- **Alternative rejected:** reimplement ticket-assignment rules in the retriever for SQL *and* ignore Postgres. Duplicate and diverge.

## ADR-005: Authorization Context Is Part of Every Result-Cache Key

**Status**: Accepted

**Context**: Exact-match and semantic caches are the usual RAG cost win. A cache keyed on the question (or its embedding) will serve a privileged user's answer to anyone who asks something close. That is a cross-privilege read with excellent latency.

**Decision**: Retrieval-hit caches and final-answer caches include `acl_context_hash` (hash of principal's group set, principal id, deny epoch, group-set version). Deny-list is checked **before** cache lookup. Semantic cache is **default off**; if enabled later, it still requires the same hash (and still has the "close ≠ same" correctness problem). v1 does **not** reuse cache entries across unequal group sets even when one is a subset.

**Consequences**:
- (+) Cache cannot privilege-escalate by construction of the key (bugs in hash computation aside — tested).
- (+) Users with identical group sets share hits (intentional).
- (–) Hit rate is lower than a global FAQ cache. Cost win is smaller. Accept it.
- (–) Subset reuse would recover some hits and is a future foot-gun; forbidden until a proof that all cited chunks are authorized for the requester exists *and* is simpler than just missing. Not v1.
- **Alternative rejected:** global answer cache "because it's internal." Internal is not one ACL.
- **Alternative rejected:** cache chunks by ID globally then filter on read — that is post-filter of a cache full of unauthorized text sitting in Redis, which is a datastore leak to anyone who can dump Redis.

## ADR-006: Bounded Revocation SLO plus Hot Deny-List; Not Live Vendor Checks

**Status**: Accepted

**Context**: Security will ask "when I remove someone from the channel, when does search stop?" Zero lag is only possible with live checks or with not indexing. Live checks fail [ADR-002](#adr-002). Operators will still need a faster path for **firing people** than for "left a project channel."

**Decision**: Two numbers, signed in Phase 0 (working assumptions if unsigned: **offboarding deny-list p99 ≤ 5 minutes**; **ordinary unshare/group-leave p99 ≤ 15 minutes**). Deny-list is consulted first and bypasses group cache. Ordinary changes ride SCIM/webhooks + cache TTL + ACL patch workers + nightly reconcile. Past-SLO sources are **omitted** (fail closed on the leg), not searched with maybe-stale allows.

**Consequences**:
- (+) A written number security can accept or reject. Rejecting 15 minutes means funding webhooks/reconcile/staff, not a code comment "real-time."
- (+) Fired-user path does not wait for a Drive re-crawl.
- (–) A 14-minute stale allow after unshare is **in policy** if 15 minutes was signed. Do not market "real-time ACL."
- (–) Nightly reconcile is load-bearing. Skipping it to "save API quota" extends the worst-case hole to 24 hours.
- **Alternative rejected:** live ACL GET per hit.
- **Alternative rejected:** "eventual consistency, no number." Not acceptable for this threat model.

## ADR-007: Consume the Tier 1.1 Retrieval Service; Do Not Fork the Funnel

**Status**: Accepted

**Context**: Hybrid BM25 + vector, RRF, rerank, chunk versioning, and index generations are a full project ([prj--rag-pipeline-at-scale](../../prj--rag-pipeline-at-scale/README.md), roadmap `retrieval-x`). Rebuilding them here would hide the actual hard problem (ACL federation) behind another ANN bake-off. This corpus is not 50M documents; RAM is not the scarce resource.

**Decision**: retrieval-x (or its documented equivalent) is the unstructured search backend. This system supplies **filterable ACL metadata**, **source partitions**, **identity**, **SQL sandbox**, **federation orchestration**, and **fail-closed policy**. The retrieval API contract **requires** filter application on all legs; a backend that cannot filter both sparse and dense indexes is the wrong backend.

**Consequences**:
- (+) Scope stays on authorization and connectors.
- (+) Quality work (chunking, rerank N) stays in the retrieval project.
- (–) We inherit retrieval-x's filter bugs. Contract tests must live **here** because the security property is ours.
- (–) If retrieval-x is still a naive pgvector demo without metadata filters, this project is blocked on that gap — honestly, in Phase 0.
- **Alternative rejected:** new vector DB "with enterprise ACL." Buying a product is [Trade-offs §4](./06_tradeoffs_and_honest_assessment.md#4-build-vs-buy); building a second funnel is not.

## ADR-008: Fail Closed on Unknown, Pending, or Stale ACL

**Status**: Accepted

**Context**: Every sync system has gaps: unmapped groups, webhooks missed, crawler errors, "we'll index content first and ACL later." The operational pressure during an outage is to keep answering. Fail-open on ACL is indistinguishable from no ACL.

**Decision**: Content without complete mapped ACL is not in the live index. Empty ACL arrays are not public. Identity/ACL-store failures yield 503 or omitted legs, not unfiltered search. Source lag beyond SLO omits the source. Product emptiness and degraded flags are the accepted failure mode.

**Consequences**:
- (+) The default incident is "assistant knows less," not "assistant leaked a private channel."
- (–) Availability SLO and security SLO **conflict** under connector outage. Security wins this ADR. Product must agree in Phase 0 or the on-call will ship a override flag that is a leak.
- (–) Over-filtering will be reported as "RAG quality is bad." Metrics must split `acl_omitted` from `retrieval_miss`.
- **Alternative rejected:** fail-open with a banner "ACL unavailable." Banners are not read. The model still answers.
- **Alternative rejected:** index now, ACL later. The race is fail-open.

## ADR-009: v1 Corpus Excludes DMs, Internet-Link Docs, and HR/Comp by Default

**Status**: Accepted

**Context**: Slack DMs and "anyone with the link" files are where employment-law and accidental-exposure live. HR/compensation is high-impact even with perfect ACL (authorized users exfiltrate via chat; vendor sees context). Including them to "make the demo impressive" is how the project dies in legal review after launch.

**Decision**: v1 does **not** index Slack DMs, internet-public links, or labeled HR/comp sources. Private channels are in scope **only** with membership sync. Domain-wide "anyone in org" maps to `all_employees` only when that is actually the native semantic. Exceptions require a written product+legal exception, not a connector flag flipped in staging.

**Consequences**:
- (+) Blast radius of the first ACL bug is not the CEO's DM inbox.
- (–) Users will ask why the assistant "doesn't see Slack." Document the exclusion. Expanding into DMs is a new ADR, not a config.
- **Alternative rejected:** index everything the bot token can see, filter later. That is the current-state trap.
