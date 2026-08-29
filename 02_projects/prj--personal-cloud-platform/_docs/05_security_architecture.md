# Personal Cloud Platform — Security Architecture

This document specifies the platform's network exposure, identity/access boundaries, namespace isolation, and secrets lifecycle. It is scoped to a single-operator, low-traffic, non-critical platform (see [Business Overview](./01_business_overview.md)) — controls are chosen to be proportionate to that risk level, not to compliance-driven enterprise requirements.

## Network Exposure

**Lightsail firewall (instance public ports) — the only ports open to the internet:**

| Port | Protocol | Source                          | Purpose                                   |
| ---- | -------- | -------------------------------- | ------------------------------------------ |
| 22   | TCP      | Operator's IP/CIDR only (not `0.0.0.0/0`) | SSH administration                        |
| 80   | TCP      | Any                               | HTTP → HTTPS redirect, ACME HTTP-01 fallback if ever needed |
| 443  | TCP      | Any                               | HTTPS ingress traffic (Traefik)            |

**Explicitly not exposed publicly:**
- The Kubernetes API server (port 6443): reachable only over SSH tunnel or a WireGuard/VPN-style connection from the operator's machine — never opened on the Lightsail firewall. `kubectl` access from a local machine is via a tunneled kubeconfig, not a direct public endpoint.
- Any internal platform component (Argo CD UI, cert-manager, ESO) — reached via `kubectl port-forward` or an internal-only Ingress rule bound to a non-guessable path/host, not a public DNS entry, unless the operator explicitly decides otherwise for convenience (documented as a deliberate, reviewed exception if taken).

## Identity and Access Management (IAM)

Every AWS identity the platform uses is scoped to the minimum actions and resources it needs. There are exactly two AWS IAM identities created for platform bootstrap (see [System Design — Secrets Flow](./03_system_design.md#5-secrets-flow-and-bootstrap-sequencing)):

| Identity                     | Used by                          | Permissions                                                                 | Resource scope                                              |
| ----------------------------- | --------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `eso-secrets-reader`          | External Secrets Operator          | `secretsmanager:GetSecretValue`, `secretsmanager:DescribeSecret`               | `arn:aws:secretsmanager:<region>:<account-id>:secret:portfolio/*` |
| `dns01-route53-writer`        | cert-manager (via a secret synced by ESO, never typed by hand) | `route53:ChangeResourceRecordSets`, `route53:ListResourceRecordSets`, `route53:GetChange` | The single hosted zone ID for the platform's base domain only    |

**Why not IRSA**: AWS Lightsail instances cannot attach IAM instance roles/profiles — this is documented, current AWS behavior, not an oversight. IRSA (the AWS-recommended, keyless pattern) requires an OIDC-federated cluster such as EKS. This platform's interim design is documented and justified in [ADR-004](./04_architecture_decision_records.md#adr-004), with an explicit migration trigger if the platform ever moves to EKS.

**Operator-level IAM** (for running Terraform and managing the AWS account itself) is a separate, higher-privilege identity used only from the operator's own machine, protected by MFA — this identity is never placed on the Lightsail node or in the cluster.

## Namespace Isolation

Every onboarded service gets:
- Its **own namespace** (`api-<service-name>`), created automatically by Argo CD when the service is onboarded (see [System Design](./03_system_design.md#3-gitops-repository-layout)).
- A **`ResourceQuota`** limiting CPU/memory requests and limits, and object counts, so one misbehaving service cannot starve the shared node.
- A **default-deny `NetworkPolicy`**, with explicit allow rules only for: ingress from Traefik (so the service is reachable), egress to cluster DNS, and egress to the internet if the service needs outbound calls (opt-in per service via its `values.yaml`, not on by default).
- Its **own `ExternalSecret`**, scoped to read only its own `portfolio/<service-name>/*` path — one service's `ExternalSecret` cannot be pointed at another service's secrets path (enforced by convention in the shared Helm chart, which derives the path from the service name rather than accepting an arbitrary path value).

## Platform Add-on Access Control

- **Argo CD**: single admin account, local login only (no public exposure by default, see [Network Exposure](#network-exposure)); credential stored outside Git. SSO/OIDC login is a documented future enhancement, not required at this scale.
- **GHCR image pulls**: a single read-only GHCR pull token, stored as a Kubernetes `imagePullSecret`, itself sourced from Secrets Manager via ESO rather than committed to the GitOps repository.
- **cert-manager / Reflector / ESO**: run with the minimum Kubernetes RBAC each upstream Helm chart requires by default; no additional cluster-admin bindings are granted beyond what those charts ship with.

## Secrets Lifecycle

- **Rotation**: the one long-lived AWS access key (`eso-secrets-reader`) is rotated on a defined schedule (recommended: every 90 days, or immediately on suspected compromise). Rotation is a two-step, zero-downtime process: create a new key, update the Kubernetes `Secret`, confirm ESO re-authenticates successfully, then deactivate/delete the old key.
- **No plaintext secrets in Git, ever**: this is a hard rule (see [Business Overview — Business Rules](./01_business_overview.md#business-rules)). The only secret-shaped object that exists outside AWS Secrets Manager is the one bootstrap `Secret` created directly in the cluster during initial setup, and it is never written to any file that gets committed.
- **Auditability**: AWS CloudTrail logging is enabled for the account so every `secretsmanager:GetSecretValue` and `route53:ChangeResourceRecordSets` call is attributable and reviewable after the fact.
- **Blast radius by design**: because every service's secrets live under its own `portfolio/<service-name>/*` prefix and the bootstrap credential's IAM policy is scoped to `portfolio/*` as a whole (read-only), a leaked bootstrap key exposes application secrets but not the ability to modify infrastructure, DNS, or IAM itself.

## Supply Chain

- **Images**: pulled from GitHub Container Registry (GHCR) using a read-only pull token; the platform does not build images itself (build/push happens in each service's own CI, out of scope for this platform).
- **Helm charts**: platform add-on charts (Argo CD, ESO, cert-manager, Reflector) are pinned to specific versions in the GitOps repository, upgraded deliberately rather than tracking `latest`.
- **Terraform providers/modules**: pinned versions in `infra/main.tf`, upgraded deliberately.

## Explicitly Out of Scope (for this platform's stated risk level)

- Formal compliance frameworks (SOC 2, HIPAA, GDPR-specific controls) — not applicable to a personal portfolio platform.
- Web application firewalling / DDoS protection beyond what Route 53 + Lightsail provide by default.
- Multi-tenant isolation guarantees beyond namespace-level (this platform has one trusted operator onboarding all services; it is not designed to safely host untrusted third-party workloads).
