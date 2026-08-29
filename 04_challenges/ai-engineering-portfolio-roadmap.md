# AI Engineering → AI Systems Architect: Portfolio Challenge Roadmap

*(Merged from three overlapping roadmap drafts into one deduplicated sequence.)*

## Positioning

The goal is to move from "engineer who calls LLM APIs" to **"architect who designs systems around LLMs"** — retrieval, memory, orchestration, evaluation, cost/latency tradeoffs, failure modes.

Your existing stack (Docker, k8s, Terraform, AWS, CI/CD, IaC, MERN, Python) is a genuine advantage. The average "AI engineer" portfolio is a Jupyter notebook that calls an LLM. Yours can be **deployed, observable, multi-tenant, and cost-governed** — which is exactly what separates an AI engineer from an AI systems architect.

So the goal of every project below is **not** "it works." It's "here are the decisions I made, the tradeoffs I weighed, and how I'd run this in production."

## How every project must ship

Every project in this roadmap should ship with an architecture doc, not just code — that's what reads as "architect" to a hiring panel:

1. **One-pager** — problem, why this architecture, tradeoffs considered and rejected.
2. **Diagram** — C4-style (context → container → component); Mermaid renders fine on GitHub.
3. **ADR log** — `docs/adr/0001-choose-pgvector.md`, etc. Single highest-signal artifact in the whole portfolio. 2–3 real decisions minimum per project, 8–12 for the capstone.
4. **Failure-mode analysis** — what happens when the LLM is slow, wrong, hallucinating, or down.
5. **Benchmarks / evals** — latency, cost per request, retrieval quality (RAGAS: faithfulness, answer relevancy, context precision/recall). Numbers matter more than "it works."
6. **IaC + CI/CD** — Terraform + GitHub Actions where applicable. This is the credibility your DevOps background lets you actually deliver, and almost no competing portfolio will have it.
7. **Repo hygiene** — clean README, `docker-compose up` demo, link to the docs above.

Two disciplines are framed as **architectural concerns, not features**, from the very first project onward:

- **Evaluation** is to AI systems what TDD is to software. Build one eval harness early (`prompt-lab`) and have every later project plug into it — that reuse *is* the architecture story.
- **Context engineering** (what goes into the context window, and why) is a resource-allocation problem, not a prompting trick.

---

## Tier 0 — Foundations
*Prove you understand the primitives before composing them. ~1–2 weeks each.*

### [DOCUMENTED] 0.1 Prompt & Eval Harness — `prompt-lab`
Run the same task through zero-shot, few-shot, chain-of-thought, structured-output (JSON schema/function-calling), and system-prompt variants, against different models/providers. Log every run (prompt version, model, output, tokens, latency, cost) and score it (exact-match, LLM-as-judge, later RAGAS). Treat prompts as **versioned artifacts with a CI gate** — a prompt change can't merge if eval scores regress.
- **Concepts:** prompt engineering, harness engineering, evals, versioning.
- **Architecture angle:** design a pluggable evaluation-harness abstraction (provider-agnostic), not a one-off script. This becomes the eval backbone every later project plugs into.
- **Stack:** Python/TS, OpenAI/Anthropic SDKs, Postgres for run logs, GitHub Actions to run the eval suite on PR.

### [DOCUMENTED]0.2 Structured-Output Extractor
Take unstructured text (resumes, invoices, support tickets) and use prompting + JSON schema/function-calling to extract structured data reliably, with output validation and retry-on-invalid-schema.
- **Concepts:** prompt engineering under constraints, output validation, structured extraction.
- **Architecture angle:** design the validation/retry contract — what happens on a schema-invalid response, how many retries, what's the fallback.
- **Stack:** Python/TS, JSON Schema, Pydantic/Zod.

### [DOCUMENTED]0.3 Context Assembler — `context-forge`
A library that assembles the final context window from parts — system prompt, retrieved chunks, chat history, tool schemas, few-shot examples — under a hard token budget, with pluggable strategies (truncate, summarize, prioritize-by-relevance). This is your intro to **context engineering**: deciding *what* goes into context, not just how to phrase it.
- **Concepts:** context engineering, prompt engineering, system design.
- **Architecture angle:** frame token budget as a resource-allocation problem (like memory management). Measure the effect of each strategy on cost and answer quality.
- **Stack:** Python/TS.

