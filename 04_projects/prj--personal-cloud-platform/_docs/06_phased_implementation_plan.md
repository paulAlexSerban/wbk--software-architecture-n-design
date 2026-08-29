# Personal Cloud Platform — Phased Implementation Plan

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. Phases 0–5 are sequential; Phase 6 is conditional and may never trigger, or may trigger repeatedly over the platform's lifetime.

## Phase 0 — Foundations

**Objective**: Establish the AWS account hygiene, Terraform state backend, and repositories the rest of the platform depends on.

**Deliverables**:
- AWS account with MFA-protected operator identity (separate from any platform bootstrap identity).
- Terraform `bootstrap/` configuration applied once (S3 state bucket + DynamoDB lock table), per [System Design](./03_system_design.md#1-terraform-layout).
- Domain delegated to AWS Route 53 (name servers updated at the registrar).
- Two Git repositories created: the GitOps repository (`gitops/`) and, if kept separate, the shared Helm chart repository.
- Bootstrap IAM users planned and documented (not yet created with real permissions) per [Security Architecture](./05_security_architecture.md#identity-and-access-management-iam).

**Exit Gate**:
- [ ] Terraform remote state backend is live and reachable.
- [ ] Route 53 hosted zone exists and domain resolution has propagated (verified with a DNS lookup tool).
- [ ] GitOps and chart repositories exist with initial empty structure committed.

## Phase 1 — Core Infrastructure (Terraform)

**Objective**: Provision the compute, networking, and DNS records the platform runs on.

**Deliverables**:
- Terraform `infra/` module applied: Lightsail instance (initial small bundle), static IP attached, firewall restricted to 22/80/443 with SSH source-restricted to the operator's IP.
- Route 53 apex and wildcard (`*.domain`) A records pointing at the static IP.

**Exit Gate**:
- [ ] SSH access to the instance works from the operator's machine only.
- [ ] `dig`/`nslookup` for both the apex domain and an arbitrary test subdomain resolve to the static IP.
- [ ] `terraform plan` against the applied state shows no drift.

## Phase 2 — Cluster Bootstrap

**Objective**: Bring up k3s and every platform add-on, ending with a healthy, secrets-and-TLS-capable cluster with nothing onboarded yet.

**Deliverables** (see [System Design — Cluster Bootstrap sequence](./03_system_design.md#sequence-diagram--cluster-bootstrap)):
- k3s installed on the node.
- Argo CD installed and pointed at the GitOps repository's `platform/` app-of-apps.
- The single bootstrap AWS credential (`eso-secrets-reader`) created and stored as a Kubernetes `Secret`.
- External Secrets Operator, cert-manager, and Reflector all reconciled by Argo CD.
- The shared wildcard TLS certificate issued and present in the platform namespace.

**Exit Gate**:
- [ ] Argo CD reports the platform `app-of-apps` and every child Application as `Synced`/`Healthy`.
- [ ] A test `ExternalSecret` successfully resolves a value from Secrets Manager.
- [ ] The wildcard `Certificate` resource shows `Ready: True`.
- [ ] `kubectl` access works only via SSH tunnel/local kubeconfig — confirmed the API server is not reachable from the public internet.

## Phase 3 — Self-Service Deployment Pipeline

**Objective**: Prove the entire "deploy any API service to a namespace + subdomain" mechanism end-to-end with one real service.

**Deliverables** (see [System Design — Deploy a New API Service sequence](./03_system_design.md#sequence-diagram--deploy-a-new-api-service)):
- The shared `service-api` Helm chart authored and published/referenced from the GitOps repository.
- The `ApplicationSet` git-directory generator watching `apps/*` deployed and reconciled.
- One real service (e.g. `hello-api`) onboarded purely by adding `apps/hello-api/values.yaml` and pushing.

**Exit Gate**:
- [ ] `https://hello-api.<domain>` is publicly reachable with a valid TLS certificate.
- [ ] `hello-api`'s namespace has a successfully synced `ExternalSecret` sourced from its own `portfolio/hello-api/*` path.
- [ ] Onboarding required **zero** manual `kubectl apply`/`helm install` commands — only the Git commit.
- [ ] Removing `apps/hello-api/` from Git results in Argo CD pruning the namespace cleanly.

## Phase 4 — Observability, Backup & Hardening

**Objective**: Make the platform operable day-to-day and rehearse recovery before it holds anything important.

**Deliverables**:
- Lightweight metrics/log visibility appropriate for a single node (see [Operations Runbook](./07_operations_runbook.md#monitoring-and-alerting)).
- Lightsail automatic snapshot schedule enabled.
- Default-deny `NetworkPolicy` and `ResourceQuota` applied consistently across all workload namespaces via the shared chart.
- Alerting configured for node-level failure conditions (disk pressure, node unreachable, certificate nearing expiry).

**Exit Gate**:
- [ ] A simulated failure (e.g., stopping a critical pod, or filling disk in a test namespace) produces a visible alert.
- [ ] A full snapshot-restore drill is executed at least once and documented with actual timings.
- [ ] `kubectl describe networkpolicy` confirms default-deny is active in every workload namespace.

## Phase 5 — Operate & Onboard Remaining Portfolio Services

**Objective**: Repeat the proven Phase 3 pattern for every remaining portfolio service, while tracking capacity against the Phase 6 trigger thresholds.

**Deliverables**:
- Each additional service onboarded following the [Operations Runbook](./07_operations_runbook.md#onboarding-a-new-api-service-checklist).
- A running capacity/cost tracking note (node CPU/memory/disk trend, monthly AWS bill, service count) reviewed periodically.

**Exit Gate** (recurring, re-checked after each new onboarding):
- [ ] Node resource headroom remains comfortably above the Phase 6 trigger thresholds (see below).
- [ ] Monthly AWS cost remains within the budget ceiling defined in [Business Overview — Success Metrics](./01_business_overview.md#success-metrics).

## Phase 6 — Conditional Scale-Out (Terraform Reuse)

**Objective**: Provision a bigger Lightsail instance using the *same* Terraform codebase, the moment (and only when) defined thresholds are breached — this phase is the payoff of investing in Terraform + GitOps from day one (see [ADR-002](./04_architecture_decision_records.md#adr-002)).

**Entry Gate (trigger conditions — any one of)**:
- [ ] Sustained node CPU utilization > 70% for a defined observation window.
- [ ] Sustained node memory utilization > 80%.
- [ ] Node disk utilization > 75%.
- [ ] A new service cannot be scheduled due to insufficient allocatable resources (a hard capacity wall, not just a soft threshold).

**Deliverables**:
- `instance_bundle_id` variable updated in Terraform; `terraform apply` provisions a new, larger Lightsail instance.
- k3s and Argo CD re-bootstrapped on the new node (Phase 2 procedure, repeated).
- Argo CD reconciles the entire GitOps repository against the new node, recreating every platform add-on and every onboarded service from scratch.
- Static IP/DNS cut over to the new node.
- Old instance decommissioned via Terraform (removed from state, resource destroyed) only after the new node is confirmed healthy.

**Exit Gate**:
- [ ] All previously onboarded services are reachable on their existing subdomains from the new node with no changes to any service's `values.yaml`.
- [ ] The old instance is fully decommissioned and no longer billed.
- [ ] The Terraform codebase required **no structural changes** — only the bundle-size variable — confirming the [ADR-002](./04_architecture_decision_records.md#adr-002) design goal held true in practice.

This phase can recur any number of times over the platform's life; each recurrence should be at least as fast as the first, since the procedure is identical.
