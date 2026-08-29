# Multi-Source RAG with Access Control — System Design
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Mechanical "how" for identity resolution, the normalized ACL model, index-time denormalization, group-fanout pre-filter, federation/RRF, cache keys, and RLS-backed SQL. *What/why* lives in [Architecture](./02_architecture_document.md). Leakage analysis lives in [Security](./04_security_and_access_control.md). Locked decisions live in [ADRs](./05_architecture_decision_records.md).

This is not a second copy of the hybrid retrieval funnel. Candidate generation, BM25, ANN, and rerank **mechanics** are owned by the Tier 1.1 backend. This document specifies the **filter contract**, the **ACL data path**, and the **SQL execution path**.

## 1. Identity and group resolution

### 1.1 Inputs

- Verified OIDC token: `sub`, email, issuer. Gateway validates signature, audience, expiry.
- Optional: `act` / impersonation **is not v1**. Break-glass is a separate audited service identity, not a header.

### 1.2 Output contract

```
ResolvedIdentity:
  principal_id: string          # stable internal ID, not raw email as PK
  idp_sub: string
  group_ids: string[]           # materialized, bounded, sorted
  denied: bool                  # hot deny-list (offboarding)
  acl_context_hash: string      # hash(principal_id + sorted group_ids + deny-list epoch)
  resolved_at: timestamp
  group_set_version: int        # IdP snapshot generation
```

`denied: true` → gateway returns 403 or empty retrieval **without** calling search. Do not "search and filter" a denied principal.

### 1.3 Nested group expansion

IdP groups are a directed graph. Materialize with:

- Max depth **D** (working assumption: 8). Deeper edges are ignored and **metered** (`group_depth_truncated`). Truncation is fail-closed for *those* nested grants: a user who only gained access via depth 9 does not match. Better than unbounded walks; worse than perfect AD fidelity. Phase 0 measures real depth.
- Cycle detection (visited set). Cycles in AD are real.
- Cap on `|group_ids|` after expansion (working assumption: 512). Overflow: **do not silently drop random groups**. Fail the resolution (user gets an error, security gets a ticket). Silent drop is random false-deny that looks like flaky search. If a principal legitimately has >512 groups, that is a directory hygiene incident; do not paper over it in the retriever.

Expansion is computed on SCIM/IdP events and cached in Postgres (`principal_groups`). Query path reads cache. TTL is **not** the only invalidation: membership webhooks/SCIM must delete/recompute. TTL is a **backstop** (e.g. 10 minutes) so a missed webhook still converges inside the revocation SLO.

### 1.4 `acl_context_hash`

```
acl_context_hash = SHA-256(
  principal_id || "\n" ||
  join(",", sorted(group_ids)) || "\n" ||
  deny_epoch || "\n" ||
  group_set_version
)
```

