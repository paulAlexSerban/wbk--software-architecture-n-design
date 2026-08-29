# prj--llm-hallucination-detection

Architecture and system design documentation for detecting when an LLM is hallucinating in production, at scale, **without a gold answer for every request**.

Documentation-only project: no detector code, no sampling client, no NLI model, no dashboard lives here. This is the design specification a build phase would implement against.

The defining constraint is epistemic, not engineering taste. Hallucination is not a binary label the model emits. It is a **family of failure modes** — fabricated facts, unfaithful use of retrieved context, confident nonsense, quietly wrong citations — and in production there is almost never a ground-truth answer sitting next to the response. "Ask another LLM to check" is not a detector: it is a second sample from a correlated error distribution, at 2× cost. The system is therefore not a judge. It is a **tiered ensemble of proxy signals** (calibrated confidence, self-consistency, entailment against retrieved sources) that produces a **risk score**, not a verdict, and an **action policy** whose false-positive cost is paid by the product, not by the architecture diagram.

## Docs

- [Business Overview](./_docs/01_business_overview.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Business Overview](./_docs/01_business_overview.md) for why "no ground truth at scale" is the actual requirement, why a second LLM is not the answer, and why a small labeled sample is still unavoidable.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built and *why* it is an ensemble of proxies with two capability envelopes (grounded vs. ungrounded) and two cost tiers (inline vs. audit).
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": claim decomposition, sampling, entailment, calibration, the risk ensemble, the action policy, and the feedback loop.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for the answers this scenario actually asks for: which signals are blind to which hallucinations, what false positives cost, and what this system will never be able to claim.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — including the kill criteria for the whole program.
