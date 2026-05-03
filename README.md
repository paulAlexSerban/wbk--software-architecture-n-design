# Software Architecture and Design Workbook

## Use Git Submodules
- cd to path where you want to add the submodule
- clone submodule reposiory if not already cloned
- check if submodule exists: `git submodule status` and check .gitmodules file
- clone future submodule repository if not already cloned: `git clone <repository-url>` - to clone the submodule repository
- add submodule: `git submodule add <repository-url> <path>` - to add a new submodule - the path is the pathe where the previous command cloned the repository
- update submodule: `git submodule update --remote --merge` - to update the submodule to the latest commit
- initialize submodule: `git submodule init` - to initialize the submodule
- clone submodule: `git submodule update --init --recursive` - to clone the submodule
- remove submodule: `git rm --cached <path>` - to remove the submodule from the repository
- commit changes: `git commit -m "Updated submodule"` - to commit the changes
- push changes: `git push` - to push the changes to the remote repository

## Case Studies

- [Async File Processing - Payment Processing Pipeline (PayRawl)](./case-studies/async%20file%20processing%20-%20payment%20processing%20pipeline%20-%20PayRawl/architecture-document.md)
- [Data Collection App - Web App (GroceColl)](./case-studies/data%20collection%20app%20-%20web%20app%20-%20grocecoll/architecture-document.md)
- [HR Managemenr (Dunderly)](./case-studies/hr%20management%20-%20web%20app%20-%20Dunderly/architecture-document.md)
- [Telemetry Monitoring System - Auto (Mascar.auto)](./case-studies/iot%20telemetry%20monitoring%20-%20Mascar.auto/architecture-document.md)
- [Telemetry Monitoring System - SAAS (IOToo)](./case-studies/iot%20telemetry%20monitoring%20-%20sass%20-%20IOToo/architecture-document.md)

## To Do's

- [ ] build-up the AKM (architecture knowledge map) for each case study
- [ ] synthesize all requirements into ASRs (architecturally significant requirements)
- [ ] based on ASRs, identify key architectural drivers and write ADRs (architecture decision records)

## Case Studies VS Projects VS Labs

In software engineering and software architecture, these three are related but serve very different purposes.

### 1. Case Study
A **case study** is primarily about analysis, reasoning, and learning from a real or simulated situation.

It answers questions like:
* What problem existed?
* Why did it happen?
* What decisions were made?
* What trade-offs existed?
* What worked and what failed?
* What lessons were learned?

A case study is usually retrospective and analytical.

#### Characteristics
* Focuses on decision-making and outcomes
* Heavy on context and constraints
* Can analyze existing systems
* Often includes architecture diagrams, incidents, bottlenecks, business requirements
* Usually documentation-oriented rather than implementation-oriented

#### Example Topics
* “Migrating a monolith to microservices at Netflix”
* “Scaling a betting platform during live sports events”
* “Why a distributed cache caused data inconsistency”
* “Architecture evolution of Uber’s dispatch system”

#### Deliverables
* Analysis document
* Architecture review
* Trade-off discussion
* Lessons learned
* Timeline of events
* Root cause analysis

#### In Software Architecture
Case studies are extremely valuable because architecture is mostly about:
* constraints
* trade-offs
* system evolution
* operational reality

Architecture maturity often comes from studying failures and compromises, not only building greenfield systems.

### 2. Project

A **project** is about building and delivering something.

It answers:
* What are we building?
* How do we implement it?
* How do we deploy it?
* How do we validate it?

Projects are execution-oriented.

#### Characteristics

* Has goals, scope, deadlines
* Produces a working system or artifact
* Includes implementation
* Requires coordination and delivery
* Usually includes planning, development, testing, deployment

#### Example Topics
* Build a MERN eCommerce platform
* Develop a Kubernetes deployment pipeline
* Create a casino game backend
* Implement OAuth2 authentication system

#### Deliverables
* Source code
* Infrastructure
* Documentation
* CI/CD pipeline
* Deployment
* Tests
* Working software

#### In Software Engineering
Projects demonstrate:
* engineering ability
* delivery capability
* implementation skill
* collaboration
* maintainability practices

---

### 3. Laboratory (Lab)
A **laboratory** is focused on experimentation, exploration, and controlled learning.

It answers:
* What happens if we try this?
* How does this technology behave?
* Can this approach work?
* What are the limits?

Labs are discovery-oriented.

#### Characteristics
* Experimental
* Small-scale
* Often isolated
* Safe environment for testing ideas
* No expectation of production readiness
* Used for prototyping or validation

#### Example Topics
* Experiment with event sourcing using Kafka
* Test latency differences between REST and gRPC
* Explore Terraform state management strategies
* Benchmark Redis vs Memcached
* Prototype AI-based UI automation

#### Deliverables
* Prototype
* Benchmarks
* Experiment results
* Findings
* Proof of concept (PoC)
* Technical notes

#### In Software Architecture
Labs are critical because architects often need:
* validation before commitment
* risk reduction
* technology evaluation
* feasibility analysis

Good architects usually prototype aggressively before making large architectural decisions.

---

### Core Difference

| Aspect            | Case Study             | Project               | Laboratory               |
| ----------------- | ---------------------- | --------------------- | ------------------------ |
| Primary Goal      | Analyze                | Build                 | Experiment               |
| Orientation       | Retrospective          | Delivery              | Exploratory              |
| Main Focus        | Decisions & lessons    | Implementation        | Discovery                |
| Output            | Insights               | Working system        | Findings / prototype     |
| Production Ready  | Not required           | Usually yes           | Usually no               |
| Scale             | Often large systems    | Any scale             | Usually small            |
| Risk Level        | Observational          | Managed delivery risk | Safe experimentation     |
| Architecture Role | Trade-offs & evolution | System construction   | Feasibility & validation |

---

### Relationship Between Them

In mature engineering organizations, these often connect.

Example flow:

1. **Laboratory**
   * Prototype event-driven architecture with Kafka

2. **Project**
   * Build production notification system using Kafka

3. **Case Study**
   * Analyze migration outcomes, bottlenecks, failures, and scaling lessons

This is actually how strong engineering cultures evolve.

---

### Real-World Analogy

| Concept    | Construction Analogy              |
| ---------- | --------------------------------- |
| Laboratory | Material testing facility         |
| Project    | Building construction             |
| Case Study | Post-construction analysis/report |

---

### In Career Development

Each develops different competencies.

| Type       | Builds                                       |
| ---------- | -------------------------------------------- |
| Laboratory | Curiosity, experimentation, R&D mindset      |
| Project    | Delivery and engineering execution           |
| Case Study | Architectural thinking and critical analysis |

Senior engineers and architects usually need all three.

A strong portfolio might contain:

* Labs for emerging tech exploration
* Projects showing delivery capability
* Case studies showing architectural reasoning and reflection