### [DOCUMENTED]0.4 Embeddings Explorer (retrieval-only)
Chunk + embed a folder of markdown/PDF docs (pgvector, Chroma, or FAISS), build a simple search UI. Your first embeddings project — **no LLM generation yet**, just retrieval quality. Benchmark chunking strategies (fixed-size vs semantic vs recursive).
- **Concepts:** embeddings, chunking, vector DBs.
- **Architecture angle:** document the chunking-strategy tradeoffs with benchmarks — this becomes the baseline every later RAG project is measured against.
- **Stack:** Python/TS, pgvector/Chroma/FAISS, Postgres.

### [DOCUMENTED]0.5 Naive RAG Document Q&A — `docqa-basic`
Ingest → chunk → embed → store → retrieve → generate, over a private knowledge base (your resume/portfolio, or internal docs). Clean microservice boundaries (ingestion / retrieval / generation). Deploy on Docker/k8s for infra reps.
- **Concepts:** naive RAG, vector stores, microservices, system design.
- **Architecture angle:** deliberately name it "naive" and document its failure modes (lost-in-the-middle, no reranking, chunk-boundary bleed). This is the baseline you spend the rest of the roadmap measurably beating.
- **Stack:** Python/TS, pgvector/Pinecone, Postgres, Docker/k8s.

---

## Tier 1 — Advanced Retrieval Systems
*Beat the naive baseline with progressively smarter retrieval, and make retrieval quality measurable. 2–4 weeks each.*

### [DOCUMENTED] 1.1 Hybrid + Reranked RAG Microservice — `retrieval-x`
BM25 (keyword) + vector search fused via Reciprocal Rank Fusion, then a cross-encoder reranker (or Cohere rerank) on top-N, plus citation of sources. Expose as a standalone microservice with its own API contract, pluggable into any downstream app.
- **Concepts:** hybrid RAG, reranked RAG, retrieval quality tuning.
- **Architecture angle:** A/B the pipeline stages and publish a table — naive vs hybrid vs hybrid+rerank on precision/recall/latency. Make the reranker swappable behind an interface (dependency inversion).
- **Stack:** FastAPI, pgvector + Postgres full-text (or Pinecone), Docker, k8s.

### [DOCUMENTED] 1.2 Multi-Query & Corrective RAG Pipeline — `rag-selfheal`
Query rewriting/decomposition into sub-queries, retrieval fan-out, RRF fusion, plus a corrective self-check step: grade retrieved docs for relevance and re-retrieve (or fall back to broader/web search) if the LLM judges context insufficient. Model this as a **state machine**, not a linear chain.
- **Concepts:** multi-query RAG, corrective RAG (CRAG), LangGraph.
- **Architecture angle:** diagram the control flow as a state machine. Discuss the latency/cost tax of the correction loop and when it's worth paying.
- **Stack:** LangGraph, LangChain/LlamaIndex, RAGAS for eval.

### [DOCUMENTED] 1.3 Multi-Source RAG with Access Control
RAG over multiple heterogeneous sources (SQL DB, docs, Slack/Notion exports) with **per-user permission filtering applied at retrieval time**, not just at the UI layer. This starts to look like a real enterprise AI system.
- **Concepts:** retrieval-time authorization, data source federation, security architecture.
- **Architecture angle:** design where permission checks live in the pipeline (pre-filter vs post-filter vs source-scoped indices) and the leakage risks of each.
- **Stack:** Python/TS, Postgres, your Tier 1.1 retrieval service as a backend.

### [DOCUMENTED] 1.4 Hierarchical / Graph RAG over a Real Domain Corpus — `rag-hierarchy` / `graph-rag`
Pick a real domain (your own resume corpus, internal wiki, SEC filings, etc.). Build **hierarchical** retrieval (doc → section → chunk summaries, parent-child chunking with summary indices) **and** a **knowledge-graph** variant (entities/relations extracted into Neo4j, graph-traversal retrieval), and compare both against hybrid/naive on the same corpus using RAGAS.
- **Concepts:** hierarchical RAG, graph RAG, graph data modeling.
- **Architecture angle:** index topology as an architectural decision. Show a query vector RAG cannot answer well (multi-hop: "which suppliers of X's competitors are based in Y?") and how the graph makes it tractable. Publish the comparison report — a real evaluation table is a strong differentiator.
- **Stack:** Neo4j, LlamaIndex, RAGAS, Python.

