# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone dumps the company Slack export into an unfiltered vector index.

The fact, once: **retrieved text is disclosure.** UI filters, prompt instructions, and post-filter top-k do not un-know a chunk. ACL models differ per source. Live checks do not fit a retrieval SLO. **Revocation lag is a security SLA.** Per-user metadata on every chunk does not scale. SQL is the easy subsystem if RLS exists and the hard political one if it does not. Slack/Drive/Notion ACL sync is the actual product.

## 1. What I would build

An **identity-aware retrieval plane** on top of an existing hybrid retriever, not a new chatbot with a `user_id` column.

- **OIDC gateway** that treats principal as a verified token claim. No spoofable header. Deny-list before cache before search.
- **Group resolver** with nested expansion, bounded depth/cardinality, SCIM invalidation, and a hash that every result cache key includes.
- **Per-source connectors** that compute *effective* ACL, normalize to `(resource, group|user, read)`, and **refuse to publish chunks** until ACL is complete. Metadata patch on share-change without re-embed.
- **Group-fanout pre-filter** on both BM25 and ANN of retrieval-x, plus an assertion post-filter that pages if it ever fires.
- **Federation**: docs / Slack / Notion as filtered legs, RRF, rerank only on authorized hits. SQL as a **sandbox + RLS** tool, not as chunks.
- **Coarse partitions** where the boundary is real (HR not in the default corpus; Slack private vs public) without pretending partitions replace share-to-person.
- **Audit** of every retrieve, including cache hits and empty results.
- **Gated corpus**: synthetic and public fixtures until a leakage red-team passes. DMs, internet-link files, HR/comp **out** of v1.

I would not build a 100-connector marketplace, live ACL GETs on the query path, a global semantic cache of answers, or a prompt that says "be careful with private data."

If Phase 0 shows the company already pays for **Glean / Microsoft Copilot with Graph / a similar product** that covers the sources that matter, and the gap is "we want a different LLM," I would **buy the retrieval-with-ACL** and spend engineering on generation policy, eval, and the SQL sandbox — not on reimplementing Drive inheritance. Architecture for pride is how you own Slack's permission edge cases forever.

## 2. What I would give up

Be explicit. These are not "later" disguised as v1.

**Strong consistency with Slack/Drive/Notion.** We give up "the moment you unshare, search is correct." We keep a **number** (15 minutes ordinary, 5 minutes offboarding, Phase 0-signed). Zero is a lie unless we do not index.

**Post-filter as the easy control.** We give up the afternoon that "works" in a demo. We keep pre-filter + assertion.

**Per-user lists on every chunk.** We give up the mentally simple model. We keep groups and the directory-sync burden that comes with them.

**Global answer cache / default semantic cache.** We give up a chunk of the usual RAG cost slide. We keep `acl_context_hash` on keys. Identical questions from differently authorized people are different requests.

**SQL against base tables without RLS.** We give up "the assistant can query everything in Postgres." We keep curated views or we wait for the DBA.

**Indexing DMs, secret links, HR/comp in v1.** We give up demo wow. We keep a job.

**Live per-hit vendor ACL.** We give up the slide that says "always check source of truth." We keep p99 and fail-closed.

**Fail-open during connector outage.** We give up assistant completeness under Slack 429s. We keep omitted legs. On-call will hate this; the ADR is for them.

**A from-scratch vector database.** We give up the ANN bake-off. We consume retrieval-x. If retrieval-x cannot filter, **that** is the first build, and this project waits.

**Subset cache reuse.** We give up extra hit rate. We keep a key that is easy to reason about.

**Perfect nested-group fidelity.** We cap depth and cardinality. Weird AD graphs fail closed or error; they do not silently search.

## 3. Cost, in the units that actually hurt

**Engineering time is the bill, not GPU RAM.**

Four ACL mappers, webhook holes, reconcile jobs, identity graph, contract tests, and the red-team gate are a **multi-quarter** program for a small team (honestly: **2–4 engineers for 2–3 quarters** to get Slack+docs+Notion+SQL to a point you would let employees use on real data — longer if Slack Connect, guests, and SharePoint inheritance enter the chat). Anyone scheduling "enterprise RAG with permissions" in a two-week sprint has not read Slack's permission model.

**Connector API quota and rate limits** are an operational cost. Aggressive ACL crawl will 429. Then lag exceeds SLO and you omit the source — which looks like an outage. Budget for backoff, paid API tiers, and a reconcile window that does not stampede.

**False-deny (over-filter) burns product trust.** Users will say "AI search is useless." The team will be pressured to loosen filters. That pressure is the main **security** cost: social, not technical. Metrics that split ACL-omit from retrieval-miss exist so you can argue with data.

**False-allow is a career/legal cost.** One private channel in a generated answer can end the project. The gated plan exists because of this, not because of process religion.

**LLM tokens** are unchanged by ACL except that over-filter may cause retries. Do not loosen ACL to save tokens.

