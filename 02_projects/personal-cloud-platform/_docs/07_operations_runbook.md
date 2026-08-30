# Personal Cloud Platform — Operations Runbook

Operator-facing procedures for day-2 operations. This complements the [System Design](./03_system_design.md) (which explains *how* things work) with concrete, step-by-step checklists.

## Onboarding a New API Service (Checklist)

Mirrors the [System Design — Deploy a New API Service sequence](./03_system_design.md#sequence-diagram--deploy-a-new-api-service).

1. **Build and publish the image** to GHCR from the service's own repository/CI (outside this platform's scope).
2. **Store secrets**: in AWS Secrets Manager, create/update the entry (or entries) under `portfolio/<service-name>/*` with whatever configuration values the service needs (database URLs, API keys, etc.).
3. **Choose a subdomain**: pick `<service-name>` — it becomes both the Kubernetes namespace suffix (`api-<service-name>`) and the public subdomain (`<service-name>.<domain>`).
4. **Add the values file**: create `gitops/apps/<service-name>/values.yaml` with at minimum:
   - `serviceName`, `image.repository`, `image.tag`, `port`, `subdomain`, `resources` (requests/limits), and `secretsPath` (defaults to `portfolio/<service-name>`).
5. **Commit and push** to the GitOps repository.
6. **Watch Argo CD** (via `kubectl port-forward` or SSH-tunneled UI access) until the new Application shows `Synced`/`Healthy`.
7. **Verify**:
   - `https://<service-name>.<domain>` loads with a valid certificate (browser padlock, or `curl -v`).
   - `kubectl get externalsecret -n api-<service-name>` shows `SecretSynced`.
   - `kubectl logs` for the new pod shows a clean startup with the expected config values present.
8. **Done** — no manual `kubectl apply`, `helm install`, DNS record creation, or certificate request was needed at any step.

## Offboarding / Removing a Service

1. Delete `gitops/apps/<service-name>/` from the GitOps repository, commit, push.
2. Confirm Argo CD prunes the namespace (`kubectl get ns api-<service-name>` returns not found).
3. As a deliberate, separate step, delete the corresponding `portfolio/<service-name>/*` entries from Secrets Manager (not automatic, to avoid accidental data loss if the removal was a mistake).

## Backup and Disaster Recovery

**What is actually backed up, and where:**

| Asset                                   | Source of truth / backup mechanism                                      |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| Cluster/workload configuration           | The GitOps repository itself (Git history is the backup)                      |
| Platform add-on configuration            | The GitOps repository (`platform/` path)                                     |
| AWS infrastructure definition             | The Terraform repository/state (S3 + DynamoDB)                                |
| Application secrets                      | AWS Secrets Manager (has its own AWS-managed durability; not separately backed up) |
| Node disk (OS, container runtime state)   | Lightsail automatic snapshots (scheduled, per [Phase 4](./06_phased_implementation_plan.md#phase-4--observability-backup--hardening)) |
| Application *data* (if any service needs it) | Each service's own responsibility — must use an externally-managed store, not a node-local volume (see [Architecture Document — Data Architecture](./02_architecture_document.md#data-architecture)) |

**Recovery procedure — full node loss**:
1. Provision a replacement Lightsail instance via Terraform (same procedure as [Phase 6](./06_phased_implementation_plan.md#phase-6--conditional-scale-out-terraform-reuse), even if not scaling up — just replacing).
2. Re-run the Phase 2 cluster bootstrap procedure (k3s install, Argo CD install, the one bootstrap AWS credential, point Argo CD at the GitOps repository).
3. Let Argo CD reconcile everything — platform add-ons first (sync waves), then every workload namespace.
4. Cut the static IP/DNS over to the new node.
5. Verify every previously onboarded service is reachable again on its existing subdomain.

**Recovery procedure — single bad deploy**:
1. `git revert` the offending commit in the GitOps repository (or the offending service's `values.yaml` change) and push.
2. Argo CD reconciles back to the previous good state automatically.

## Monitoring and Alerting

Kept intentionally minimal for a single low-traffic node:

- **Node-level**: Lightsail's built-in CPU/network/status-check alarms, plus disk utilization checked periodically (or via a lightweight `node-exporter`/`metrics-server` if installed in Phase 4).
- **Cluster-level**: Argo CD's own health/sync status (an out-of-sync or degraded Application is itself a signal something needs attention).
- **Certificate expiry**: cert-manager's `Certificate` status (`Ready`) and renewal events — the wildcard certificate should never be allowed to silently expire, since it affects every service at once.
- **What pages the operator immediately** (critical): node unreachable, wildcard certificate not `Ready` within its renewal window, disk >90%.
- **What is log-only / reviewed periodically** (informational): successful Argo CD syncs, routine secret rotations, individual service pod restarts that self-resolve.

## Cost Tracking

Reviewed periodically (e.g., monthly) alongside [Phase 5](./06_phased_implementation_plan.md#phase-5--operate--onboard-remaining-portfolio-services):

- Current Lightsail bundle size and its monthly cost.
- Number of active Secrets Manager entries (roughly one per onboarded service, plus platform bootstrap secrets) and their monthly cost.
- Route 53 hosted zone fee (fixed) plus query volume (expected negligible).
- Running total compared against the budget ceiling from [Business Overview — Success Metrics](./01_business_overview.md#success-metrics).
- Node resource utilization trend compared against the [Phase 6 entry-gate thresholds](./06_phased_implementation_plan.md#phase-6--conditional-scale-out-terraform-reuse), to anticipate a scale-out event before it becomes urgent.
