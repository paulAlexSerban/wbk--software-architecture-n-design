# Multi-Source RAG with Access Control: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

An internal knowledge assistant is asked to answer questions over **four heterogeneous sources** that the company already has:

1. A **Postgres application database** (tickets, CRM notes, account records — some rows are company-wide, some are team-scoped, some are row-level "assignee / account owner only").
2. A **document store** (Google Drive / Confluence-class): files and pages with share lists, link-sharing, inherited folder permissions, and the occasional "anyone in the company" doc sitting next to a compensation spreadsheet.
3. **Slack exports** (or a live connector): public channels, private channels, DMs, and threads whose visibility is channel membership, not a folder ACL.
4. **Notion exports** (or a live connector): pages and databases with per-page permissions, inherited workspace roles, and share-to-person overrides.

The current (or naive) product does one of the following, all of which fail the same way:

- Retrieves from an unfiltered index, then **hides citations in the UI** if the user "shouldn't" see them. The model already read the chunk. The answer already contains the secret.
- Retrieves top-k, then **post-filters** unauthorized chunks and stuffs whatever remains into the prompt. Under-fill, existence leakage via scores, and a missed `if` are all production incidents.
- Instructs the model: *"only use documents the user is allowed to see."* Prompt-level restriction is **not a security control**.

The system must:

1. Return only chunks (and SQL rows) the **authenticated principal** is authorized to read, **before** those bytes enter the generator's context.
2. Apply that check at **retrieval time**, in the pipeline, not in the client.
3. Federate heterogeneous sources without pretending they share one ACL language.
4. Stop matching a principal within a **bounded revocation window** after IdP or source ACL change.
5. Survive the RAG-specific leakage paths that classic search never had: rerank scores, result caches, multi-hop re-retrieval, and chunk boundaries that do not match ACL boundaries.

The design must answer, concretely:

1. Where permission checks live (pre-filter vs post-filter vs source-scoped indices), and the **leakage profile of each**.
2. How four different ACL models become one query-time predicate without exploding index cardinality.
3. Why live calls to Slack/Notion/Drive on every retrieve are not the enforcement path, and what **sync-lag as a security window** then costs.
4. How caching, reranking, and agentic follow-up queries are prevented from becoming privilege-escalation primitives.
5. How the SQL path is authorized by **executing as the user** (RLS / role), not by asking the LLM to write a `WHERE`.
6. Why this is a **multi-quarter security-sensitive program**, not a weekend RAG demo.

This is the **retrieve-then-hope trap**. The naive answer — "the retrieval service already exists; wrap it with a filter" — is the failure. It treats authorization as a presentation concern. In a RAG system, **retrieved text is the product**. Anything the retriever emits is, for practical purposes, already disclosed to the model and usually to the user.

The correct shape is: **identity resolves to groups; source connectors normalize ACLs onto chunks at index time; the retrieval backend pre-filters with a group predicate; SQL runs under the caller's database identity; caches are keyed on the authorization context; unknown or stale ACL is fail-closed.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true across four sources whose permission APIs were never designed to be a search index.

## The Trap, Stated Directly

Search-with-ACL is a solved-ish problem in enterprise search (Glean, Elastic with document-level security, Microsoft Graph + Copilot). RAG makes it worse, not easier:

- The **LLM is a confused deputy**. It will quote, paraphrase, and combine. A UI that omits a citation does not un-know a fact the model already used.
- **Top-k is a side channel.** If unauthorized hits occupy slots, authorized recall collapses. If you inspect scores or candidate counts before dropping, you leak existence.
- **Semantic cache is a datastore of answers.** An answer produced for a VP, served to an intern because the question embedding was close, is a cross-privilege read.
- **Chunking is an ACL transformation.** A document with a public executive summary and a restricted appendix, split into overlapping windows, will put restricted sentences into a chunk whose metadata still says "company-wide" unless ACL is attached at the grain you actually index.
- **Text-to-SQL is a second retrieval path** with a second enforcement story. If the generator can `SELECT * FROM employees`, the vector index's perfect ACL is irrelevant.

Three more traps hide behind the first:

**The homogeneous-filter trap.** `WHERE tenant_id = ?` is the right idea for a multi-tenant SaaS table. It is not an ACL model. Drive share lists, Slack private channels, and Notion page permissions are **principal sets**, often with nested groups, often with "anyone with the link," often with inherited folders. A single tenant column cannot express "shared with Alice, the legal-group, and this one contractor."

**The live-check trap.** "Just call Slack's `conversations.info` / Drive's permissions.get / Notion's page retrieve at query time" looks like strong consistency. It is a p99 and availability coupling to four vendor APIs, a rate-limit incident waiting to happen, and a fail-open temptation ("if Slack 429s, return the chunk anyway so the product works"). Fail-open on ACL is a data leak with extra steps.

**The per-user-metadata trap.** Storing `allowed_user_ids: [alice, bob, ...]` on every chunk makes filtered ANN a cardinality bomb. A company-all-hands doc becomes a 10k-value array. A user's query filter becomes `user_id IN (...)` against millions of distinct values, which ANN engines handle poorly (low-selectivity or high-cardinality filters destroy recall, or they brute-force). Groups exist because this does not scale. Groups introduce **stale membership**, which is the actual security engineering.

## The Numbers, Taken Literally

These figures are load-bearing working assumptions for a **mid-size internal deployment** (one company, not a multi-tenant SaaS). Phase 0 replaces them with measurements. They exist so that "we'll just filter" has to survive arithmetic.

| Claim | Arithmetic | Implication |
| --- | --- | --- |
| 50k docs + 2M Slack messages + 20k Notion pages + a 200 GB OLTP DB | Not "50k vectors." Slack threads chunk; docs chunk; Notion blocks chunk. Working set is **hundreds of thousands to low millions of chunks**, not billions — this is **not** the 50M-doc scale problem. The hard problem is ACL, not RAM. |
| Typical knowledge-worker is in **20–200 IdP groups** (org units, security groups, mailing lists, project groups) | Query-time filter is `chunk.acl_group_ids ∩ user.group_ids ≠ ∅` (plus user-id allow for share-to-person). Filter cardinality is **the user's groups**, not the company's users. |
| Popular doc shared with 8 named people + 3 groups | Index-time ACL is ~11 principals. Fine. |
| Company-wide "all employees" wiki | Index-time ACL is **one group** (`all_employees`), not 4,000 user IDs. If you flatten to users, you pay 4,000× metadata and every join/leave rewrites the chunk. |
| Deep nested groups (A contains B contains C, 12 levels, cycles in AD) | Naive expansion at query time is a graph walk with a timeout. Bound depth. Materialize. Cycles are not theoretical in real AD. |
| Live ACL check: 4 sources × 40 candidate chunks × ~100–300 ms p95 vendor API | **Seconds**, plus 429s. Not inside a retrieval SLO. This is why sync + pre-filter exists. |
| Revocation window of **15 minutes p99** (IdP group leave or source unshare → chunk no longer matches) | A fired employee, or a contractor removed from a channel, can still retrieve for a quarter of an hour. That number is a **security conversation with legal/HR**, not an implementation detail. Shorter windows cost webhook completeness + tighter sync. Zero is a lie. |
| Semantic cache keyed on query text only | First privileged user to ask "what is the acquisition price?" **poisons** every later user. Cache hit rate becomes a leak rate. |

**This project is not a scale-out ANN problem.** Borrow the retrieval funnel from [prj--rag-pipeline-at-scale](../../prj--rag-pipeline-at-scale/README.md); do not re-litigate HNSW. The scarce resource here is **correct, fresh, fail-closed authorization metadata** and the operational loop that keeps it true.

## Current State (Assumed Starting Point)

A typical first version of this path looks like:

1. A connector dumps Drive/Confluence exports, a Slack zip, and a Notion markdown dump into object storage.
2. A naive or hybrid RAG pipeline chunks and indexes **everything the service account can read** — which is, by design of most bots, **too much**.
3. The chat UI has a logged-in user. Citations are filtered if a hardcoded map says the user is not in `legal`. The model was already given the legal memo.
4. Someone adds "query the tickets database" as a tool. The tool uses a **shared app role** with `SELECT` on the whole schema. The LLM writes SQL. RLS is "on the backlog."
5. A Redis cache stores answers by question hash. Demo day is impressive. The intern asks the same question as the CFO.

