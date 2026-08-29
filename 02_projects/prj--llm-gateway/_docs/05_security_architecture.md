# LLM Gateway — Security Architecture
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document specifies the threat model, data-handling boundaries, identity, and secrets lifecycle for a system whose defining characteristic is that it **sees every prompt and completion the company sends through it**. The gateway is a chokepoint: that is the point of the product (keys, budgets, audit) and the point of the risk (one box holds the traffic, the keys, and a cache of the content).

## Threat Model

**What is in scope that a generic HTTP proxy does not have:**

- Prompts and responses may contain PII, credentials pasted by accident, customer data, unreleased product information, and instructions that look like "system prompts."
- **Semantic cache and embeddings are derived copies of that content.** Embeddings are not anonymization; they can leak information under inversion-style attacks and they definitely leak "this team asked something close to X" to anyone who can query the index.
- Provider keys sitting on the gateway are **the** keys. A leak is not "one team's Slack webhook"; it is the company's OpenAI/Anthropic bill plus generation-as-the-company.
- Callers are internal teams, not the public internet — but internal is not trusted uniformly. A compromised service account should not spend another team's budget, read another team's cache, or pin-bypass `no_egress`.

**Assumed adversaries (realistic, not movie):**

- A developer dumps a provider key in a frontend or a notebook (the thing this gateway exists to stop *going forward*).
- A team service is compromised and uses its *own* gateway identity to generate data-exfil via "summarize these files" — the gateway cannot tell intent; it can cap spend, log, and enforce data-handling class.
- An operator or overly-broad log pipeline stores raw prompts in a searchable cluster with lax ACL.
- A vendor incident / subpoena / training-use dispute on SaaS-side data. Routing policy is the control; legal is the rest.

**Explicit non-goals:**

- Making the model immune to prompt injection **from the team's own users**. That is the calling app's problem (tool allowlists, etc.). The gateway may later add optional scanners; v1 does not pretend a regex is a DLP product.
- Protecting against a fully malicious platform operator with production access. Limit blast radius (audit, split duties) but do not claim otherwise.

## Data Handling by Destination

Routing is a **data-residency and contractual** decision, not only a cost decision. Cost-aware routing is forbidden from "helpfully" sending a `no_egress` prompt to a cheaper SaaS model.

| Class (illustrative) | May go to OpenAI/Anthropic | May go to self-hosted Llama | May be exact-cached | May be semantic-cached |
| --- | --- | --- | --- | --- |
| `unrestricted` | Yes | Yes | Yes, per route | Opt-in per route |
| `contractual_saas_ok` (DPA in place, no training) | Yes, listed vendors only | Yes | Yes | Opt-in, same vendor rules |
| `no_egress` | **No** | Yes | Yes, **Llama-only namespace** | Opt-in, **on-prem embed only** |
| `forbidden_to_log` | Policy-specific | Policy-specific | **No** (or ciphertext with team-held keys — not v1) | **No** |

Pinning is on the **team** and may be overridden **stricter** on a route, never weaker without a logged exception.

SaaS: treat prompts as leaving the company's control the moment the adapter writes to the public API. "Zero data retention" product options, if purchased, are **contract + vendor config**, not a gateway feature. The gateway should still prefer them when the company has paid for them; it cannot verify retention from the HTTP path.

## Identity and Access Management

**Calling teams:** each team has a **distinct service identity** (mTLS client cert, workload identity, or rotated service token issued by the company IdP). A shared static `GATEWAY_KEY` for all five teams is rejected: it makes budget attribution a honor system and makes revocation a company-wide outage.

Authorization: identity → `team_id` → routes that identity may call. A team cannot set another team's `team_id` in a header and have it believed.

**Operator identity:** separate, human, SSO + MFA, for changing caps, fallback tables, and price tables. Config changes are audited. Production provider keys are not readable back from the admin UI in plaintext.

**The gateway's origin identities:**

| Secret | Held by | Used for |
| --- | --- | --- |
| OpenAI API key (and/or Azure keys) | Gateway secret store | Adapter |
| Anthropic API key | Gateway secret store | Adapter |
| Llama cluster credential / mTLS | Gateway secret store | Adapter |
| Redis/Postgres credentials | Gateway runtime | Ledger and cache |
| Optional embedding provider key | Gateway | Semantic path only |

