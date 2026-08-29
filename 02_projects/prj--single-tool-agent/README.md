# prj--single-tool-agent

Architecture and system design documentation for the interview scenario: an LLM agent that calls **one** external tool via function calling — plan → call tool → observe → respond — then someone says the design is "wire up the tool schema, run whatever `tool_calls` the model emits, feed the result back, done." You have to say what the loop actually is, and what function calling does not guarantee.

Documentation-only project: no SDK client, no tool executor, no agent runtime, and no chat UI lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "function-calling-is-the-loop trap"), not a general agent platform. Scope is one tool (`get_order_status(order_id)` against an internal orders DB), one caller identity, a bounded loop, a server-side gate, and an explicit terminal outcome. Multi-tool ReAct, MCP, memory, and orchestration are out — those are roadmap 2.2 and later.

The defining fact is contractual, not prompt-quality. Function calling gives you a JSON schema and a **probability** the model uses it. It does not guarantee the model will call the tool when it should, call it with valid or authorized arguments, tell the truth about a failed call, or stop calling it. Treating "the model emitted a tool call" as "the system did the right thing" produces a loop that executes guesses, leaks other customers' orders, and narrates a shipping date that never came from the database. The architecture is therefore not a better tool description. It is **gate the call, bound the loop, fail loud when the tool cannot ground the answer**: Plan → Gate (schema + authz) → Execute → Sanitize observation → Respond or stop.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the 2-minute answer, the five failure classes, and why "run whatever the model asked for" is the trap.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built — a bounded single-tool loop with a validation/authz gate, not a function-call wrapper — and the anti-pattern it exists to kill.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": turn records, the gate contract, what the cap does, and the sequences where the loop helps, where the model must not answer, and where injection via a DB field is neutralized.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for when a bare function-call wrapper is enough, what this system cannot promise, and the permanent cost of treating the model as an authorization layer.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is one tool schema and an authz rule, not an agent framework. The natural next project is 2.2 (`agent-core`), not more phases here.
