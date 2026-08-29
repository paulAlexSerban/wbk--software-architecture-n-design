# IoT Telemetry & Anomaly Platform — Security and Multi-Tenancy
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document specifies isolation, device identity, quotas as a security control, encryption, audit, and the residency question for a platform whose tenants are **external wind-farm operators** sharing infrastructure. It is not a SOC 2 binder and not a substitute for the on-farm safety case. Architecture lives in [Architecture](./02_architecture_document.md); mechanics in [System Design](./03_system_design.md). This is the isolation design those documents assume.

The defining security property: **a tenant must not read another tenant's telemetry, latest values, aggregates, alerts, or device identities — including via a missing `WHERE tenant_id` in a query, a Kafka ACL hole, or a dashboard "all farms" toggle.** A compaction incident is an availability problem. A cross-tenant read is a **customer-trust and likely contractual** incident.

## Threat Model

**In scope that a single-tenant historian does not have:**

- Tenants are **adversarial-curious** (competitors in the same industry). Assume they will fuzz the API, replay JWTs, and try device IDs they do not own.
- Devices are **physically exposed** (turbines, substations). A stolen device credential is a live producer until revoked.
- A noisy or compromised tenant can try to **starve ingest** for everyone in a region (availability as a security issue).
- Platform operators and support can see data if tools allow it. That is a **privileged-access** problem, not "we're all one company."
- Seven-year aggregates are a **long-lived copy** of operational history. Access is an audit event.

**Assumed adversaries (realistic):**

- Tenant A queries `device_id` of tenant B, or omits tenant filters in a crafted API request.
- Stolen device cert used to inject false telemetry (or saturate quota).
- Support engineer exports a Parquet partition from the wrong tenant prefix.
- Compromised gateway instance can produce as any tenant **if** tenant_id is taken from the payload. This is why tenant_id is **registry-bound** to device identity.
- Insider with Kafka consumer ACLs too broad.

**Explicit non-goals:**