Teams **do not** receive origin keys. Cutover includes **rotating** the old shared keys so leftover notebooks die. If rotation is skipped, [Business Rule 5](./01_business_overview.md#business-rules) is theater.

**Blast radius if the gateway origin key leaks:** unbounded spend until revoked, plus generation in the company's name. Mitigations: vendor-side spending caps **in addition to** the ledger (ask; they are coarse but real); anomaly alerts on spend velocity; short rotation runbook. The internal ledger cannot stop a stolen key used **against the vendor directly**. That is why leftover team-held keys must be rotated at cutover.

## Cache and Prompt Stores as Datastores

Exact-match cache entries contain **response text** and are keyed by a hash of **prompt text**. Anyone who can read Redis can reconstruct popular Q&A and, if values store prompts too, the prompts themselves. Design choices:

- Store **response** in cache; keep prompt only as hash at the cache layer if possible. (Semantic cache **cannot** do this — it needs a vector of the prompt, and usually stores text for debugging. That is another reason it is gated.)
- **Namespace by team_id and data-handling class.** No cross-team exact hits by default (even if the hash collides across teams, do not serve). Shared "global FAQ" cache is an explicit route setting, not the default — and never for `no_egress` mixed with `unrestricted`.
- Encryption at rest: whatever the company's Redis/Postgres standard is. New crypto theater is not required; **access control and retention** are.
- Retention: cache TTL is a security control, not only a freshness control. Audit logs that store full prompts follow the company's log-retention and DLP rules; default should **not** be "log every prompt at info forever."
- Embeddings: same ACL as prompts. Deleting a team's data means deleting vectors, not only SQL rows.

Operators debugging a "wrong cache hit" will want to see the prompt. That access is **break-glass**, logged, not a world-readable Kibana field.

## Audit Logging

Every request writes an audit event: who (team identity), when, route, models requested/served, cache status, token/cost figures, error class, request id. This is for FinOps disputes, security review, and "which app ran up the bill at 3am."

Payload (prompt/completion) storage is a **separate, stricter** stream:

- Default: hash + size + PII-scanner hook if the company has one; full body only if the team/route requires replay.
- If full bodies are stored: encryption, retention limit, access log, no secondary copies into a data warehouse "for analytics" without a review.

Invoice-vs-ledger reconciliation is a scheduled job. Persistent drift is an incident (bypass, usage parse bug, or unconfirmed timeouts).

## Multi-Tenant Isolation

Five teams share one gateway and one Llama pool. Isolation that actually matters:

| Resource | Isolation |
| --- | --- |
| Dollar budget | Per-team ledger ([ADR-001](./04_architecture_decision_records.md#adr-001)) |
| Origin TPM | Shared vendor cap; **optional** per-team fraction so batch cannot starve interactive ([System Design §5.2](./03_system_design.md#52-per-team-origin-fairness-optional-but-recommended)) |
| Llama GPUs | Per-team `max_in_flight` ([ADR-005](./04_architecture_decision_records.md#adr-005)) |
| Cache | Per-team (and per-class) namespace |
| Config | Team cannot edit another team's cap or pin |
| Logs | Team-scoped access for their own prompts; operators see all under policy |

Noisy neighbor on **gateway CPU** is possible but usually secondary to origin limits. Admission control ([System Design §5.4](./03_system_design.md#54-gateway-admission)) is the backstop.

A breaker open on OpenAI is **shared pain** (all teams lose that model). That is physically true of the vendor. Do not fake per-team vendor health.

## Network Exposure

- Gateway listens on the **internal** network (private ALB, mesh, VPN). Not a public `api.` hostname unless there is a product reason, which this scenario does not have.
- Egress: to OpenAI, Anthropic, Llama, IdP, Redis, Postgres, telemetry. Llama should be private network, not "Llama but via the public internet with a bearer token" if that can be avoided.
- No team network path to origin keys other than through the gateway.

## Abuse and Runaway Generation

The ledger stops unbounded **dollars** (approximately). It does not stop:

- A team sending customer PII to SaaS in violation of class (need DLP/scanners or training; v1 documents the gap).
- Prompt-injection in the **calling application's** user input causing tool use — out of scope.
- A loop of cheap requests that burns TPM and Llama concurrency without much money (rate limits and per-team concurrency, not dollars).

Spend-velocity alerts catch "this team just 10×'d." They are mandatory in Phase 2 even while enforcement is still soft.

## Secrets Lifecycle (brief)

- Origin keys in the existing secret manager; rotation runbook; two-person for production read if the company does that.
- Gateway service identity rotation independent of origin keys.
- Cache and DB credentials rotated on the same cadence as other production datastores.
- Decommission: wiping Redis is **not** optional if it held `no_egress` completions.

## v1 explicit gaps (do not paper over)

- No full DLP. Accidental secret-in-prompt will still reach SaaS on `unrestricted` routes.
- No cryptographic proof of vendor non-retention.
- Semantic cache, if enabled, **increases** sensitive-data copies.
- Stolen origin key used off-gateway is a vendor-side problem; rotation at cutover is the control.