### [DOCUMENTED] 1.5 RAG Evaluation & Observability Platform — `rag-metrics`
Wrap any of the above pipelines with RAGAS metrics (faithfulness, answer relevancy, context precision/recall), request tracing, and a dashboard. Add a CI pipeline (GitHub Actions/pytest) that runs a fixed eval set on every change and flags regressions in answer quality/faithfulness — this is where "AI engineering" starts looking like real engineering. Tie it back to `prompt-lab`: one eval backbone across all projects.
- **Concepts:** RAGAS, evaluation-driven design, observability, CI gates.
- **Architecture angle:** evaluation-driven development as a discipline, not a one-off script.
- **Stack:** RAGAS, GitHub Actions, pytest, a tracing/dashboard layer.

---

## Tier 2 — Agents, Tools & MCP
*Move from "retrieve-then-answer" to systems that plan, act, use tools, and manage state. 4–6 weeks each.*

### [DOCUMENTED] 2.1 Single-Tool Agent — `single-tool-agent`
An LLM agent that calls one external tool (a weather API, or your own DB) via function calling. Teaches the core agent loop: plan → call tool → observe → respond. Treat as a warm-up before 2.2.
- **Concepts:** function calling, the agent loop.
- **Stack:** any LLM SDK, one tool.

### [DOCUMENTED] 2.2 ReAct Agent with Tool Use over Your Own MCP Server — `agent-core`
Build an **MCP server** exposing your own internal APIs (AWS resources, a Jira/GitHub connector, a custom DB) so any MCP-compatible client can use them. Then build a **ReAct-style agent** (reason → act → observe loop) that consumes those tools via MCP, and make the same agent MCP-*client*-capable of a third-party MCP server too. Separate the *agent policy*, the *tool transport* (MCP), and the *runtime* (loop, retries, timeouts) into distinct layers.
- **Concepts:** AI agents, ReAct, MCP (server *and* client side), AI runtime, harness engineering.
- **Architecture angle:** MCP is the emerging tool-interoperability standard — building both sides now is forward-looking and directly maps to your backend/API experience. Document the MCP tool-schema design, auth, error handling/retries, and how you'd version tool contracts in an enterprise setting. This is genuinely resume-worthy given how new MCP is, and becomes reusable infrastructure for almost every project after it — worth doing early.
- **Stack:** TS or Python MCP SDK, LangGraph for the loop, Docker.

### [DOCUMENTED] 2.3 Agentic RAG with Self-Correction & Memory — `rag-agentic`
An agent that *decides* its own retrieval strategy per query (naive vs hybrid vs graph — reuse your Tier 1 services as tools), reformulates and iterates until confident, self-corrects, and persists both short-term (session, Redis) and long-term (vector store, user preferences/past interactions) memory across sessions. Bound the open-ended loop with max iterations, budget guards, and circuit breakers.
- **Concepts:** agentic RAG, corrective + multi-query RAG, harness engineering, AI runtime, memory.
- **Architecture angle:** design the "runtime" — session state, memory-store schema, tool-selection policy, and a clear failure/fallback strategy when retrieval or tools fail. This is the synthesis project for everything in Tier 1.
- **Stack:** LangGraph, Postgres (state + long-term memory), Redis (short-term), your Tier 1 RAG services as tools.

### [DOCUMENTED] 2.4 Agentic Workflow with Human-in-the-Loop
A workflow (n8n or custom) where an agent does research/drafting and **pauses for human approval** before an irreversible action (sending an email, making a PR). Teaches guardrails and workflow orchestration independent of the bigger multi-agent project below.
- **Concepts:** guardrails, workflow orchestration, approval gates.
- **Stack:** n8n or a custom orchestrator.

### [DOCUMENTED] 2.5 Multi-Agent Orchestration Platform — `agent-graph`
Several specialized agents (planner, researcher/coder, reviewer, tester) coordinated by a supervisor/orchestrator agent, communicating via a message bus, each with scoped tools/permissions, checkpointing, retries, and human-in-the-loop approval nodes. This is a **distributed workflow-engine problem in disguise** — bring your existing instincts: idempotency, durable checkpointing, retry/backoff, dead-letter handling.
- **Concepts:** AI workflows, multi-agent systems, agent-to-agent protocols, task decomposition, failure handling, distributed system design.
- **Architecture angle:** the centerpiece below the capstone — draw the full system diagram: orchestrator pattern, agent-to-agent protocol, shared vs. isolated context windows, per-agent guardrails, and observability (tracing every LLM/tool call). This is where your `n8n`/CI-CD experience translates directly.
- **Stack:** LangGraph (multi-agent graphs), FastAPI microservices per agent, Docker Compose/k8s, message queue (Redis/SQS).

---

## Tier 3 — Harness & Runtime Engineering
*The scaffolding, permissions, and feedback loop around the model — not the model itself. This is where "AI engineer" stops and "AI systems architect" begins to look inevitable.*