That version will appear to work in a demo with three public docs and two users in the same group. It will fail the first time a private Slack channel is in the export, the first time a Drive file is "anyone in the domain," the first time someone is removed from a project and the index is a week stale, and the first time a cached answer crosses a privilege boundary.

This project documents the replacement, not a prompt that says "be careful."

## Identity Model (Assumption, Confirmed)

**Principals are company employees and service accounts**, authenticated via the company IdP (Okta / Azure AD / Google Workspace). This is **one tenant** (the company). It is not a multi-tenant SaaS. Isolation is **per-user / per-group**, not per-customer.

Consequences that shape the architecture:

- Every request carries a verified identity (`sub`). The retrieval layer **does not trust** a client-supplied `user_id` header.
- Authorization is **group-centric** plus **explicit user grants** (share-to-person). See [ADR-001](./05_architecture_decision_records.md#adr-001).
- Nested groups are materialized into a bounded set of group IDs cached on the identity, with a TTL that **is** the revocation SLA for group-based access. [ADR-006](./05_architecture_decision_records.md#adr-006).
- Service accounts that index sources use **connector identities** with least privilege. The indexer's ability to read a doc is **not** the end-user's ability to retrieve it. A connector that can read everything (Slack discovery, Drive DLP admin, Notion owner) is a **privileged ingest path**; the index must still carry the *end-user* ACL, or you have built a god-mode search box.
- There is no "anonymous internal" mode. Unauthenticated is fail-closed: no retrieval.

## Target Users

- **Owning engineer / platform architect**: needs a design that can be defended when security asks "where is the check" and the answer is not "in the React app."
- **Security / IAM**: needs a written revocation SLA, an audit trail of which chunks were returned to whom, and a red-team gate before production corpus.
- **Source-system owners** (IT for Slack/Drive, DBA for Postgres, Notion workspace owners): need to know a bot will crawl their ACL APIs, what lag they are signing up for, and that a shared indexer identity is a new crown jewel.
- **On-call for the assistant**: needs to know whether "wrong answer" is a retrieval miss or an ACL false-negative (over-filtering), and whether a spike in `acl_unknown` is a security event.
- **Legal / HR**: needs to agree the 15-minute (or whatever Phase 0 writes) window after offboarding, and that Slack DMs are either **out of corpus** or a career-limiting inclusion.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which model writes the answer, the chat UI chrome) are out of scope except as they affect the retrieval contract.

1. **Authorization is enforced in the retrieval pipeline**, on every hop that can load source text into model context — including rerank input, tool-call SQL, and agentic re-retrieve. UI filtering is defense-in-depth at best, never the control.
2. **Pre-filter is the default enforcement** (ACL predicate inside the search). Post-filter is forbidden as the sole control. Source-scoped indices are allowed as a coarse optimization, not as a substitute for share-to-person. [ADR-002](./05_architecture_decision_records.md#adr-002).
3. **Fail closed.** Missing ACL metadata, stale-beyond-SLO ACL, identity-resolution failure, or source-sync failure **excludes** the chunk (or refuses the query), rather than including it. Product emptiness is the accepted failure mode. Data leakage is not.
4. **Heterogeneous ACLs are normalized** into a shared model at ingest. Query path does not speak Drive vs Slack vs Notion. [ADR-003](./05_architecture_decision_records.md#adr-003).
5. **SQL is authorized by the database.** Generated SQL runs as the caller's DB role (or a session with `SET LOCAL` equivalent + RLS). A shared superuser role plus a prompt constraint is a defect. [ADR-004](./05_architecture_decision_records.md#adr-004).
6. **Caches include authorization context in the key.** Exact or semantic. A privileged answer must not be reusable under a different group set. [ADR-005](./05_architecture_decision_records.md#adr-005).
7. **Revocation has a number.** IdP group removal and source unshare propagate to retrieval within the written p99 (working assumption: **15 minutes**; Phase 0 may tighten for offboarding via an explicit deny-list). [ADR-006](./05_architecture_decision_records.md#adr-006).
8. **Retrieval quality is a separate backend.** Hybrid BM25 + vector + optional rerank is consumed from the Tier 1.1 service. This project adds filter metadata, federation, and the SQL path; it does not fork the ANN design. [ADR-007](./05_architecture_decision_records.md#adr-007).
9. **Audit every retrieval.** Principal, resolved groups (or a hash), chunk IDs returned, source, ACL generation. This is how you investigate a leak. It is also how you discover your cache was the leak. [Security](./04_security_and_access_control.md).
10. **DMs, "anyone with the link," and HR/compensation corpora have an explicit include/exclude policy.** Defaults: DMs **out**; secret-link docs **out** unless also ACL'd to a group; HR/comp **out** of v1. Silent inclusion is how demos become incidents.

## Success Criteria for the Design (Not Implementation Metrics)

1. A user who is not in `proj-phoenix` cannot retrieve a chunk whose only grant is that group, including via paraphrase, citation-less answer, or cached hit from a teammate's identical question.
2. Removing a user from an IdP group causes that group's chunks to **stop matching within the revocation SLO**, measured by a drill, not by hope.
3. Unsharing a Drive file (or kicking a user from a Slack channel) causes the same, within the source-sync SLO (may be longer than IdP; both numbers are written).
4. A post-filter-only implementation is **rejected** in review. Tests include: candidate list never contains unauthorized text **in the reranker**, not only in the generator prompt.
5. Generated SQL, executed with a test user who has RLS denying `salary`, returns zero salary rows even if the model emitted `SELECT salary FROM employees`.
6. A semantic/exact cache populated by user A is a miss for user B when B's group set is not a **superset** that would have authorized the same chunks (v1: require **exact group-set match** on the cache key — simpler, slightly worse hit rate, no subset reasoning bugs).
7. A query issued with a forged `user_id` header and a valid service identity does not switch principal. Principal comes from the verified token.
8. `acl_unknown` / sync-lag metrics exist. Indexing real (non-synthetic) company data is **blocked** until the Phase 5 leakage gate passes.

## Business Rules (Platform-Scoped)

1. No retrieval without a verified IdP identity.
2. Connector service accounts are not query principals. Querying "as the bot" is not a product mode.
3. ACL metadata is versioned (`acl_generation`). Queries specify the generation they trust; mixed generations in one result list are a bug.
4. Over-filtering (false deny) is a **quality** incident. Under-filtering (false allow) is a **security** incident. They are not tuned with the same knob.
5. Slack private channels require membership at index time **and** at query time (via synced channel-group mapping). Exporting a private channel into a global index without membership metadata is forbidden.
6. The generator sees **only** authorized chunks. System prompts that mention unauthorized titles "for context" are unauthorized chunks with extra steps.
7. Break-glass (security, legal discovery) is a **separate audited path**, not a `is_admin` flag on the chat app.

## Non-Goals

- **Not a public multi-tenant SaaS RAG product.** One company, many users, many groups. Tenant isolation of the IoT-platform kind is a different design.
- **Not re-solving hybrid retrieval at 50M documents.** That is [prj--rag-pipeline-at-scale](../../prj--rag-pipeline-at-scale/README.md). This corpus is smaller; the ACL is harder.
- **Not real-time per-source ACL on the query path** as the primary control. Sync lag is accepted and bounded. [ADR-002](./05_architecture_decision_records.md#adr-002).
- **Not Slack DM / huddle / canvas indexing in v1.** Private-channel indexing is already the hard case; DMs are a consent and employment-law problem.
- **Not "the LLM refuses to talk about salaries" as HR protection.** Exclude the corpus or enforce RLS. Prompts are not ACLs.
- **Not a replacement for the source systems' own sharing UI.** We mirror; we do not become the system of record for who can see a Drive file.
- **Not Glean-complete.** No 100-connector marketplace, no people search, no workplace graph product. Four sources, one assistant.
- **Not exactly-once ACL.** At-least-once sync with fail-closed on uncertainty.
- **Not an implementation.** No Python connectors, no Terraform, no pgvector DDL. Numbered steps and diagrams only.
- **Not a claim this is a small project.** Correct ACL sync across Slack/Drive/Notion is a **product** companies sell. See [Trade-offs](./06_tradeoffs_and_honest_assessment.md).
