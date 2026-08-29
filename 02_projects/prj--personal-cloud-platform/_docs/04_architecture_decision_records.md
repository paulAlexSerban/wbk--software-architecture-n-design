# Architecture Decision Records

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: k3s on a Single Lightsail VPS vs. Managed Kubernetes (EKS)

**Status**: Accepted

**Context**: The platform hosts a small number of low-traffic personal/portfolio API services for a single operator. Managed Kubernetes (EKS) provides HA control planes, IRSA, and a large ecosystem, but carries a meaningfully higher fixed monthly cost and operational surface (VPC design, node groups, control-plane networking) that is disproportionate to the workload.

**Decision**: Run k3s (a lightweight, single-binary Kubernetes distribution) on a single AWS Lightsail VPS. Accept a single point of failure at the node level as an explicit, documented trade-off.

**Consequences**:
- (+) Materially lower cost than EKS for this scale.
- (+) Simple mental model: one node, one place to look.
- (+) k3s ships a usable ingress controller (Traefik) out of the box, reducing add-on count.
- (–) No control-plane or node HA; an outage requires a rebuild (mitigated by treating the node as disposable — see [ADR-002](#adr-002) and the [Operations Runbook](./07_operations_runbook.md)).
- (–) Lightsail does not support IAM instance roles, which shapes the secrets-bootstrap design ([ADR-004](#adr-004)).
- **Revisit trigger**: sustained multi-service, higher-traffic use, or a requirement for real HA — see [Phased Implementation Plan — Phase 6](./06_phased_implementation_plan.md#phase-6--conditional-scale-out-terraform-reuse).

## ADR-002: Terraform Scoped to Lightsail + Route 53 Today, Reused Unchanged for Scale-Out

**Status**: Accepted

**Context**: The platform will need a bigger VPS at some point as more services are onboarded. A common anti-pattern is writing throwaway, manually-clicked infrastructure for "v1" and only introducing IaC when a rewrite happens for "v2."

**Decision**: Provision all AWS infrastructure — Lightsail instance, static IP, firewall rules, Route 53 zone/records, and the Terraform state backend itself — via Terraform from the very first deployment, with the instance bundle size expressed as a variable rather than hardcoded.

**Consequences**:
- (+) The exact same module structure provisions the future, larger instance; scaling up is "change a variable and apply," not "write new IaC."
- (+) Infrastructure drift is avoided since there is no manual AWS console usage for anything Terraform owns.
- (–) Because Lightsail instances cannot be resized in place, a scale-up event is still a create-new/cutover/destroy-old operation, not a simple in-place resize — this is a Lightsail platform limitation, not a Terraform limitation, and is documented explicitly in [System Design](./03_system_design.md#1-terraform-layout).
- **Revisit trigger**: if the platform ever needs multiple nodes or EKS, a *new* Terraform root module would be introduced alongside (not instead of) this one, since the resource types differ fundamentally.

## ADR-003: GitOps (Argo CD + ApplicationSet) as the Self-Service Deployment Mechanism

**Status**: Accepted

**Context**: The platform must let the operator "deploy any API service to a specific namespace and assign it a new subdomain." Two realistic mechanisms were considered: (a) a CI pipeline that runs `helm upgrade` directly against the cluster using a kubeconfig/SSH credential, or (b) a GitOps controller (Argo CD) running inside the cluster that reconciles state from a Git repository.

**Decision**: Use Argo CD with an `ApplicationSet` git-directory generator watching an `apps/` folder. Onboarding a service is adding a folder + `values.yaml` and pushing to Git; Argo CD does the rest.

**Consequences**:
- (+) No cluster-admin credential needs to leave the cluster (no kubeconfig stored in CI); Argo CD pulls, nothing pushes in from outside.
- (+) The Git repository is a complete, reviewable audit trail of every change ever made to the cluster.
- (+) Self-healing: if someone manually changes something in the cluster, Argo CD's next reconciliation reverts it, keeping Git authoritative.
- (–) Slightly higher upfront setup cost (installing and bootstrapping Argo CD itself) than a simple CI script.
- (–) Adds one more platform component (Argo CD) that itself needs to be kept healthy.
- **Alternative rejected**: CI-push `helm upgrade` — simpler to start, but requires a long-lived cluster credential in CI and provides no built-in drift detection or self-healing.

## ADR-004: Access-Key-Based ESO Bootstrap (Interim) vs. IRSA

**Status**: Accepted (interim), with a documented migration trigger

**Context**: External Secrets Operator (ESO) needs AWS credentials to read Secrets Manager. The AWS-recommended pattern is IAM Roles for Service Accounts (IRSA), which eliminates static keys entirely — but IRSA requires an OIDC-federated cluster (natively available on EKS). AWS Lightsail instances **do not support attaching IAM instance roles/profiles** (confirmed against current AWS Lightsail documentation: this is an EC2/EKS-only capability), so the IRSA path is not directly available on a bare Lightsail-hosted k3s node.

**Decision**: Bootstrap ESO with a single, narrowly-scoped IAM user access key (`secretsmanager:GetSecretValue` / `DescribeSecret` on `portfolio/*` only), stored as exactly one Kubernetes `Secret` created during cluster bootstrap. Every other credential in the system (Route 53 credentials for cert-manager, every service's application secrets) flows through Secrets Manager and is synced out by this one ESO instance — no additional static keys are introduced anywhere else.

**Consequences**:
- (+) Only one static credential exists in the entire system; its blast radius is limited to read-only access to one Secrets Manager path prefix.
- (+) Every other credential (Route 53, app secrets) is centrally managed and rotated in Secrets Manager, not scattered across manually-created Kubernetes secrets.
- (–) A static, long-lived credential still exists and must be rotated manually on a defined schedule (see [Security Architecture](./05_security_architecture.md)).
- **Revisit/migration trigger**: if the platform migrates to EKS (see [ADR-001](#adr-001) revisit trigger), replace this bootstrap key with IRSA as the very first step of that migration.

## ADR-005: Wildcard DNS + Shared Wildcard TLS Certificate vs. Per-Service DNS/TLS Automation

**Status**: Accepted

**Context**: Each onboarded service needs its own subdomain and a valid TLS certificate. Two designs were considered: (a) per-service automation — a controller like ExternalDNS creates a DNS record per service, and cert-manager issues a separate certificate per service/namespace; or (b) a single wildcard DNS record and a single shared wildcard TLS certificate, replicated into each namespace.

**Decision**: Provision one wildcard DNS record (`*.{{ domain }}`, via Terraform) and one wildcard TLS certificate (via cert-manager + Route 53 DNS-01), replicated into every workload namespace by Reflector.

**Consequences**:
- (+) Onboarding a service never waits on a DNS propagation step or an ACME issuance transaction — both already exist before the service is created.
- (+) Minimizes Let's Encrypt API usage to one renewal every ~60–90 days regardless of service count, avoiding any rate-limit concern even as more services are added.
- (+) Removes the need for an ExternalDNS controller, since there is only one target IP for the whole platform (a single node).
- (–) All services share one certificate; a compromise of that certificate's private key affects every subdomain simultaneously (mitigated by standard Kubernetes RBAC/secret-access controls; acceptable given the platform's non-critical, personal-scale scope).
- (–) If the platform ever has multiple distinct target IPs (e.g., a future multi-node/load-balanced setup), the wildcard-to-one-IP assumption breaks and ExternalDNS-style per-service DNS becomes necessary.
- **Alternative rejected**: per-service certificates — architecturally more "standard" and better isolated, but adds latency and ACME-rate-limit exposure to every onboarding operation at no real benefit for this scale.