### 3.1 Custom Coding Agent (mini Claude Code)
A CLI tool that gives an LLM a sandboxed shell/file-system, lets it read/edit files and run tests in a loop until a task passes.
- **Concepts:** harness engineering — tool definitions, permissions, feedback loop.
- **Stack:** Python/TS, subprocess sandboxing.

### 3.2 Sandboxed Execution Runtime
An isolated, resource-limited, network-restricted execution environment for agent-run code (Docker/k8s), with timeout/kill handling and result capture. This is **AI runtime** territory — the infra that safely executes what an agent decides to do.
- **Concepts:** AI runtime, sandboxing, resource limits.
- **Stack:** Docker/k8s, cgroups/seccomp or gVisor-style isolation.

### 3.3 Observability Layer for Agents
Tracing (OpenTelemetry-style spans) for every LLM call, tool call, and retrieval step across your agent systems, with a dashboard showing latency, token cost, and failure points per step. This is what makes an agent system *operable*, not just demo-able.
- **Concepts:** observability, distributed tracing, cost/latency accounting.
- **Stack:** OpenTelemetry, a metrics/tracing backend (Grafana/Jaeger-style), dashboards.

### 3.4 MCP Tool Ecosystem & Registry — `mcp-hub`
A suite of MCP servers plus a host runtime plus a **tool registry** with discovery, versioning, and auth/authorization, so any agent in an org can safely find and use tools. You're designing an *extensible platform*, not an app.
- **Concepts:** MCP, plugin architecture, capability negotiation, least-privilege tool access.
- **Architecture angle:** governance and security framing is what elevates this from a demo to a platform story.
- **Stack:** TS/Python MCP SDK, a registry service, Postgres.

### 3.5 Production Agent Harness — `agent-harness` (synthesis)
The runtime that makes agents safe for production, synthesizing 3.1–3.3: sandboxed tool execution, short-term + long-term memory, context management (reuse `context-forge`), a live eval loop, guardrails, budget enforcement, and human oversight/escalation. Threat-model it explicitly: prompt injection, tool abuse, runaway loops.
- **Concepts:** harness engineering, AI runtime, context engineering, evaluation.
- **Architecture angle:** "harness engineering" is the frontier term right now — owning it signals you're current. Frame it as the difference between a demo agent and one you'd let touch a customer's data.
- **Stack:** everything from 3.1–3.4, plus Postgres/Redis for state.

---

## Tier 4 — Architect-Level Capstone Systems
*2–3 months. The flagship. This is where "software architect" becomes undeniable.*

### 4.1 Enterprise AI Gateway / Control Plane — `ai-platform` (flagship)
A self-hosted, multi-tenant platform that sits between your org's apps and multiple LLM providers/agents, where teams register their own tools/agents/RAG sources behind a gateway:
- **Provider-agnostic model routing** — cheap model vs. frontier model by task complexity, with fallback and cost-based routing between providers/local models.
- **Semantic caching** — embed the request, serve cached answers on near-match.
- **Auth, per-tenant rate limiting, quotas, and cost tracking** per team.
- **Centralized prompt/version registry** (a CMS for prompts, with rollback) — reuse `prompt-lab`.
- **RAG-as-a-service** — plug in your Tier 1 retrieval microservices as backend "skills."
- **Agent runtime** — plug in your Tier 2/3 agent + harness work.
- **Guardrails** — PII redaction, output validation, prompt-injection defense across agent boundaries.
- **Full observability** — tracing of every RAG + agent call, evals-as-CI (RAGAS gates in the pipeline).
- Deployed on **k8s**, provisioned with **Terraform**, shipped via **GitHub Actions**.
- **Concepts:** everything — system design, microservices, AI runtime, MCP, RAG variants, agents, IaC, CI/CD.
- **Architecture angle:** lead with the C4 context diagram, the multi-tenancy model, and cost/latency SLOs. Write an ADR log with 8–12 real decisions (why pgvector vs. Pinecone, why LangGraph vs. a custom state machine, multi-tenancy model, data residency for prompts/embeddings). Threat-model prompt injection across agent boundaries. This single project can carry an entire architect interview.
- **Stack:** your full stack — Terraform, k8s, GitHub Actions, AWS, Postgres + pgvector + Neo4j, LangGraph, MCP servers as pluggable connectors, RAGAS in CI.