This is the cache-key atom. Two users with identical group sets **share** cache entries. That is intended: it is not a leak if the authorization context is the same. Two users with overlapping-but-unequal sets **do not** share. v1 does not implement subset-cache reuse ("B's groups ⊂ A's, serve A's answer if we prove all cited chunks ⊂ B"). That proof is how you ship a subtle leak. [ADR-005](./05_architecture_decision_records.md#adr-005).

## 2. ACL model and index-time denormalization

### 2.1 Normalized grant tuple

Postgres tables (logical schema, not DDL):

**`resource`**

| Column | Meaning |
| --- | --- |
| `resource_id` | Internal ID |
| `source` | `docs` \| `slack` \| `notion` \| … |
| `source_native_id` | File ID / channel+ts / page ID |
| `parent_id` | For inheritance (folder, page tree) |
| `acl_generation` | Monotonic per resource |
| `acl_fresh_until` | Watermark-derived; query path may consult store for step-up, not per-chunk on p99 |
| `deleted` | Tombstone |

**`acl_grant`**

| Column | Meaning |
| --- | --- |
| `resource_id` | |
| `principal_type` | `group` \| `user` |
| `principal_id` | Group ID or user ID in **our** namespace |
| `perm` | `read` (v1 only; write/share ignored for retrieval) |
| `grant_source` | `explicit` \| `inherited` \| `workspace_default` |

**`source_sync_state`**

| Column | Meaning |
| --- | --- |
| `source` | |
| `cursor` / `watermark_ts` | |
| `last_success_at` | |
| `lag_s` | |
| `status` | `ok` \| `degraded` \| `failed` |

v1 permission is **read or not**. Edit/comment/share are irrelevant to RAG.

### 2.2 Per-source mapping (the actual work)

**Docs (Drive / Confluence-class)**

- Native: user shares, group shares, domain-link (`anyone in org`), public-link, folder inheritance, broken inheritance.
- Map:
  - domain-link `"anyone in org"` → group `all_employees` (only if that is **actually** the org, not "anyone with the link on the internet").
  - public internet link → **do not index** unless product explicitly opts in (default **out**).
  - folder ACL → inherit onto children unless broken.
  - named user → `principal_type=user`.
  - Google group / Entra group → map to our `group_id` via directory sync; **unmapped group is fail-closed** (resource not searchable until mapped).

**Slack**

- Public channel → group `slack_public_<workspace>` or membership list if the workspace is not "everyone."
- Private channel → group `slack_channel_<id>` whose members are synced from conversations.members.
- Slack Connect / multi-workspace: treat as a **different trust domain**; v1 default **exclude** unless mapped.
- Guest users: their `group_ids` must not include `all_employees` by accident.
- DMs: **not indexed in v1**.

**Notion**

- Workspace role (owner/member/guest) + page-level share + database inheritance.
- Guests with access to one page must not inherit workspace-wide `notion_members`.
- Map page tree inheritance; a child with restricted permissions **replaces** parent grants (Notion's actual semantics must be checked in Phase 0 against the API — do not assume Drive-like inheritance).

**SQL**

- **No** `acl_grant` rows per tuple. Catalog crawler may record which **tables/views** are assistant-visible (`sql_relation_allowlist`). Row/column ACL is Postgres RLS + GRANTs at execution time.

### 2.3 Denormalization onto chunks

Each chunk document in retrieval-x carries:

```
chunk_id
resource_id
source
acl_generation
acl_group_ids: string[]     # denormalized from grants where type=group
acl_user_ids: string[]      # only share-to-person; expected small
acl_state: "complete" | "pending" | "tombstone"
text
... retrieval-x fields ...
```

Rules:

1. `acl_state != complete` → **not in the live alias**. Pending chunks do not match.
2. Empty `acl_group_ids` **and** empty `acl_user_ids` → **not searchable** (fail closed). "Empty means public" is how you leak. Public is an explicit group (`all_employees` or `public_indexed`).
3. Text-unchanged ACL patch: metadata upsert only; **do not** re-embed.
4. Resource delete: delete chunks from both indexes (retrieval-x delete contract). Tombstones until confirmed gone.
5. Chunker must **not** merge text from two resources. Cross-doc concatenation is an ACL union bug. Intra-doc: if a single file has internal restricted sections that the source ACL does not express (e.g. a PDF with a hidden attachment), **the source ACL is the only ACL we have** — we cannot invent page-level ACL the Drive API does not expose. Disclose this as a residual risk. [Security — residual](./04_security_and_access_control.md#residual-risk-accepted).

### 2.4 Inheritance computation

Connectors compute **effective ACL** at the resource leaf (file, message, page), then copy that effective set onto all chunks of that resource. Query path does **not** walk parent folders. Recompute effective ACL when any ancestor changes (folder share). That fan-out can be large (a root-folder ACL change). It is a **job**, with progress metrics, not a synchronous Drive webhook handler that times out.

## 3. Query-time pre-filter

### 3.1 Predicate

For unstructured retrieval-x calls:

```
acl_state = complete
AND source IN requested_sources
AND source_leg_fresh(source)     # gateway omits stale legs
AND (
      acl_group_ids OVERLAPS :user_group_ids
   OR acl_user_ids CONTAINS :principal_id
)
```

Both BM25 and ANN legs of retrieval-x **must** apply this filter. Filter on one backend only is a leak through the other. This is a contract test, not a comment. [ADR-002](./05_architecture_decision_records.md#adr-002).

### 3.2 Why this is not `acl_user_ids CONTAINS user` on every chunk

If every grant were flattened to users at index time:

- An `all_employees` doc would carry thousands of user IDs.
- Join/leave would rewrite **every** such chunk's metadata (write amplification = corpus).
- ANN/metadata indexes with huge arrays are a known pain.

Group IDs keep index-time cardinality small and move fan-out to the **user** (tens to hundreds of groups). That is the correct side of the join.

### 3.3 Filtered ANN behavior

Filtered HNSW (or equivalent) at awkward selectivity — "user is in a tiny private channel, query is generic" — can recall-miss even when a matching chunk exists. This is a **quality** problem, not a license to post-filter a wider unfiltered k.

Mitigations (quality, still pre-filtered):

- Keep BM25 in the path (membership-like IDs and channel names are lexical).
- Source partitions: private Slack is a smaller graph; filters are more selective *inside* a smaller set.
- Do **not** raise unfiltered k and drop. That reintroduces leakage into rerank/logs.

If Phase 0 shows catastrophic filtered-ANN recall, the fix is partition strategy or a post-filter **of a pre-filtered candidate pool that is still authorized** (e.g. pre-filter to all matching ACL, then lexical/semantic rank) — still never pulling unauthorized vectors into the process.

### 3.4 Group-set width

If p95 `|group_ids|` is 200, the overlap filter is 200-valued. Retrieval-x must be bench-tested at p95 and at the 512 cap. If the engine cannot, **group compaction**: map many IdP groups to fewer **ACL clusters** at sync time (lossy). Compaction errors are false-deny or false-allow; only **false-deny-oriented** compaction is allowed (merge groups that are semantically identical, not "close enough"). Do not cluster "similar" departments together.

## 4. Hybrid retrieval and fusion (federation)

Inside one source, retrieval-x already fuses BM25 + ANN (RRF). Across sources:

```
For each fresh source leg:
  hits_leg = retrieval_x.search(query, filter=acl_predicate AND source=leg, k=K_leg)
hits_sql = optional SQL tool (separate)
fused = RRF(hits_docs, hits_slack, hits_notion)   # k_rrf = 60 unless experiment
rerank = cross_encoder(fused[:N])                 # N bounded; input is authorized-only
hydrate text from chunk store
assemble context
```

`K_leg` is chosen so fusion has enough authorized candidates. Under-fill because the user has access to almost nothing is **correct**, not a bug to "fix" by widening into unauthorized space.

SQL hits are **not** RRF'd with cosine. They are a separate evidence block with a citation type `sql`. The context assembler budgets tokens for unstructured vs structured (e.g. cap SQL rows at 30).

Rerank runs **only** on fused authorized chunks. Trace/log payloads of rerank inputs are **sensitive** and inherit the same ACL as the chunks (rerank workers are in the trust boundary; their debug logs are a leak surface).

## 5. Caching

### 5.1 Keys

| Cache | Key includes | Notes |
| --- | --- | --- |
| Query embedding | `query_norm`, embed `model_generation` | No principal. Still do not log raw queries to a public bucket. |
| Retrieval hits | `query_norm`, `acl_context_hash`, `index_generation`, `K`, source-leg set | |
| Final answer | `query_norm`, `acl_context_hash`, `prompt_version`, `model`, `index_generation` | |
| Identity | `idp_sub` | Short TTL + event invalidation |

### 5.2 Invalidation

- `group_set_version` or deny-list change → new `acl_context_hash` → natural miss. Old entries expire by TTL (working assumption: 5–15 minutes, **≤ revocation SLO**).
- ACL patch on a resource does **not** compute all affected hashes. TTL + SLO is the hammer. For offboarding, deny-list makes identity resolve to `denied` even if a cache entry exists: **gateway must check deny-list before cache read**. Order: deny-list → cache → retrieve.

### 5.3 Semantic cache

Default **off**. If ever enabled: same `acl_context_hash` requirement, plus the usual "close vectors are not the same question" warning from the LLM gateway project. A semantic cache without ACL in the key is a **privilege-escalation primitive**. [ADR-005](./05_architecture_decision_records.md#adr-005).

## 6. SQL execution path

### 6.1 Binding the caller

Options (pick in Phase 0 against the actual Postgres):

1. **One DB role per employee** — pure, operationally heavy at 5k staff (role bloat, login provisioning).
2. **Session `SET LOCAL app.user_id = ...`** with RLS policies using `current_setting('app.user_id')` — common SaaS pattern. Gateway must use a role that **cannot** bypass RLS (`BYPASSRLS` forbidden, `SET ROLE` locked down).
3. **Curated views** already scoped (`v_my_tickets`) and a single reader role that only has SELECT on those views — no free-form SQL.

v1 recommendation: **(2) or (3)**. (1) only if IAM already provisions DB roles.

The connection is opened as `assistant_executor` **without** BYPASSRLS. Every request:

```
BEGIN READ ONLY
SET LOCAL statement_timeout = ...
SET LOCAL app.user_id = '<principal_id>'   -- if pattern 2
-- run single statement
COMMIT
```

`SET LOCAL` from a client that can later `RESET` / `SET ROLE postgres` is a hole. The DB role must lack those privileges. Connection pool: **do not** share a session across users without resetting. Prefer transaction-scoped pooling; a leftover `app.user_id` is a cross-user read.

### 6.2 Statement constraints

- Single statement. No `;` batches.
- Read-only. No DML/DDL.
- Allowlist of schemas/relations (even under RLS — reduce blast radius of a "clever" join to a table that *forgot* RLS).
- Row cap (e.g. 100) and column-width cap.
- Timeout (e.g. 2s interactive).
- EXPLAIN-only reject of sequential scans on huge tables if the DBA requires it — optional, quality/DoS, not ACL.

### 6.3 Text-to-SQL vs semantic layer

If RLS is complete and tested: generated SQL is acceptable **inside** the sandbox.

If RLS is incomplete: **do not generate SQL against base tables**. Offer a semantic layer (fixed metrics/views). Prompting the model with "add a WHERE user_id = ..." is **rejected** as a control. [ADR-004](./05_architecture_decision_records.md#adr-004).

## 7. End-to-end query path (numbered)

1. Gateway authenticates JWT. Failure → 401. No search.
2. Deny-list lookup (`principal_id` or `idp_sub`). Hit → 403. **No cache, no search.**
3. Resolve groups (cache). Failure → 503 fail closed. Do not search as anonymous.
4. Compute `acl_context_hash`.
5. Answer-cache GET. Hit → audit `cache=answer` → return. (Still no unauthorized bytes; key included hash.)
6. Determine legs (router). Drop legs with `source_sync_state.lag_s > SLO` or `status=failed`.
7. Parallel: retrieval-x per remaining unstructured leg with predicate in §3.1; optional SQL sandbox.
8. **Assertion post-filter**: drop any hit whose grants (re-read from ACL store **or** from chunk metadata) fail overlap. If this drops anything, **increment sev-1 metric** `prefilter_miss` and page. Remaining list is the only list.
9. RRF across unstructured legs. Cap N. Rerank. Hydrate.
10. Context assembler. Generator. Store answer cache. Audit full chunk ID list + SQL fingerprint.

Agent/multi-hop: each iteration restarts at step 2 with the **same** token. Tools do not get a raw retrieval-x client.

## 8. ACL sync path (numbered)

1. Webhook or poll: native event.
2. Translate to `resource` + `acl_grant` replace-set (effective ACL).
3. If grants unmappable (unknown group) → set resource `acl_state=pending`, **remove from live index**.
4. If grants mapped → upsert grants, bump `acl_generation`, metadata-patch all chunks of resource.
5. Content delete → chunk deletes + tombstone.
6. Update `source_sync_state.watermark`.
7. Lag beyond SLO → mark source `degraded`; read plane omits the leg.

Webhook gaps: periodic full reconcile (e.g. nightly) per source. Reconcile is how you catch missed unshares. Without it, the SLO is fiction.

## 9. Audit record (minimum)

```
ts, request_id, principal_id, acl_context_hash,
group_set_version, deny_hit,
legs_requested, legs_omitted, omit_reasons,
chunk_ids[], sql_fingerprint, sql_row_count,
cache_layer, assertion_drops,
index_generation
```

Do not log chunk **text** at info. Text in debug is a second corpus with worse ACL. Sampled debug requires the same authorization as production retrieve.

## 10. Latency budget (illustrative)

Unstructured-only, cache miss, identity cache hit:

| Stage | Budget |
| --- | --- |
| Authn + deny-list + identity cache | 5–15 ms |
| retrieval-x (hybrid, filtered) | inherited; typically tens–few hundreds ms |
| Assertion + RRF | few ms |
| Rerank N≤32 | tens–low hundreds ms (same as Tier 1.1) |
| Hydrate + generate | **not** in retrieval SLO |

SQL tool: **separate** SLO (timeout 2s). A design that quotes "p99 200 ms RAG" while the router calls SQL is lying.

Live vendor ACL on this path is how you blow the table. It is not in the table.

## 11. Failure modes (mechanical)

| Failure | Behavior |
| --- | --- |
| IdP down, identity cache miss | 503, fail closed |
| IdP down, identity cache hit | Serve until backstop TTL; then 503 |
| Slack API 429 during sync | Retry; lag grows; at SLO, omit Slack leg |
| retrieval-x down | 503; do not fail over to unfiltered replica |
| Assertion drop > 0 | Page; still do not send dropped text to model |
| Pool hands SQL session with leftover `app.user_id` | Cross-user leak — tested in Phase 4; transaction pooling required |
| Connector token stolen | Attacker reads sources **as the bot** (ingest blast radius). Query path still user-scoped, but the token is a warehouse of data. Rotate; this is [Security](./04_security_and_access_control.md) |

## 12. Tests that are design, not "QA later"

These are specified here because they **are** the enforcement:

- Cross-principal: user A cannot retrieve fixture owned only by B's group, via question paraphrase, via cache primed by B, via BM25-only, via ANN-only, via fused, via agent tool.
- Revocation drill: remove A from group; within SLO, retrieve returns zero on that fixture; deny-list offboarding is immediate.
- Unshare drill: Drive unshare; after sync (or SLO omit), zero hits.
- Assertion: inject a chunk with wrong metadata into retrieval-x; assertion drops it; metric fires; generator never sees it.
- SQL: user without salary grant, model emits `SELECT salary`; result empty / error, not numbers.
- Forged `user_id` body field ignored.
- Empty ACL arrays not treated as public.
- Rerank worker log fixtures do not contain unauthorized text in the passing test's captured logs (if you cannot assert this, your observability is a leak).