**Infra** is modest versus a 300M-vector platform: Postgres, a retrieval cluster for low millions of chunks, workers. The expensive infra *mistake* is embedding corpora you will later legally exclude (DMs) — you paid to create a toxic dataset.

**On-call** is real. Watermark lag, deny-list replication, "why did Slack disappear from answers," assertion pages. This is not a stateless demo you forget.

## 4. Build vs buy

Enterprise search/RAG vendors exist **because** this problem is miserable:

| Option | You get | You give up |
| --- | --- | --- |
| **Glean, Guru, Elastic workplace search, Copilot+Graph, similar** | Connectors and ACL sync someone else staffs; often good-enough Drive/Slack | Model choice, data-residency story, SQL/RLS path, price, "our index" control |
| **Build this design** | Choice of generator, SQL sandbox, explicit fail-closed policy, no vendor lock on the *answer* path | You **are** the connector company now |
| **Buy connectors, build generation** | Possible compromise: use vendor search API **with their ACL** as a retrieval-x substitute | Still coupled to their recall, latency, and outages; still need cache/audit/SQL story |

**Build if:** sources include things vendors do not cover (internal SQL with RLS is the usual gap), or legal forbids sending the corpus to that vendor, or the company already has retrieval-x and the missing piece is really only ACL+federation.

**Buy if:** the forcing function is "employees want workplace search that doesn't leak" and the sources are the big SaaS suite. Rebuilding Drive inheritance to save a license fee is almost always a bad trade.

**Do not** build a worse Glean and also promise a research-grade agent. Pick a job.

A hiring-portfolio version of this project can **honestly** implement a *narrow* subset (one docs source + fake Slack membership + Postgres RLS) and still teach the architecture — provided the docs say what was not built. Shipping a toy post-filter and labeling it "enterprise ACL" is the failure mode of the portfolio, not just of production.

## 5. What is actually hard vs what is easy

**Easy (comparatively):** calling an embedding API; standing up pgvector; writing a chat UI; RRF; adding a `user_id` metadata field.

**Hard:**

- Drive inheritance, domain links, broken inheritance, shared drives.
- Slack private channels, guests, Slack Connect, eventually-consistent membership.
- Notion page-tree vs database permissions vs guests.
- Directory nested groups, cycles, unmapped IdP groups.
- Cache + multi-hop + hydrate-by-id + traces as ACL surfaces.
- SQL connection pooling vs `SET LOCAL`.
- The social pressure to fail open.
- Proving a negative (no leak) with tests that stay green as connectors evolve.

**SQL+RLS is architecturally clean** and still politically hard (who writes the policies?). **Unstructured ACL sync is technically and operationally hard** and never done. Budget attention accordingly. A design that spends twenty pages on HNSW parameters and one paragraph on Slack membership has failed this scenario.

## 6. Why "just add a permission filter" is not a full answer

The bar the scenario sets. A filter function is a **placement**. Placement is the architecture.

- Filter in the UI: the model already leaked.
- Filter after top-k: leakage + recall collapse + one `if`.
- Filter as a prompt: not a control.
- Filter as `tenant_id`: the wrong model for share-to-person and channel membership.
- Filter as live API: SLO and fail-open.
- Filter as pre-filter group overlap: the actual design, **and** it implies identity materialization, ACL denormalization, fail-closed pending states, cache keys, assertion, audit, and a revocation number.

The last bullet is a system. The first five are how demos ship.

## 7. How the design changes if the constraints were different

**If this were multi-tenant SaaS (customers sharing the platform):** add a `tenant_id` that is a **hard partition** (separate indices or mandatory tenant predicate that cannot be forgotten) *in addition to* per-user ACL. A missing tenant predicate is a cross-customer incident, worse than cross-employee. Do not run this project's "one company" identity model unchanged.

**If the only source were Postgres with good RLS:** skip unstructured ACL sync. The assistant is a SQL sandbox plus maybe a docs index of public runbooks. Much smaller project. Do not build Slack connectors "while we're here."

**If legal required zero revocation lag:** do not index; query sources live with the **user's** OAuth token (user-delegated search). Completeness and latency suffer; ACL correctness tracks the source. That is a different architecture (federated live search, poor RAG candidate generation) and a different ADR set.

**If the corpus were 50M documents:** combine this ACL plane with [prj--rag-pipeline-at-scale](../../prj--rag-pipeline-at-scale/_docs/05_tradeoffs_and_honest_assessment.md). Filtered ANN at that scale is harder; group IDs still win over user-ID lists. You now have two scarce resources (RAM **and** ACL freshness).

## 8. Residual honesty

This design does not make the company "safe." It makes **cross-principal retrieval** a testable property with a bounded stale-allow window. Authorized users can still exfiltrate. Admins can still dump the index. Connector tokens are still crown jewels. The LLM vendor still sees authorized context. Mixed-sensitivity PDFs still have one Drive ACL.

If a stakeholder needs "the AI cannot ever leak," the honest product is **do not build an assistant over private data**, not a more sophisticated filter.
