# Software Architecture and Design Workbook

## What is this?

This repository is a structured workbook for practicing and documenting software architecture and design skills across the different modes of learning that the discipline actually requires. Architecture competence isn't built by one kind of activity — it comes from a mix of analyzing real systems, building things end to end, experimenting safely with new technology, reasoning under time pressure, and rehearsing trade-off decisions until the judgment becomes second nature.

Rather than dumping all of that into a single flat folder, this repo separates work by **intent**: what question the activity is trying to answer, and what kind of deliverable proves it was answered. Each top-level directory maps to one of five activity types — Case Study, Project, Laboratory, System Design Challenge, and Software Architecture Kata — described below, along with what distinguishes them, what they produce, and how they build on each other over time.

The goal is a portfolio that shows the full range of architectural competency: not just "I can build things" (Projects), but "I can learn from what already exists" (Case Studies), "I can de-risk the unknown" (Labs), "I can reason about scale under constraints" (System Design Challenges), and "I can make and defend a decision quickly" (Katas).

## Case Studies VS Projects VS Labs VS System Design Challenges VS Software Architecture Katas

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

### 4. System Design Challenge

A **System Design Challenge** is about reasoning through the architecture of a
system at a conceptual level, under realistic scale and reliability constraints,
without necessarily implementing it.

It answers:
* How would this system be structured to meet its requirements?
* How does it scale, stay available, and stay consistent (or choose not to)?
* What are the core components, data flows, and APIs?
* What are the bottlenecks, and how would they be mitigated?

System Design Challenges are simulation-oriented: they mimic the kind of
whiteboard/high-level design work architects do before a system is built,
usually within a fixed time box.

#### Characteristics
* Focuses on scale, reliability, latency, and data flow
* Typically time-boxed (45–90 minutes is common)
* Conceptual/high-level — little to no code
* Requires estimating capacity (QPS, storage, bandwidth)
* Emphasizes structured reasoning and communication of design choices
* Often follows a repeatable framework (requirements → estimation → high-level
  design → deep dive → bottlenecks)

#### Example Topics
* Design a URL shortener
* Design a rate limiter
* Design a distributed cache
* Design a live sports betting odds feed
* Design a notification/fan-out system at Twitter/X scale

#### Deliverables
* High-level architecture diagram
* Capacity/throughput estimations
* API and data model sketch
* Component breakdown (load balancers, caches, queues, databases)
* Written or verbal explanation of bottlenecks and mitigations

#### In Software Architecture
System Design Challenges build the specific muscle of reasoning about
**scale and distributed-systems mechanics** under time pressure — sharding,
replication, caching, partitioning, consistency models. They're narrower than a
Kata (see below) in that they're almost always about a single system's
scalability and reliability, rather than broader organizational or ambiguous
business trade-offs.

---

### 5. Software Architecture Kata

A **Software Architecture Kata** is a short, repeatable practice exercise for
making and defending an architectural decision — the way a martial arts kata
drills a technique until it becomes instinctive.

It answers:
* Given ambiguous, incomplete requirements, what would you decide and why?
* How do you justify a trade-off to stakeholders with competing priorities?
* How quickly and clearly can you produce a defensible architecture?

Katas are practice-oriented and decision-oriented rather than build-oriented or
scale-oriented: the point is rehearsing the judgment and communication, not
producing a working system or even a fully scoped design.

#### Characteristics
* Small, deliberately ambiguous problem brief (often just a paragraph)
* Time-boxed, frequently done solo or in small groups (e.g. architecture katas
  popularized by Ted Neward)
* Requirements are often contradictory, political, or under-specified on
  purpose — forcing explicit assumptions
* Emphasizes articulating and defending trade-offs, not scalability mechanics
* No implementation, often no formal capacity estimation
* Repeatable — the same kata can be redone later to compare how judgment has
  evolved

#### Example Topics
* Design a system for a company that just merged with a competitor and must
  unify two conflicting product catalogs in 6 months
* Architect a system for a client who insists on "no cloud vendors" for
  compliance reasons
* Propose an architecture for a startup that needs to ship fast now but may
  need to scale 100x in a year
* Redesign a legacy batch system as event-driven under a hard budget ceiling

#### Deliverables
* Short written or verbal architecture proposal
* Explicit list of assumptions made
* Trade-off rationale (what was optimized for, what was sacrificed)
* Optional lightweight diagram
* Retrospective notes comparing this attempt to prior attempts at the same kata

