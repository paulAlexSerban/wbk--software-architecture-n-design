# prj--healthcare-dicom-regional-sync

Architecture and system design documentation for a multinational healthcare imaging fabric that must keep raw patient PII and DICOM pixel data inside the physical borders of its originating region, while still letting a specialist in another country see a study in an emergency, and still letting research consume anonymized clinical metadata globally.

Documentation-only project: no PACS, no DICOM C-STORE listener, no object-store Terraform, no viewer client lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "replicate everything so consultation is fast" trap), not a general health-information exchange. The current path is hospital SAN → nightly FTP over unstable 1 Gbps WAN → another hospital's SAN. That path loses files, delays specialists by a day, and has no enforceable answer to HIPAA or GDPR residency. The replacement is one sentence: **raw PHI and pixel data never leave the region they were created in; only de-identified metadata and short-lived, audited, ephemeral views of pixel data cross a border.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true under 100 MB–4 GB studies, 150 hospitals, burned-in pixel PII, jurisdiction-pair legal basis, and a WAN that drops mid-transfer.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the problem, the layer-by-layer fault tree of nightly FTP, what to check first, and the trap.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* the system is after the redesign: regional residency cells, a global de-identified metadata fabric, and a consultation broker that streams instead of copies.
3. Read [System Design](./_docs/03_system_design.md) for the ingestion, de-identification, consultation, cache, and archival sequences, and which entities may never leave a region.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for what that one sentence actually costs — including what it does *not* buy (instant 4 GB global views, a proof of zero PII leakage).
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is legal mapping and a DICOM PII audit, not a bucket.
