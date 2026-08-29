# Multi-Source RAG with Access Control — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional.** Indexing real Slack/Drive before measuring retrieval-x filter capability, IdP group depth, and whether Postgres has RLS is how you create an unfiltered corpus you will be afraid to delete.

Phases 0–5 are sequential. A later phase must not start because a calendar slide said so if the previous gate is yellow. **Real company data is forbidden until Phase 5's leakage gate is green** (synthetic/public fixtures only until then). Expanding corpus is not a reward for shipping UI chrome.

Rollback/kill criteria at the bottom apply at every phase.

Calendar is **quarters**, not a hackathon. A realistic Phase 0 is 1–3 weeks. Phase 1 (single-source pre-filter on fixtures) might be weeks if retrieval-x already filters. Phases 2–4 are the connector slog. Anyone who schedules "enterprise multi-source RAG with ACL" at the end of month one has not read [Scenario — The Numbers](./01_scenario_and_requirements.md#the-numbers-taken-literally) or [Trade-offs §3](./06_tradeoffs_and_honest_assessment.md#3-cost-in-the-units-that-actually-hurt).

## Phase 0 — Measure identity, sources, retrieval-x, and the SLO (before a corpus)

**Objective**: Replace load-bearing guesses with written facts. Confirm we have a filterable retrieval backend. Freeze corpus exclusions and revocation numbers with security/legal. Refuse to crawl production sources until this gate is green.

**Deliverables:**
- **retrieval-x contract**: does BM25 *and* ANN support overlap/contains filters on metadata arrays? Latency at 50 / 200 / 512 group IDs on a sample. If either leg cannot filter, **this project is blocked** on retrieval-x work ([ADR-007](./05_architecture_decision_records.md#adr-007)). Do not paper over with post-filter.
- **IdP inventory**: group graph depth p95/p99, groups-per-user p50/p95/p99, SCIM/webhook availability, offboarding event (disable vs group strip vs both).
- **Source inventory**: Drive vs Confluence vs SharePoint (pick **one** docs system for v1); Slack workspace count, private vs public channel counts, Slack Connect/guests; Notion workspace; **Postgres RLS/GRANT reality** per schema the assistant wants.
- **Corpus policy, signed**: DMs out; internet-link out; HR/comp out — or written exceptions. [ADR-009](./05_architecture_decision_records.md#adr-009).
- **Revocation numbers, signed**: deny-list p99; ordinary unshare p99. Working assumptions 5 min / 15 min if they want a stake; **unsigned means Phase 2 cannot claim an SLO**.
- **Fail-closed vs availability**, signed: omitted legs under lag are acceptable. No "break-glass unfiltered search" flag.
- **Buy-vs-build note**: existing Glean/Copilot/etc. If buying, this phased plan **stops** after the note (or narrows to SQL-only). Honest kill is a successful Phase 0 outcome.
- Unknowns log: each item `measured` / `open, assumption X`. Open items that change architecture (no filterable index, no RLS and SQL is the actual ask, legal forbids indexing Slack) flagged immediately.

**Exit Gate:**
- [ ] retrieval-x (or equivalent) **proven** to apply the same ACL predicate on both legs, with a latency number at p95 group cardinality.
- [ ] Principal model named: one company, IdP, group-fanout.
- [ ] Docs SKU chosen (one). Slack and Notion in/out for v1 named.
- [ ] SQL: RLS-ready **or** views-only **or** SQL delayed — written, not "we'll prompt the WHERE."
- [ ] Corpus exclusions and revocation numbers signed (or explicitly unsigned with Phase 2 SLO blocked).
- [ ] Go/no-go: **build** vs **buy** vs **narrow to one source**. Do not enter Phase 1 as a full four-source program if Phase 0 said buy.

Do not issue production connector tokens in Phase 0 except read-only probes under a time-boxed security review.

## Phase 1 — Single source (docs), coarse group pre-filter, synthetic data only

**Objective**: Prove the data path: identity → group set → index-time ACL on chunks → pre-filter retrieve → assertion → generate. **No** production corpus. **No** revocation SLO claim yet. Correctness of "empty ACL is not public" over features.

**Deliverables:**
- OIDC on the gateway; principal from token; forged header test.
- Fixture IdP: users U1, U2; groups G_eng, G_legal; one share-to-person file.
- Docs connector against **synthetic** Drive-like fixtures (or a throwaway folder with no real PII): files with group grants, user grants, and a "should never appear" file.
- Chunk + upsert into retrieval-x with `acl_group_ids` / `acl_user_ids` / `acl_state`.
- Query path: filter predicate on both legs; assertion post-filter; audit record.
- Tests from [System Design §12](./03_system_design.md#12-tests-that-are-design-not-qa-later) that apply to one source (cross-principal, empty≠public, BM25-only, ANN-only, hydrate-by-id).
- Cache with `acl_context_hash`; poison test: U2 cannot hit U1's answer.
- Chat UI optional. API contract first. UI is not a gate.

**Exit Gate:**
- [ ] U1 cannot retrieve G_legal-only fixture via paraphrase, either search leg, fused path, or cache primed by a legal user.
- [ ] Empty ACL chunk is not searchable.
- [ ] Pending ACL chunk is not searchable.
- [ ] Assertion drop metric exists; injection test pages (or fails the suite) and does not send text to the model.
- [ ] No production data in the index (attested).
- [ ] This gate is **not** a launch.

If retrieval-x filter only works on one leg, **stop**. Do not "ship BM25-only ACL."

## Phase 2 — ACL sync and identity as real subsystems; revocation drill is a gate

**Objective**: Replace fixture groups with **real IdP sync** (still against synthetic or public docs if possible). Group expansion, deny-list, watermarks, webhook+poll, nightly reconcile **design implemented**. Revocation SLO becomes testable.

**Deliverables:**
- SCIM or directory sync → `principal_groups`; nested expansion with depth/cardinality caps; overflow errors (not silent drop).
- Hot deny-list path; gateway order deny → cache → search.
- ACL store + `source_sync_state`; metadata-only patch on grant change; content delete removes chunks.
- Webhook handler + poller + **scheduled reconcile** for the docs source.
- Metrics: lag, `acl_unknown`, group-set size histogram, deny-list hits.
- **Revocation drill** on fixtures: remove U1 from G_eng; measure time-to-zero-hits; offboard via deny-list; measure time-to-403.
- Fail-closed: break the ACL store / identity cache miss → 503, not unfiltered.

**Exit Gate:**
- [ ] Ordinary membership change on fixtures converges within the **signed** ordinary SLO (or unsigned: drill number recorded, SLO still not advertised).
- [ ] Deny-list offboarding meets the signed fast path (or recorded).
- [ ] Missed-webhook simulation: reconcile restores correct deny (unshare that the webhook dropped).
- [ ] Identity failure fails closed (tested).
- [ ] Still no production Slack/HR/DMs. Production **docs** still out until Phase 5 unless security explicitly allows a **tiny** labeled public-internal corpus — default remains out.

If directory expansion cannot complete for real employees (512 cap hit widely), **stop and fix directory hygiene or the cap policy**. Do not skip groups.

## Phase 3 — Second heterogeneous source (Slack *or* Notion); federation

**Objective**: Prove that a **different** ACL language can normalize into the same predicate without a query-path switch. Cross-source RRF. One new connector, not two at once.

**Deliverables:**
- Pick **one**: Slack private+public channels (DMs still out) **or** Notion pages. Prefer Slack if the company's pain is channels; Notion if that's the wiki. Not both in this phase.
- Mapper for that source's membership/page ACL → `acl_grant`; unmapped → pending.
- Source partition or `source` filter; federation RRF; `legs_omitted` when lag > SLO.
- Tests: user not in private channel cannot retrieve those messages via "what did we decide about X"; public channel visible; guest cannot inherit workspace-wide group.
- Degradation flag when the new leg is omitted; no silent unfiltered search of that source.

**Exit Gate:**
- [ ] Cross-source question returns only authorized chunks from **both** legs.
- [ ] Private-source fixture (channel or Notion restricted page) is a zero-hit for a non-member on BM25, ANN, and fused.
- [ ] Lag-omit drill: freeze sync, age watermark, confirm leg dropped and not searched.
- [ ] Still synthetic/controlled workspace (a **throwaway Slack/Notion**), not the company workspace.

Adding the third unstructured source (the one not picked) is a **repeat of Phase 3**, not a freebie inside Phase 4. Do not parallelize two new mappers unless staffing is real.

## Phase 4 — SQL source via RLS-enforced execution

**Objective**: Add structured retrieval that is authorized by the **database**, not by the prompt. If Phase 0 said RLS is absent and views are the path, this phase builds the view sandbox instead of free-form SQL. If Phase 0 delayed SQL, **skip this phase** rather than fake it.

**Deliverables:**
- Executor role without `BYPASSRLS`; read-only; statement timeout; single statement; relation allowlist.
- Session bind (`SET LOCAL app.user_id` or equivalent) **or** per-view model from Phase 0.
- Transaction-scoped pooling; test that leftover session vars cannot occur (or connections are not reused across principals).
- Router: when to call SQL vs unstructured (conservative: explicit tool / user intent, not every question).
- Tests: user without salary access, model emits `SELECT salary…`, no salary values in tool result or generator context; allowlist blocks off-schema tables; timeout; multi-statement rejected.
- SQL results as a separate evidence block; not fake cosine chunks.

**Exit Gate:**
- [ ] RLS/view tests pass with an adversarial generated statement suite (not one happy-path query).
- [ ] Pooling cross-user test passes.
- [ ] Unstructured ACL still enforced when both SQL and search run in one request (no "SQL path skips deny-list").
- [ ] No production PII schemas until Phase 5. Use a **fixture database** with fake employees.

If these tests fail, **do not** "temporarily" use a superuser role to unblock the demo.

## Phase 5 — Leakage red-team gate, then production corpus under a freeze

**Objective**: Prove the negative as far as a test suite can. Only then index a **narrow** real corpus (e.g. public-internal docs + one public Slack channel + one RLS schema). Not "the whole Drive."

**Deliverables (red-team suite, automated + a time-boxed human pass):**
- Cross-principal retrieve on all live legs, including agent/multi-hop if present (if agent is not built, the suite still includes hydrate-by-id and a second retrieve call).
- Cache poison (privileged then unprivileged; semantic cache still off).
- Assertion injection.
- Forged identity fields.
- SQL adversarial suite against the **staging** clone of real RLS (anonymized if required).
- Revocation drills against the staging copies of real ACL APIs (a real unshare, not only fixtures).
- Rerank/trace/log scrape for unauthorized fixture strings.
- Connector-token rotation drill.
- Citation click-through does not proxy bytes with the bot token.

**Production corpus rules after green:**
- Allowlist of Drive folders / Slack channels / Notion sections / SQL schemas. Default deny.
- Watermarks in SLO for those sources for **N days** in staging with production-like ACL change rate (or a recorded exception).
- On-call runbook: assertion page, lag-omit, deny-list add.
- Eval set **cannot** contain unauthorized text for the eval principal.

**Exit Gate:**
- [ ] All red-team items pass; human pass recorded (security attendee).
- [ ] Allowlisted production corpus only; attestation of exclusions (DMs, HR, secret links).
- [ ] Audit logs reviewed for a dry-run week (who asked what — privileged).
- [ ] Launch is **this allowlist**, not "then we turn on All Channels." Expanding the allowlist is a change-control with a repeat of relevant tests, not a config flip on Friday.

## Phase 6 — Operations (ongoing, after a limited launch)

Not a feature phase. This is the remaining life of the system:

- Reconcile jobs stay green; lag SLO is paged.
- Directory cap/depth metrics; fix AD rather than raising caps casually.
- Periodic replay of the red-team suite in CI against fixtures **and** a scheduled staging run against sampled production ACL.
- Connector API version breaks (Slack will). Budget maintenance.
- Any new source = new Phase 3.
- Semantic cache remains off until a dedicated ADR and a poison retest.

## Rollback and kill criteria (every phase)

**Rollback:**
- Assertion `prefilter_miss` > 0 in production: **disable generation**, serve "unavailable," patch, do not fail-open.
- Deny-list path broken: fail closed (everyone 503) rather than search.
- Suspected leak: take the assistant offline; rotate connector tokens if ingest may be involved; preserve audit.

**Kill / do not proceed:**
- retrieval-x cannot filter both legs and nobody will fund that work → **stop** or **buy**.
- Legal will not sign exclusions/SLOs and still wants "all of Slack" → **stop**.
- RLS missing and SQL is the actual requirement and nobody will write policies/views → **do not ship SQL**.
- A production leak in Phase 5 dry-run → **do not expand corpus**; treat as a failed gate, not a hotfix-and-launch.
- Management demands an unfiltered admin search box in the same API → **refuse**; that is a separate, audited e-discovery tool, not a flag.

**Never:**
- Index real private channels "just to test recall" before Phase 5.
- Ship post-filter-only to "hit the date."
- Add `skip_acl=true` for on-call.
- Key a cache on the question alone "temporarily."
- Execute SQL as a shared superuser "until RLS is ready."