- Making the turbine physically tamper-proof. That is the OEM and the farm.
- Protecting against a fully malicious platform operator with production disk access and disabled audit. Reduce blast radius (split duties, audit); do not claim otherwise.
- Per-tenant **dedicated** hardware as the default. [ADR-006](./05_architecture_decision_records.md#adr-006).
- Formal certification (ISO 27001, NERC CIP, IEC 62443) as a document this repo will issue. If the business needs those, they are a **program** that consumes this architecture; they are not this file.

## Isolation Model

**Shared infrastructure, logical isolation, mandatory tenant key.**

| Layer | Isolation mechanism |
| --- | --- |
| Device ingest | mTLS (or equivalent) device identity → registry → `tenant_id`. Payload cannot choose tenant. |
| MQTT topic | Namespace includes tenant; **authorization** checks registry match. |
| Log | Shared cluster per **region**. Produce only from gateway. Partition key includes tenant. ACLs: not per-tenant principals at 2M devices. |
| Processor state | Keyed by `(tenant_id, device_id)`. No cross-key reads on the 2s path. |
| Latest / OLAP / cold | Tenant in partition key / prefix. Query planner **injects** tenant predicate from the **session**, not from user-supplied body alone. |
| Alert endpoints | Per-tenant webhook secrets and URLs. |
| Quotas | Per-tenant and per-device. Availability isolation. |

**What "logical isolation" does not mean:** "we remembered to filter in the handler." The handler is where bugs go. Enforcement belongs in:

1. identity → tenant binding at ingest,
2. storage keys that **cannot** return another tenant's row without specifying that tenant's partition,
3. a query policy layer that rejects requests whose effective tenant ≠ token tenant,
4. automated tests that attempt cross-tenant reads as a **Phase 5 gate** (and as CI).

Row-level security in the OLAP engine is desirable. If the engine cannot enforce it, the API is the chokepoint and **must not** offer raw SQL to tenants.

## Device Identity and Provisioning (2M scale)

### Identity

- **Per-device credential**, not a farm-wide shared password. A shared farm PSK means one leaked turbine is all turbines.
- Default: **mTLS** with device certificates. MQTT username/password as a legacy exception must be **tenant-scoped, rotatable, not in firmware source control**, and still mapped 1:1 to device_id where possible.
- Certificate fields (or Kafka is not in play here — **gateway** verifies): device_id, tenant_id or a registrar ID that the registry maps to tenant. Prefer registrar ID + registry lookup so a cert re-issuance can move metadata without lying in the cert forever.

### Provisioning

- Batch bootstrap: OEM or tenant uploads a signed device list; platform issues certs or records pre-provisioned certs. Click-ops for 2M devices is not a design.
- Revocation: CRL or short-lived certs + OCSP/equivalent. At 2M devices, **short-lived certificates (hours–days) with automated renewal** beat a gigantic CRL if the device can renew. Many turbines cannot. Then: CRL/OCSP and a **gateway deny-list** (hot) for emergency revoke, replicated to all regional gateways.
- Rotation: a year-long cert on a device that cannot be touched is a realistic constraint. Document it. Emergency deny-list is then **mandatory**, not a nice-to-have.

### Registry as a security control

If the registry is down, **fail closed**: do not accept devices "with a plausible cert" without tenant binding. Better to drop ingest in a region than to accept unbound events into a shared log.

Registry data is sensitive (fleet maps). ACL it like customer data.

## Noisy Neighbor (quotas as security)

Per-tenant produce quotas are an **isolation control**, not only billing.

- Default deny unbounded ingest.
- Burst allowance for reconnect after an outage — with a **reconnect-storm** cap per device.
- Circuit breaker on schema-fail rate (poison / probe).
- Alert path reserved capacity so a bulk flood cannot delay critical alerts **for other tenants** (and for the flooding tenant's own genuine trips — still: if they flood the alert topic with self-inflicted threshold misconfig, suppression applies).

Load tests before onboarding tenant #2 (and every order-of-magnitude) must include **malicious/misconfigured tenant at 3× quota** while a victim tenant is measured against the 2s SLO.

## Query and Dashboard Access

- Tenant users authenticate via the company's IdP / tenant SSO. Tokens contain `tenant_id`.
- **No** global "superuser" dashboard for customer success that is a SQL window over OLAP without audit. Break-glass: time-boxed, ticketed, logged, impersonation banner.
- Latest-value and aggregate APIs take `device_id` / farm_id. The server **looks up** that the device belongs to the token tenant. A 404 for "not yours" vs "does not exist" is a product choice; **do not** 200 empty as if the device exists in their fleet if that leaks existence — for this industry, returning 404 for both is usually safer.
- Cold-tier audit: separate role (`compliance`). Every retrieval logged with who, tenant, range, grain.

## Encryption and Keys

**In transit:** TLS for MQTT, gRPC, API, broker internal as per platform standard. Device mTLS.

**At rest:** disk encryption on brokers, Cassandra, OLAP, object storage SSE.

**Per-tenant keys (CMEK):** cryptographically isolate so a platform disk snapshot is still tenant-wrapped.

| Approach | Honest assessment |
| --- | --- |
| **Shared platform keys** (default v1) | Operationally sane. Relies on logical isolation + access control. Standard for most SaaS at this scale. **Not** a story you tell a tenant who demanded cryptographic isolation in the contract. |
| **Per-tenant CMEK** on cold Parquet | Possible (prefix per tenant, KMS key per tenant). Operational cost: 50 tenants = 50 keys, rotation, restore. Reasonable for **cold** if contracts demand it. |
| **Per-tenant CMEK on the hot log** | Painful at 1.2M/s (envelope encryption per event or per batch, key on every consume). Do not promise this in v1 without a dedicated ADR and a throughput test. |

v1: **shared keys + strict logical isolation**; offer per-tenant KMS for **cold** as a contracted add-on. Do not market "each tenant has their own Kafka encryption domain" unless you built it.

## Audit Logging

Emit and retain (aligned with 7-year **or** a documented shorter security-audit retention if legal splits "operational aggregates" from "access logs"):

- Device auth fail, quota shed, schema reject (counts + sampled identity).
- Every **query** of aggregates/latest/cold: principal, tenant, resource, range.
- Every **break-glass** and every **alert webhook config change**.
- Dispatch attempts (safety paper trail).

Do **not** log full 50-metric payloads at info on the 1.2M/s path. That is a second firehose and a second privacy copy. Debug sampling only.

## Data Residency (open question — do not assume away)

Twelve **geographic clusters** are operational topology. They are **not automatically** twelve legal jurisdictions.

Phase 0 must get a written legal map:

- May tenant T's data leave country C?
- May **aggregates** sit in a central region if raw stays in-region?
- May **alert metadata** (device id, rule, timestamp) leave the region?

Until answered, the architecture **keeps detect + raw log in-region** (which we already need for the 2s SLO) and **may** ship rollups to a central OLAP. If legal forbids that, OLAP has a regional deployment and the "central query API" federates — a real cost and a Phase 0 fork, not a footnote. See [ADR-002](./05_architecture_decision_records.md#adr-002).

## Blast Radius and Onboarding Tenant #2

The second tenant is when isolation becomes real. Before they produce:

- [ ] Cross-tenant read tests against API, OLAP, latest, object prefixes, MQTT ACLs.
- [ ] Victim-tenant SLO test under aggressor load.
- [ ] Revoke-one-device drill: deny-list hit in all regions within documented minutes.
- [ ] Break-glass audit drill.
- [ ] Confirm no shared webhook signing secret.

Onboarding tenant #2 **before** these drills is how you discover isolation bugs with a customer attached.

## Network Exposure

- Devices connect to **regional** ingest endpoints only, not to Kafka, Cassandra, or OLAP.
- Kafka/Cassandra/OLAP are private. Query API is the public (authenticated) read surface; ingest is the authenticated write surface.
- Admin/control plane (registry, Flink UI, broker UI) is **not** on the public internet. VPN/SSO. Flink UI is a particular foot-gun; treat it as production access.

## Secrets

| Secret | Holder | Notes |
| --- | --- | --- |
| Device CA / issuing keys | Platform HSM/KMS | Highest value. Compromise = issue any device. |
| Gateway broker credentials | Gateway | Produce-only topics. |
| Tenant webhook secrets | Dispatcher | Per tenant. |
| OLAP/Cassandra credentials | API / processor | Least privilege: processor writes latest/rollups; API reads. |
| Object storage | Shipper, compaction, audit role | Prefix-constrained IAM. |

Rotation runbooks for CA and webhook secrets exist before Phase 2 sends real safety notifications.

## Residual Risk (accepted)

- Logical isolation bugs are possible; tests reduce, not eliminate.
- Shared-key at-rest encryption does not stop a platform admin.
- Stolen physical device + valid cert until deny-list: false telemetry in that device's series. Detection may fire; **integrity** of that device's data is compromised. Farm physical security is the rest.
- MQTT 3.1.1 legacy devices with weak credentials: isolate in a lower-trust ingest class, quota-tight, encourage migration.
- Cloud alerts are not the interlock. A security failure of this platform (ingest down) must not be the farm's only trip. [ADR-005](./05_architecture_decision_records.md#adr-005).
