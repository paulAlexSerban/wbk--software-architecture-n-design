# Personal Cloud Platform: Business Overview

## Product Vision
A single, reusable hosting platform, owned and operated by one person, that lets a portfolio of small API services (side projects, demos, case-study companion APIs) go from "code in a repo" to "live on its own HTTPS subdomain" through a single Git commit — without hand-building infrastructure for every new project.

## Business Context
- Operator: a single owner (developer/architect) — not a multi-tenant product for external customers.
- Current state: portfolio projects are hosted ad-hoc (varies per project), with no shared deployment path, no shared secrets story, and no consistent way to expose a project publicly.
- Goal: one AWS account, one small VPS running k3s, one GitOps repository that becomes the "front door" for every future portfolio API.
- Target users:
	- The owner, acting as both the platform operator and the sole "customer" onboarding new services.
	- Visitors/recruiters/collaborators who reach a portfolio API or its documentation via a public subdomain.

## Core Value Propositions
1. **Self-service onboarding**: adding a new portfolio API to the platform is a Git commit (namespace, subdomain, TLS, and secrets are all derived from one values file), not a manual runbook.
2. **Predictable, low cost**: a single small AWS Lightsail VPS covers many low-traffic services; cost scales in discrete, deliberate steps rather than per-service billing.
3. **One secrets story**: every service's configuration secrets live in AWS Secrets Manager and are synced into its namespace automatically — no secrets are ever committed to Git or typed into `kubectl` per service.
4. **Investment that survives growth**: the same Terraform codebase used to provision the first small VPS is reused, unchanged in structure, to provision a bigger one later — there is no "throwaway v1 infra."
5. **Reproducible, disposable cluster**: because all cluster state is described in Git (GitOps) and all secrets live in AWS Secrets Manager, the k3s node itself holds no unique state — it can be rebuilt from scratch on a new, bigger instance with minimal manual work.

## Success Metrics
1. **Time-to-onboard** a new API service: target is a single Git commit plus an automated sync, with no manual `kubectl apply` for the common case.
2. **Cost ceiling**: total monthly AWS spend stays within a small, fixed personal budget until an explicit, documented scale-out trigger is hit (see [Phased Implementation Plan](./06_phased_implementation_plan.md), Phase 6).
3. **Zero plaintext secrets** committed to any Git repository (GitOps repo included).
4. **Subdomain-per-service** works uniformly: every onboarded service is reachable at `https://<service-name>.<domain>` with a valid TLS certificate, with no per-service DNS record created by hand.
5. **Recoverability**: a full cluster rebuild (new node, same Terraform + GitOps repos) is a documented, rehearsed procedure, not a hypothetical.

## Business Rules
1. Every deployable unit is an "API service": a containerized HTTP service with its own Git-tracked values file, its own Kubernetes namespace, and its own subdomain.
2. A service is never deployed directly into another service's namespace; namespace-per-service isolation is non-negotiable.
3. A service's runtime secrets are never stored in the GitOps repository; they are stored in AWS Secrets Manager and pulled into the cluster by the External Secrets Operator.
4. Every publicly reachable service must be served over HTTPS with a certificate issued through the platform's shared certificate-management path — no per-service manual certificate handling.
5. Infrastructure changes to the underlying VPS (size, network, DNS) are made through Terraform, never through manual AWS console edits, so the same codebase remains valid when the platform needs to scale up.
6. The platform is explicitly scoped for low-traffic, non-critical workloads; it does not attempt to provide multi-node high availability in its initial form (see [Architecture Document](./02_architecture_document.md), Non-Functional Requirements).

## Platform Consumers ("Website Pages" equivalent)
Unlike a product with end-user pages, this platform's "surface area" is operational and per-service:
1. **Platform operator surface**: the GitOps repository (source of truth for what is deployed), the Terraform repository/state (source of truth for what infrastructure exists), and Argo CD's UI (sync/health status).
2. **Per-service public surface**: `https://<service-name>.<domain>` — whatever the onboarded API itself exposes (REST endpoints, docs, health checks).
3. **Per-service operator surface**: the service's namespace (logs, resource usage, `ExternalSecret` sync status) and its AWS Secrets Manager path (`portfolio/<service-name>/*`).
