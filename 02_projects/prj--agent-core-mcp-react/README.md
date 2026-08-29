# prj--agent-core-mcp-react

Architecture and system design documentation for `agent-core`: an internal MCP server that exposes AWS, Jira/GitHub, and custom-DB tools, plus a ReAct-style agent that consumes those tools over MCP and is itself an MCP *client* of one third-party MCP server. Agent policy, tool transport (MCP), and runtime (loop, retries, timeouts, budgets) are separate layers.

Documentation-only project: no MCP server, no LangGraph graph, no Docker image, no SDK usage lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "MCP-is-transport-not-safety trap"), not a generic MCP gateway product. Scope is one on-call triage agent, one first-party MCP server, and one allowlisted third-party MCP server.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the problem, the trap, and the architecturally significant requirements.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* the system is, the three-layer split, and why MCP is not an authorization boundary.
3. Read [System Design](./_docs/03_system_design.md) for the ReAct checkpoint loop, tool schema/versioning, auth, confirmation-gate sequences, and third-party observation sandboxing.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for when MCP is worth the extra hop and when it is theater.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is a blast-radius inventory, not an MCP hello-world demo.
