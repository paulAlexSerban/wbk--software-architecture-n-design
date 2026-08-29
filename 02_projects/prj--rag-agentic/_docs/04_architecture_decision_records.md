# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

These decisions lock **runtime** as the product: a bounded graph over existing tools, two-tier extracted memory, and a fuse. Reversing ADR-001 into free-form ReAct, ADR-004 into transcript dump, or ADR-005 into "the model decides when to stop" ends this project and starts a demo.

## ADR-001: LangGraph Bounded State Machine over a Free-Form ReAct Loop

**Status**: Accepted

**Context**: Agentic RAG is sold as "the model picks tools until it is done." That is ReAct: the model is the control plane, the stop condition is `finish` or a timeout, and on-call cannot distinguish "needed graph after naive" from "the prompt got stuck in search." [`prj--rag-selfheal`](../../prj--rag-selfheal/_docs/04_architecture_decision_records.md#adr-001) already rejected unbounded ReAct for a *single* retriever. Adding two more tools and a memory store makes an unbounded loop *more* expensive, not more justified.

A linear chain cannot select a tool or iterate. A `while` in a FastAPI handler with no named terminals is a state machine you will not test. LangGraph (or any explicit graph runtime) is the admission that control flow *is* the architecture.

**Decision**: Implement `kb.agentic_ask` as an **explicit state machine**: BindSession → RecallMemory → ResolveQuestion → SelectTool → CallTool → Grade → Reformulate|Degrade|Generate|Escalate → ExtractMemory → PersistSession. Conditional edges owned by a router that holds remaining budget. LangGraph is the illustrative runtime. The invariant is the graph and the fuses, not the import. Recursion-limit is a **backup** fuse, not the budget.

**Consequences**:
- (+) Tool switch, degrade, refuse, and breaker are testable edges.
- (+) Telemetry maps to nodes; "why was this slow" has an answer.
- (–) More moving parts than `retrieve | generate` and more than `rag-selfheal`. Justified only if Phase 0 shows strategy diversity *and* a memory requirement. See kill criteria.
- (–) Graph bugs (forgotten decrement) are outage-shaped. Forbidden-terminal tests are mandatory.
- **Alternative rejected**: Free-form ReAct with three retrieve tools. Deletes the budget; makes the model the control plane; memory writes become whatever the model called `store_memory` with.
- **Alternative rejected**: Linear chain that always calls hybrid. Correct *product* for many mixes; wrong answer to *this* scenario if Phase 0 shows relational gold items. If Phase 0 does not, **take this alternative** and kill the router.
- **Alternative rejected**: Multi-agent supervisor (planner/researcher). §2.5. Extra agents do not select a retriever better; they multiply bills.
- **Revisit trigger**: mix is almost all one topology and follow-ups are rare. Then `rag-selfheal` or hybrid-alone is the architecture; this ADR is void. That is a successful Phase 0 kill.

## ADR-002: Tool-Selection over Existing Tier 1 Services, Not a Rebuilt Retrieval Stack

**Status**: Accepted

**Context**: The roadmap says reuse naive vs hybrid vs graph as tools. The failure mode is forking chunkers and indexes "so the agent has search." That would silently restart Tiers 0–1 inside Tier 2.

Calling all three tools every request and fusing results is an honest ensemble. It is also a 3× retrieval tax that **deletes** the point of selection. Teams reach for it when the router is bad. Then they still have a bad router *and* three bills.

**Decision**: The runtime **adapters** call the existing service contracts (`POST /retrieve` or equivalent). Allowlist of at most three tools; absent services are absent, not stubbed. **v1 is serial: one tool per hop.** The policy is a heuristic plus structured LLM enum. Default on invalid/uncertain: `hybrid_rag`. If the prompted policy cannot beat always-hybrid on gold-strategy labels, **remove the policy**; do not fan-out-all as a consolation.

**Consequences**:
- (+) Replaceable seams; sibling projects remain systems of record for indexes.
- (+) Mis-route is measurable (chosen vs gold).
- (–) Adapter version skew: naive embed model ≠ hybrid embed model is *their* problem, but latency classes differ and must be configured per tool.
- (–) A dead graph service is a missing arm, not a mock.
- **Alternative rejected**: Reimplement BM25+vector+Cypher in this repo. Wrong project.
- **Alternative rejected**: Parallel try-all-tools + RRF as v1 "agentic." Name it ensemble RAG if you want it; it is not this architecture.
- **Alternative rejected**: Learned router / RL as a v1 gate. No data yet; the labeled set is the product of Phase 0–2.
- **Revisit trigger**: router confusion matrix shows no lift vs always-hybrid. Kill the policy; keep memory + one tool.

## ADR-003: Two-Tier Memory — Redis Session vs Postgres Long-Term

**Status**: Accepted

**Context**: One store cannot honestly be both "the last four turns, discard in 30 minutes" and "the user prefers the runbook, keep for months." Putting both in Redis loses preferences on flush and on TTL. Putting both in Postgres makes follow-up path a SQL round-trip for ephemeral tokens and invites treating the transcript as a durable corpus.

A third option — embed every message in pgvector as "memory" — is the transcript dump [ADR-004](./04_architecture_decision_records.md#adr-004) forbids, wearing a vector hat.

**Decision**: **Redis** holds session turns (capped), bound by `user_id` in the key, TTL-idle + hard TTL. **Postgres** holds extracted `ltm_memory` rows. The LangGraph checkpointer, if used, is an implementation detail of crash recovery; it is **not** the long-term product memory and must not be queried as "what we know about the user." v1 recall is recency/type over ≤200 rows per user, not ANN (ANN optional later, still `WHERE user_id`).

**Consequences**:
- (+) Loss modes are distinct: Redis flush → follow-ups break; Postgres down → memories missing, Ask can continue session-only if signed.
- (+) TTL vs durability is explicit.
- (–) Two operational surfaces. At this QPS the cost is cognitive, not dollars.
- (–) Developers will try to "just checkpoint the whole state to Postgres." Forbid in review.
- **Alternative rejected**: Redis-only (including RedisJSON as LTM). Preferences die; forget-me across pods is messy; audit is worse.
- **Alternative rejected**: Postgres-only sessions. Works; slower; encourages keeping unbounded turn history as the memory product.
- **Alternative rejected**: Vector store of raw turns as the only memory. Poisoning and leakage by construction.
- **Revisit trigger**: if product drops cross-session memory, delete Postgres LTM and this ADR's LTM half; keep Redis. That is a valid reduction.

## ADR-004: Long-Term Writes via Extraction and Filters, Never Raw Transcript Dump

**Status**: Accepted

**Context**: "Persist past interactions" is the roadmap phrase that most often becomes `INSERT embedding(message)`. That stores hallucinations, secrets, sarcasm, and prompt-injection as if they were user biography. Next session, kNN retrieves Tuesday's wrong PTO cap and the generator cites it.

Extraction is an LLM call and can itself be wrong. Deterministic filters after the model are the load-bearing control. User-visible "what we remember" is the product control. If product will not show or delete memories, writing them is malpractice.

**Decision**: After a turn (await with timeout, skip on timeout), a structured extractor may emit `preference` | `durable_fact` | `episode_summary` with `normalized_key`, clamped TTL, max 500 chars. Deterministic filters drop secrets/PII patterns, instruction-like text, and KB-shaped claims stored as preferences. Upsert by `(user_id, type, normalized_key)`. Raw turns stay in Redis (short) and optionally in `agent_run` (audit), **not** in `ltm_memory`. Memories enter generation tagged `source_type=memory` and **do not** count toward grade `sufficient`.

**Consequences**:
- (+) Poisoning has a place to die (filters + probes).
- (+) Upsert prevents preference stacking.
- (–) Extract can miss a real preference; user repeats themselves. Better than storing a fake one.
- (–) Extra LLM role and timeout policy.
- **Alternative rejected**: Embed all messages. Maximum recall of maximum garbage.
- **Alternative rejected**: Store assistant answers as `durable_fact`. Launders hallucinations into memory.
- **Alternative rejected**: Human approval on every write in v1. That is §2.4; this route is read-only retrieval. Compensate with GET/DELETE memories.
- **Revisit trigger**: poisoning probes fail in Phase 5. Stop writes; session-only until filters pass. Do not "add more summarization."

## ADR-005: Hard Iteration, Token, and Wall-Clock Budgets with a Non-Overridable Circuit Breaker

**Status**: Accepted

**Context**: `rag-selfheal` caps **internal corrections at 1** on one index. This runtime can switch tools, which looks like a reason to raise the cap ("we haven't tried graph yet"). That is how you buy three full retrieve-grade cycles on a lookup that should have been hybrid once. LLM self-reported confidence is not a stop condition. LangGraph `recursion_limit` is not a product budget.

Leftover iteration budget carried across turns is a second unbounded agent: a 20-turn chat with 2 leftover hops per turn is 40 silent retrieves.

**Decision**: Per **user message**: first tool call is iteration 0; `max_iterations` extra hops (working **2**). Token accumulator and wall-clock deadline checked **before** every LLM and tool call. Exceed → Escalate (`breaker_tokens` / `breaker_time`). Graph max-steps (working 12) is a third fuse. Decrement **before** re-entry, including degrade-ladder hops. Strategy switch **consumes** an iteration. Budgets **reset from config** each message; leftovers do not carry. The breaker cannot be disabled to save p95. Config change is a deploy.

**Consequences**:
- (+) Finite bill and a testable stop.
- (+) Switch is not a free extra architecture.
- (–) Some questions that would have succeeded on hop 4 will refuse. That is the point; raise only with a signed measurement, not in an incident.
- (–) Wall-clock includes slow graph tools; a mis-route to graph can trip `breaker_time` before a switch. Heuristic/default hybrid exists to make that rare.
- **Alternative rejected**: `until confident` with model-verbal stop. Not an edge label.
- **Alternative rejected**: Timeout only (30s HTTP). A stuck loop can still issue 20 LLM calls inside 30s.
- **Alternative rejected**: Carry unused hops across turns. Unbounded-by-chat-length.
- **Revisit trigger**: Phase 6 shows hop-2 (third retrieve) wins a signed slice without blowing p99. Then `max_iterations=2` stays or becomes 1 if hop-2 never helps (the more common outcome).

## ADR-006: Typed Grader Verdict as the Stop Condition, Not Verbal Confidence

**Status**: Accepted

**Context**: Agents like to say "I have enough to answer." They are often wrong. `rag-selfheal` ADR-004 already made structured grades the branch. This project inherits that and adds a temptation: skip grade when the router `confidence` is high. That deletes observation on the path you were most sure about — the path that still mis-routes.

Using the generator as the grader ("if you cannot answer, call another tool") pays for a completion to learn you should not have generated, and trains a loop.

**Decision**: After every successful tool call, **one** structured grade of the window vs `resolved_question`. Verdicts `sufficient` | `ambiguous` | `insufficient`. `sufficient` iff enough **KB** chunks are relevant; memories never suffice. Parse failure is not sufficient. Router `confidence` is telemetry only. Generate is not allowed to request tools.

**Consequences**:
- (+) Same honesty as CRAG; comparable metrics.
- (–) Grade LLM + window tokens on every hop; primary tax.
- (–) False sufficient / false insufficient remain; calibration is Phase 3, not a hope.
- **Alternative rejected**: Stop when the policy's confidence > 0.8. Miscalibrated and ungraded.
- **Alternative rejected**: Skip grade on naive lookups. Looks good on p95; reopens the open loop on the majority mix.
- **Alternative rejected**: Generator-as-grader. Wrong bill, wrong node.
- **Revisit trigger**: same as `rag-selfheal` — if the grader cannot beat a coin flip against labels, do not route on it; you do not have an agentic runtime, you have a slower chain.

## ADR-007: Failure Ladder — Next Strategy, then Naive, then Refuse — Not a Retry Storm

**Status**: Accepted

**Context**: When hybrid 500s, the "agentic" instinct is to call hybrid again. When graph times out, the instinct is to wait. Retry storms are how a degraded dependency takes the assistant from 1.5s to the wall-clock cap while a working naive service sits unused.

Parallel fallback (call naive while hybrid is in flight) is a valid latency trick and a **complexity** increase (hedged requests, wasted work). v1 does not need it.

**Decision**: On timeout, 5xx, adapter error, open circuit, or identical-hop skip: pick the next **untried** tool on `graph_rag → hybrid_rag → naive_rag` whose circuit is closed. Each ladder step decrements iterations. No same-tool retry except optional single 429 with Retry-After ≤ 200ms (default **off**). If the ladder and budget are exhausted → `cannot_answer` / `tool_ladder_exhausted`. Never generate from a failed tool's empty body. Never retry until the deadline as a substitute for the ladder.

**Consequences**:
- (+) A down graph does not kill lookups if hybrid/naive still work.
- (+) Finite extra QPS to remaining services (still real — size for it).
- (–) Naive as last resort can false-answer a relational question if the grader is lenient. Prefer refuse if grade is insufficient; the ladder is for **errors**, not for insufficient-but-healthy responses (those take Reformulate, which may switch tool *by policy*, not by ladder).
- **Clarify**: ladder = dependency failure. Reformulate/switch = healthy response, bad context. Do not conflate in code.
- **Alternative rejected**: Retry same tool 3×. Amplifies outages.
- **Alternative rejected**: Fail the request on first tool error. Fragile; one dependency becomes a SPOF for all query shapes.
- **Alternative rejected**: Hedged parallel tools in v1. Costly; hides policy.
- **Revisit trigger**: measured 429 rates on a tool; then a *bounded* retry on that tool only, still inside wall-clock.

## ADR-008: Per-User Memory Isolation as a Required Predicate, Not a Column Convention

**Status**: Accepted

**Context**: Optional `user_id`, session keys that are only `session_id`, and global ANN over memories are how User A's employee id appears in User B's prompt. Multi-tenant RAG security is a whole project ([`prj--multi-source-rag-access-control`](../../prj--multi-source-rag-access-control/)). This runtime still stores **user-specific** text. Isolation is not postponable.

**Decision**: Every Redis key includes `user_id`. Client `session_id` is looked up as `sess:{user_id}:{session_id}`; mismatch → 404, not merge. Every `ltm_memory` read/write `WHERE user_id = $authenticated_user`. `user_id` NOT NULL. v1 recall scans the caller's rows only (no global kNN). Isolation tests in CI (two users, empty intersection). Forget-me deletes/revokes that user's rows and embeddings. No anonymous LTM. No org-wide memory in v1.

**Consequences**:
- (+) Leak is a failed test, not a production surprise — if the test exists.
- (–) No "shared team memory" (a real product ask). Refuse it in v1; it needs ACL documents this project does not own.
- (–) Session-id-in-URL without auth is useless by design; auth is required.
- **Alternative rejected**: `user_id` default `'default'`. That is one shared brain.
- **Alternative rejected**: Global memory ANN with post-filter. Post-filter bugs leak; sequential scan of 200 rows does not need ANN.
- **Revisit trigger**: a signed team-memory product with a real ACL model — different project, likely §1.3 + this runtime's LTM redesigned.

## ADR-009: Serial Single-Tool Hops; Context Packed with Memories Untrusted and Below KB Chunks

**Status**: Accepted

**Context**: Two packing failures: (1) memories stuffed above the retrieved policy, so the model answers from a preference and ignores the handbook; (2) full chat history including assistant answers, so yesterday's hallucination is in-context without being a "memory." [`prj--context-forge`](../../prj--context-forge/) already frames this as a budget. This ADR pins the **priority** for this route.

Serial hops exist so the bound remains obvious. Parallel multi-tool is ADR-002's rejected ensemble.

**Decision**: One tool call at a time. Generate packing order: system rules → resolved question → kept KB chunks → tagged memories → last 2 **user** turns (no assistant answers). Drop from the tail of that list under budget; never drop system rules to fit memories. Memories do not receive document citations.

**Consequences**:
- (+) Lost-in-the-middle still exists, but memories cannot legally crowd out the grade-kept evidence first.
- (+) Prior assistant errors are less likely to be copied forward.
- (–) Follow-ups that needed the assistant's previous clarification text may resolve worse; the resolver should use **user** turns and memories, not the model's last essay.
- **Alternative rejected**: Append full transcript. Token blowup + hallucination echo.
- **Alternative rejected**: Memories first in the prompt "so the assistant feels personal." Personal and wrong.
- **Revisit trigger**: context-forge experiments on this route with measured faithfulness; packing order can change with numbers, not vibes.
