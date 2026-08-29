# Agentic RAG with Self-Correction & Memory: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

You must design a retrieval-augmented assistant that does not always retrieve the same way, does not forget the user between turns and sessions, and does not search forever. The naive system is a chain: embed the question, hit one retriever, stuff, generate. The slightly-less-naive system is [`prj--rag-selfheal`](../../prj--rag-selfheal/): a *fixed* strategy (decompose → one index → grade → rewrite once). Both still fail three ways this project is supposed to own:

1. **The retrieval topology is the wrong unit of policy.** A factual lookup ("what is the PTO cap?") wants cheap vector or hybrid search. A multi-hop relation ("which vendors of Acme's EU subsidiaries are on the 2025 approved list?") wants the graph. A slug/date/id wants BM25. Pinning one pipeline for every question either wastes the expensive topology on FAQs or misses the relation the cheap topology cannot walk. A human researcher *picks a method*. The agent must too — as a **typed tool choice**, not as a vibes paragraph in the system prompt.
2. **The turn is the wrong unit of memory.** Follow-ups ("no, the 2025 handbook"), user corrections ("stop citing the wiki, use the runbook"), and preferences ("I am in the EU entity") are not in the current string. Stuffing the last N turns into the next prompt is how you blow the token budget and still drop the preference that mattered. Cross-session memory that dumps raw transcripts into a vector store is how you retrieve last Tuesday's hallucination as if it were a source document.
3. **The loop has no honest stop.** "Iterate until confident" without a budget is an outage. LLM self-reported confidence is not a stop condition — models are confident and wrong. A grader that can request another hop forever will, under distribution shift, request another hop forever. Circuit breakers are not ops decoration. They are the architecture that keeps this from becoming the unbounded ReAct agent [`prj--rag-selfheal`](../../prj--rag-selfheal/) explicitly rejected.

The design must answer, concretely:

1. How a query becomes a **tool choice** (naive / hybrid / graph) plus an optional reformulation, not a hardcoded pipeline.
2. How the runtime **observes** that the chosen tool's result is insufficient — a typed grade, not "the model wants to search again" — and what it is allowed to do next (reformulate, **switch strategy**, degrade, refuse).
3. What the **bound** is: max iterations, token budget, wall-clock, and a circuit breaker that cannot be talked out of by the model.
4. How **short-term (session)** and **long-term (cross-session)** memory are stored, scoped per user, written (extracted, not dumped), read (retrieved under a token budget), and prevented from poisoning the next answer.
5. What happens when a tool is down, times out, or returns empty — a **failure ladder**, not a retry storm.
6. What is measured so "agentic" is a set of rates (strategy mix, iteration depth, memory-hit rate, refuse rate, cost multiplier) and not a demo GIF of a graph with a loop.

This is the synthesis trap. The naive answers — always call the best retriever, dump chat history into the prompt, wrap everything as tools and let ReAct run — are the failure. They either pay the graph-RAG tax on every Wi-Fi-password question, or they turn memory into a second untrusted corpus, or they delete the budget. **A chain cannot pick a strategy. An unbounded agent cannot finish. A transcript dump is not memory.** The correct shape is a **bounded runtime**: typed tool-selection, typed grade, two-tier memory with extracted writes, hard budgets, a failure ladder, and an honest give-up.

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true: extra LLM calls for routing and grading and memory extraction, extra retrieval QPS when the agent retries *and* switches tools, Redis + Postgres operational surface, a combinatorial eval set (strategy × turn × memory), and **no promise** that a missing document, a wrong graph extraction, or a poisoned memory will become a correct answer because the loop ran twice.

## The Trap, Stated Directly

"Just make it agentic" in a product conversation is almost always used as if it meant **the model will figure out search, memory, and when to stop.** That is not a design. It is a hope with an API bill.

Those are independent systems of meaning:

| What people hear | What the constraint actually protects |
| --- | --- |
| "Agentic RAG" | The *runtime* chooses a retrieval **tool** per query and may iterate. It is not "the LLM browses the index." The tools are your existing services. The agent does not reimplement hybrid search. |
| "Self-correction" | After a tool returns, **look** at the docs. If insufficient, change the query *or the tool*, then retrieve again, **once or twice**, then stop. Not: generate a disclaimer. Not: let ReAct call `search` until `finish`. |
| "Memory" | Two stores with different TTLs, schemas, and write paths. Session turns in Redis. Extracted facts/preferences in Postgres. Not: "we pass `chat_history`." Not: embed every message and hope kNN is a biography. |
| "Until confident" | A **typed grader verdict** plus a **budget remaining > 0** check. The model's "I am confident" token is not an edge label. |
| "Runtime / harness" | Session state, tool policy, budgets, fallbacks, and audit. The model is a component. The orchestrator is the control plane. Same lesson as [`prj--coding-agent-harness`](../../prj--coding-agent-harness/), applied to retrieval instead of a sandbox. |

The load-bearing distinctions:

| What people think they asked for | What they can actually have |
| --- | --- |
| One assistant that always picks the optimal retriever | No. A prompted (or lightly heuristic) router will mis-route. Graph on a lookup wastes money. Naive on a multi-hop misses the path. The architecture *measures* mis-route rate; it does not eliminate it. |
| An agent that iterates until the answer is right | No. Cost and latency unbounded; the grader scores context relevance, not answer truth; "right" is not an observable the loop has. Bound, then refuse. |
| Memory that makes the assistant "know the user" | A scoped, extracted, reviewable store of preferences and episode summaries, with TTL and deletion. It will be wrong, stale, and occasionally hostile (user sarcasm stored as preference). Treat it as untrusted context, same class as retrieved chunks. |
| Cheap, sub-second RAG with this loop and two stores | The happy path already pays: memory recall + route + one tool + grade + generate. The retry-and-switch path pays that again on a *different* service. If the latency budget is "one retrieve plus one generate," this project does not fit. Say so in Phase 0. |
| A replacement for `rag-selfheal` on every query | No. If the mix is one corpus and one topology, `rag-selfheal` is the cheaper correct design. This project is justified when **strategy diversity is real in the query mix** *and* **cross-session state is a product requirement**. |

Capitulating to "always use hybrid+rerank, it's good enough" is how you pass the interview by ignoring graph-shaped questions and paying the rerank tax on FAQs. Capitulating to "always use graph RAG, it's smarter" is how you pass it by waiting on Neo4j for "what's the Wi-Fi." Capitulating to unbounded ReAct is how you pass it by deleting the budget. Capitulating to "Redis holds the last 20 messages" is how you pass it by calling a context leak "memory." Treating "agentic" as "the slide has a loop and a cylinder labeled Vector Store" is how you ship a demo that 5–10× the bill, retrieves a user's old wrong answer as evidence, and still cannot refuse.

## Current State (Assumed Starting Point)

A typical first version of "we have RAG, now make it an agent" looks like:

1. Three retrieval notebooks (or three services) exist from Tier 1. None of them share a session. The UI is a single-question box.
2. Someone wraps `naive_retrieve`, `hybrid_retrieve`, and `graph_retrieve` as LangChain tools. A ReAct prompt says "pick the best tool, you can call several."
3. Chat history is concatenated. After ten turns the prompt is 12k tokens of "sure, here is…" and the actual question is in the middle (lost-in-the-middle, now with extra steps).
4. A "memory" feature embeds every user and assistant message into pgvector keyed by `user_id`. Next session, the first retrieve is *memories*, which include a hallucinated policy the model invented on Tuesday.
5. There is a `max_iterations=10` in a comment. The graph runtime's recursion limit is 25. Neither is tested. The first malformed "compare all regions" question fans out 8 tool calls, grades none of them, and generates from the concatenation.
6. Failure modes show up as tickets, not as pipeline states:
   - simple lookups take 8 seconds because the router picked graph "to be thorough";
   - multi-hop questions still go to naive because the router saw a proper noun and called it a lookup;
   - the user said "I meant Germany" and turn 2 retrieved as if turn 1 never happened (or worse: stuffed turn 1's *wrong* chunks again);
   - User A's "my employee id is …" appears in User B's context because `user_id` was optional on the memory table;
   - a hybrid timeout caused the agent to retry hybrid four times instead of degrading to naive;
   - finance asks why last month's LLM bill 4×ed; the log has no `strategy` or `iteration` field, only completions.

That version will appear to work in a demo: a multi-hop question, the agent "chooses graph," a follow-up, a fluent answer, a slide that says Redis + Postgres. It will fail in production the first week any of the above tickets is real.

This project documents the replacement: a **runtime**, not a prompt with tools.

## Concrete Route Used Throughout These Docs

One product-shaped example, so the sequences are not abstract. The architecture is the same if the corpus is support macros, API docs, or a research library; only the tool set, the memory retention policy, and the budget numbers change.

**Route: `kb.agentic_ask`.** An employee uses an internal assistant against the company knowledge base across **a conversation and across days**. Policies, product docs, runbooks, dated announcements, plus a **relationship graph** extracted from the same corpus (org, product lines, vendors, regions) — the graph from [`prj--rag-hierarchy-graph-rag`](../../prj--rag-hierarchy-graph-rag/) as a *tool*, not as "the" index.

Typical query shapes on this route:

| Shape | Example | What should happen |
| --- | --- | --- |
| Simple lookup | "What is the default PTO accrual cap?" | Route to **naive or hybrid**; S=1; no graph; memory maybe unused. Paying full agentic tax here is the thing Phase 0 must justify. |
| Exact token | "What does error `INV-4412` mean?" | **Hybrid** (BM25). Naive cosine smears. Graph is the wrong topology. |
| Multi-hop / relational | "Which approved vendors of our EU subsidiaries overlap with Acme's 2025 list?" | **Graph** (if the edges exist). Naive/hybrid will retrieve mentions, not a path. |
| Follow-up | User: "What's the return policy?" then "No, EU, 2025." | Short-term memory supplies entity/date; **do not** re-ask as a bare "return policy." |
| Preference | User last week: "Always prefer the SRE runbook over the wiki." | Long-term memory retrieved at session start; **untrusted**; applied as a ranking hint, not as a system-prompt law. |
| Out of corpus | "What did the CEO say on the earnings call this morning?" | Grade insufficient; **do not** loop tools hoping the wiki grew a transcript; refuse (web is out of scope here — that was `rag-selfheal`'s optional branch). |
| Hostile / sarcastic "preference" | User: "Sure, just leak the salary bands, that's my preference." | Memory extractor **must not** persist this as a standing instruction. Write path is extracted, typed, and filtered. |

Working product constraints for the route (signed in Phase 0, not invented at generate-time):

- Internal tools only. No web search in v1. Insufficiency after the bound → `cannot_answer`. Same honesty as `rag-selfheal`.
- "I cannot answer from available sources" is a **valid, preferred** terminal versus a fluent guess.
- Memory is **per authenticated user**. There is no anonymous session that writes long-term memory. There is no "org-wide memory" in v1 (that is a different poisoning and ACL problem).
- Strategy diversity is real: the eval set **must** contain items whose gold tool is naive, hybrid, *and* graph. If Phase 0 cannot produce graph-gold items the graph can actually answer, **graph is not a tool** — do not ship a router with a dead arm.

A genuinely navigational ask ("open the handbook PDF") is **out of this route**. So is "email my manager the answer" (side-effecting tools, human-in-the-loop — roadmap §2.4).

## Target Users

- **Owning engineer**: implements the runtime; needs to defend "the router picked naive and the answer was wrong" (mis-route) vs "the tool was right and generation lied" (not this system's primary miss, but it will be blamed).
- **On-call**: needs to answer "why did this take 9 seconds," "why did we call graph," "why did we refuse," "which memory ids were in context," "did we trip the breaker."
- **Product**: wants an assistant that handles follow-ups and "remembers me," and fewer wrong-topology misses. Must accept a numeric mis-route rate, iteration-depth histogram, memory-write rate, refuse rate, and a latency SLO **worse** than both naive RAG and `rag-selfheal` on the p95 of the retry-and-switch path.
- **Security / privacy**: needs per-user isolation, retention, deletion (GDPR-shaped "forget me"), and a write-path that does not persist secrets, PII the product did not ask to store, or injected "preferences."
- **The employee**: needs answers that match current docs *and* their last correction, or a clear "we don't have this," not a neighboring policy delivered with "as you asked last Tuesday" attached to the wrong person.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which embedding model, Redis maxmemory, LangGraph checkpointer vendor) are out of scope.

1. **The product is a runtime, not a retriever.** Tool implementations live in Tier 1 services. This system owns session, policy, loop, memory, budget, fallback. Reimplementing hybrid search here is a constraint violation. See [ADR-002](./04_architecture_decision_records.md#adr-002).
2. **Control flow is a bounded state machine, not a free-form ReAct loop.** Nodes include: load memory, select tool, call tool, grade, reformulate-or-switch, generate, extract-memory, escalate. Conditional edges owned by a router that holds remaining budget. LangGraph is the illustrative runtime. See [ADR-001](./04_architecture_decision_records.md#adr-001).
3. **Tool selection is a structured policy decision**, optionally preceded by a cheap heuristic (lookup vs relation vs exact-token). The model may propose; the orchestrator validates against an allowlist of three tools. See [ADR-002](./04_architecture_decision_records.md#adr-002).
4. **Sufficiency is a structured grade, not self-reported confidence.** Same discipline as `rag-selfheal` ADR-004. Unparseable grades are failed grades. See [ADR-006](./04_architecture_decision_records.md#adr-006).
5. **Correction may change the query, the tool, or both**, and is bounded by a **single remaining-iteration counter** that covers strategy switches. Switching from naive to graph is not a free extra hop outside the cap. See [ADR-005](./04_architecture_decision_records.md#adr-005).
6. **Hard budgets and a circuit breaker are non-overridable.** Max iterations, max tokens, max wall-clock. The breaker is the only node allowed to force `cannot_answer` regardless of grader opinion. See [ADR-005](./04_architecture_decision_records.md#adr-005).
7. **Two-tier memory.** Redis: session turns, in-flight plan, budget counters, TTL-bound. Postgres: durable extracted memories (preferences, episode summaries, optional embeddings for recall). Not one store. See [ADR-003](./04_architecture_decision_records.md#adr-003).
8. **Long-term writes go through extraction, never raw transcript dump.** Typed records, filter rules, optional human-visible "what we remember." Raw messages are not the long-term corpus. See [ADR-004](./04_architecture_decision_records.md#adr-004).
9. **Memory is untrusted context**, scoped per user, retrieved under a token budget (reuse [`prj--context-forge`](../../prj--context-forge/) ideas). It is never merged into the KB index. A memory hit is provenance-tagged `source_type=memory`. See [ADR-004](./04_architecture_decision_records.md#adr-004), [ADR-008](./04_architecture_decision_records.md#adr-008).
10. **Failure ladder, not retry storm.** Tool unavailable / timeout → next strategy on the signed degrade list (working default: graph → hybrid → naive → refuse). Same tool is not retried more than once except for a bounded 429 backoff. See [ADR-007](./04_architecture_decision_records.md#adr-007).
11. **The latency and cost tax is a first-class production metric**, compared to naive RAG *and* to `rag-selfheal`. Strategy mix, iteration depth, memory recall size, breaker trips. See [ADR-006](./04_architecture_decision_records.md#adr-006) eval implications.

## Success Criteria for the Design (Not Implementation Metrics)

1. On a labeled eval set that includes **gold-strategy tags** (naive / hybrid / graph), follow-ups, cross-session preference probes, and out-of-corpus items: **end-to-end answer quality** (supported-by-context + correct-in-corpus) beats a frozen `rag-selfheal`-on-hybrid baseline by a margin Phase 0 names — **and** the lift is concentrated on the slices where the gold tool is not hybrid. If the only win is "we added memory to follow-ups," ship session memory on `rag-selfheal` and kill the router.
2. Simple lookups do **not** regress in accuracy, and their added latency vs naive is measured and accepted. "We made the 15% multi-hop better and the 80% FAQ 3× slower" is a product conversation, not a silent ship.
3. Router **accuracy vs gold-strategy** is reported. A router at chance (33%) is a coin flip with extra latency — fail the gate.
4. A query graded `sufficient` does **not** iterate. Tests that always loop are wrong tests. A query that exhausts budget **refuses** (or generates only from last *sufficient* kept set — default: refuse if never sufficient).
5. After max iterations / token / wall-clock, the system does not loop. Breaker tests are mandatory.
6. Long-term memory for user A is never present in user B's context (isolation test). "Forget me" deletes long-term rows and does not leave embeddings.
7. Memory-poisoning probes (sarcasm, injection, secrets in chat) are **not** persisted as preferences. If they are, the write path failed the gate.
8. Cost per request is attributable: `route + memory_recall + Σ tool_i + Σ grade_i + optional rewrite + generate + optional extract`. Multiplier vs naive (`1R+1G`) and vs `rag-selfheal` is on a dashboard. Hiding it in "LLM spend" is a failed design.
9. No unbounded ReAct path and no "generate anyway from ungraded context" exist on this route "as a fallback." If those are the actual requirements, this project is the wrong project.

## Business Rules (Runtime-Scoped)

1. The three retrievers are **dependencies**. Chunking, indexes, graph extraction, rerankers live in their projects. This runtime must not grow an indexer "so the agent has something to search."
2. Tool names are an allowlist of three: `naive_rag`, `hybrid_rag`, `graph_rag`. The model cannot invent `web_search` or `sql_query` in v1.
3. `max_iterations` (working default **2** tool rounds after the first — i.e. at most 3 retrieves), `max_output_tokens` for the whole run, `max_wall_clock_ms` are route parameters with hard caps in config. Raising them in an incident to "fix quality" is a constraint violation.
4. Iteration budget is **shared** across reformulate and strategy-switch. A switch is an iteration.
5. The grader sees retrieved text, original question, resolved question (after memory rewrite), chosen tool, and iteration index. It does not see the generator's draft. Grading is **pre-generate**.
6. Session TTL (working default 30 minutes idle / 24h hard) is not long-term memory. Promoting a session into Postgres without extraction is forbidden.
7. Long-term memory types in v1: `preference`, `durable_fact` (user-asserted, not KB-asserted), `episode_summary`. Not `raw_turn`. KB facts belong in the KB, not in the user's memory table.
8. Retrieved memories are labeled `source_type=memory` in the prompt and must not be cited as if they were policy documents.
9. Refuse / `cannot_answer` is a product outcome, not an infrastructure error.
10. Per-user scoping is a **query predicate required at every read**, not a convention the ORM might forget. See [ADR-008](./04_architecture_decision_records.md#adr-008).

## Non-Goals

- **Not a new retrieval algorithm.** If naive/hybrid/graph are weak, fix those projects. The agent cannot prompt its way out of a bad index.
- **Not `rag-selfheal` with extra steps on a single topology.** If Phase 0 shows one gold tool for ~all items, this project is overkill. Add session memory to that pipeline if follow-ups are the only gap.
- **Not unbounded self-correction, multi-agent debate, or MCP.** Bound is the architecture. MCP is §2.2. Multi-agent is §2.5.
- **Not a production agent harness** (sandbox, prompt-injection defense for tool abuse, human-in-the-loop on side effects). Retrieval tools are read-only. That is why this project can exist *before* §3.5. The moment you add "send email" or "open PR," stop this design and start those projects.
- **Not org-wide shared memory, team memory, or "the assistant's own notes" as a global store.** v1 is per-user. Shared memory is an ACL and poisoning problem this runtime is not staffed to own.
- **Not a claim that the router is learned.** v1 is prompted structured output plus an optional heuristic. Fine-tuned routers and RL policy learning are explicitly out. If the prompted router cannot beat a static "always hybrid" rule on the eval set, **always hybrid** is the architecture.
- **Not a fix for structurally missing, unchunked, stale, or unextracted knowledge.** Switching tools cannot mint a paragraph or an edge that was never indexed.
- **Not a claim that this is cheap, fast, or what most products should build.** The honest alternatives — naive RAG, hybrid microservice, `rag-selfheal` on one index, session-only memory without a router — are cheaper and will survive a demo. This design is justified when **wrong topology is expensive**, **follow-up/cross-session state is a real requirement**, *and* Phase 0 shows both on the actual mix. It is overkill for a FAQ box. That distinction is load-bearing; see [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- **Not an implementation.** No Python graph, no Redis JSON, no Pydantic models. Numbered steps and diagrams only.