#### In Software Architecture
Katas build the muscle System Design Challenges don't: handling **ambiguity, constraints, and stakeholder trade-offs** that go beyond raw technical scale — budget, politics, timelines, compliance, team maturity. Where a System Design Challenge asks "can this handle the load?", a Kata asks "given everything messy about this situation, what's the right call, and can you defend it?"

### Core Difference

| Aspect            | Case Study             | Project               | Laboratory               | System Design Challenge       | Architecture Kata               |
| ----------------- | ---------------------- | --------------------- | ------------------------ | ----------------------------- | ------------------------------- |
| Primary Goal      | Analyze                | Build                 | Experiment               | Reason about scale            | Decide & defend                 |
| Orientation       | Retrospective          | Delivery              | Exploratory              | Simulation                    | Practice / rehearsal            |
| Main Focus        | Decisions & lessons    | Implementation        | Discovery                | Scale, reliability, data flow | Trade-offs under ambiguity      |
| Output            | Insights               | Working system        | Findings / prototype     | High-level design             | Defensible decision + rationale |
| Production Ready  | Not required           | Usually yes           | Usually no               | Not applicable (conceptual)   | Not applicable (conceptual)     |
| Scale             | Often large systems    | Any scale             | Usually small            | Usually large / distributed   | Any — often deliberately messy  |
| Risk Level        | Observational          | Managed delivery risk | Safe experimentation     | None (simulated)              | None (simulated)                |
| Time Box          | None                   | Weeks–months          | Days–weeks               | Fixed, short (~1 hr)          | Fixed, short (~1–2 hrs)         |
| Architecture Role | Trade-offs & evolution | System construction   | Feasibility & validation | Scalability reasoning         | Judgment & communication        |

### Real-World Analogy

| Concept                 | Construction Analogy                               |
| ----------------------- | -------------------------------------------------- |
| Laboratory              | Material testing facility                          |
| Project                 | Building construction                              |
| Case Study              | Post-construction analysis/report                  |
| System Design Challenge | Structural blueprint review under a deadline       |
| Architecture Kata       | Fire drill — rehearsing decisions before it's real |

### In Career Development

| Type                    | Builds                                                                    |
| ----------------------- | ------------------------------------------------------------------------- |
| Laboratory              | Curiosity, experimentation, R&D mindset                                   |
| Project                 | Delivery and engineering execution                                        |
| Case Study              | Architectural thinking and critical analysis                              |
| System Design Challenge | Scalability reasoning and structured communication                        |
| Architecture Kata       | Decisiveness under ambiguity, trade-off articulation, stakeholder empathy |

---

### Relationship Between Them

In mature engineering organizations, these often connect — and the five don't
form a single strict sequence so much as a practice loop:

Example flow:
1. **Architecture Kata**
   * Practice deciding how you'd architect a notification system under conflicting constraints (budget, compliance, timeline)
2. **System Design Challenge**
   * Reason through the same problem focused purely on scale: fan-out, throughput, delivery guarantees
3. **Laboratory**
   * Prototype the riskiest part — event-driven delivery with Kafka 
4. **Project**
   * Build the production notification system using what the lab validated 
5. **Case Study**
   * Analyze the migration outcomes, bottlenecks, failures, and scaling lessons once it's running in production

Katas and Challenges are cheap and repeatable, so they're often used continuously to sharpen judgment — not just once at the start of this flow.

---

### Real-World Analogy

| Concept                 | Construction Analogy                               |
| ----------------------- | -------------------------------------------------- |
| Laboratory              | Material testing facility                          |
| Project                 | Building construction                              |
| Case Study              | Post-construction analysis/report                  |
| System Design Challenge | Structural blueprint review under a deadline       |
| Architecture Kata       | Fire drill — rehearsing decisions before it's real |

### In Career Development

Each develops different competencies.

| Type                    | Builds                                                                    |
| ----------------------- | ------------------------------------------------------------------------- |
| Laboratory              | Curiosity, experimentation, R&D mindset                                   |
| Project                 | Delivery and engineering execution                                        |
| Case Study              | Architectural thinking and critical analysis                              |
| System Design Challenge | Scalability reasoning and structured communication under time pressure    |
| Architecture Kata       | Decisiveness under ambiguity, trade-off articulation, stakeholder empathy |

Senior engineers and architects usually need all five. A strong portfolio might contain:
* Labs for emerging tech exploration
* Projects showing delivery capability
* Case studies showing architectural reasoning and reflection
* System Design Challenges showing structured scalability thinking under time pressure
* Architecture Katas showing decisiveness and trade-off communication under ambiguity