### 4.2 Cross-cutting pillars worth calling out on their own
These are naturally features *inside* 4.1, but each is substantial enough — and distinct enough as a story — to extract and present as a standalone deep-dive if you want to emphasize a specific competency in an interview:
- **Policy-driven agent guardrail system** — middleware that inspects every agent action against configurable policies (data-access rules, spend limits, allowed tool combinations) before execution, with an audit log. The kind of system that makes AI adoption safe enough for regulated orgs.
- **CI/CD for AI systems (AgentOps)** — prompt/version control, automated eval gates, canary rollout of new prompts/models, rollback on regression, cost/latency budgets enforced in CI. Ties `prompt-lab` + `rag-metrics` + IaC into an "MLOps for LLMs" story.

### 4.3 Second flagship (pick one, optional)
Two alternative vertical capstones — pick whichever best fits your target role, or skip both if 4.1 alone is enough:

- **Autonomous Incident-Response / DevOps Agent** — an agent wired into your own infra (via MCP servers to AWS/k8s/Datadog-style tools) that diagnoses alerts, proposes fixes, and — with approval gates — executes remediations. Shows AI systems architecture, agents, MCP, runtime, and guardrails all working together on real infra. Especially close to what an "AI systems architect" role actually does given your DevOps background.
- **Regulated-Domain Compliance Copilot** — a domain-specific agentic RAG system (legal, healthcare, or finance docs) with citation-forced answers, human-in-the-loop approval gates, full audit logging, and a PII-redaction pipeline before embedding. Shows you can design for *trust and auditability*, not just capability.

---

## Suggested build order

Two valid sequencing strategies — pick based on how much time you have and which narrative you want to tell.

**A. Linear / learning-first (recommended default).** Build foundations before composing them:

1. Tier 0 in order (`prompt-lab` → `context-forge`/structured-extractor → embeddings explorer → `docqa-basic`). RAG genuinely depends on the embeddings/context fundamentals, so keep this sequential.
2. Tier 1 — pick 2 of the 4 retrieval variants rather than building all of them (e.g. `retrieval-x` + one of hierarchical/graph), plus `rag-metrics` so the eval story ties the tier together.
3. Tier 2 — start with `agent-core` (your own MCP server) since it becomes reusable infrastructure for everything after it; then mix agentic-RAG / multi-agent depending on what you want to specialize in.
4. Tier 3 — as much or as little as your target role needs; `agent-harness` is the one worth doing if you're going deep on runtime/harness engineering specifically.
5. Tier 4 — `ai-platform`, reusing everything above as pluggable backend skills.

That's roughly 4–6 substantial repos where each one visibly builds on the last — composition and reuse is itself the architecture story.

**B. Platform-first (stronger reuse narrative, higher risk).** Build the `ai-platform` control plane shell first (routing, auth, prompt registry, observability scaffolding — no real backends yet), then implement Tiers 0–3 as its pluggable backend services, one at a time. The pitch becomes "I built one evolving platform, not ten disconnected toys" — a compelling story, but only works if you're confident enough in the domain to design the plugin contract correctly on the first pass. If unsure, do strategy A first and treat B as how you'd *describe* the finished portfolio in retrospect.

---

## Concept → project quick reference

| Concept | Where it's covered |
|---|---|
| Prompt engineering, evals | 0.1 `prompt-lab` |
| Structured output / function calling | 0.2, 2.1 |
| Context engineering | 0.3 `context-forge` |
| Embeddings, vector DBs | 0.4, 0.5 |
| Naive RAG | 0.5 `docqa-basic` |
| Hybrid + reranked RAG | 1.1 `retrieval-x` |
| Multi-query / corrective RAG | 1.2 `rag-selfheal` |
| Retrieval-time access control | 1.3 |
| Hierarchical / graph RAG | 1.4 `rag-hierarchy` / `graph-rag` |
| RAG evaluation & CI gates | 1.5 `rag-metrics` |
| Agent loop / ReAct | 2.1, 2.2 `agent-core` |
| MCP (server + client) | 2.2 `agent-core`, 3.4 `mcp-hub` |
| Agent memory | 2.3 `rag-agentic` |
| Human-in-the-loop guardrails | 2.4 |
| Multi-agent orchestration | 2.5 `agent-graph` |
| Harness engineering | 3.1, 3.5 `agent-harness` |
| AI runtime / sandboxing | 3.2 |
| Agent observability / tracing | 3.3 |
| Multi-tenant platform, model routing, cost governance | 4.1 `ai-platform` |
| Policy guardrails, AgentOps CI/CD | 4.2 |
| Vertical/regulated capstones | 4.3 |
