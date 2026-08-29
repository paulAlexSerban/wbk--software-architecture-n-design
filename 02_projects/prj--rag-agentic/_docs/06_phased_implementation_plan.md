# Agentic RAG Runtime — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not "we already know we need an agent."** Building a router against a mix that is 90% hybrid lookups is how you 3× a FAQ bill. Building long-term memory before isolation tests is how you leak. Building the loop before the grader is calibrated is how you buy hops that do not help.

Phases 0–6 are sequential. Calendar is **weeks, not a weekend**: dominated by labeling (gold strategy, dialogues, poisoning) and by sibling services actually existing. Anyone who schedules "LangGraph + Redis + Postgres + three tools + eval" as one phase has not read [Trade-offs](./05_tradeoffs_and_honest_assessment.md).

Rollback/kill criteria at the bottom apply at every phase. In particular: **do not add unbounded ReAct, transcript dump, try-all-tools, or extra side-effecting tools to pass a gate.** That is a failed gate, not a shortcut.

## Phase 0 — Mix, Gold Strategy, Dialogues, Pins (before the graph)

**Objective**: Prove that *this* runtime has a job: more than one topology appears in gold labels, follow-ups/memory matter, and the three (or fewer) tools exist. Replace "we need agentic RAG" with numbers.

**Deliverables:**
- Written product answers to the [Trade-offs §3](./05_tradeoffs_and_honest_assessment.md#3-what-i-would-ask-for-even-though-i-expect-friction) questions: strategy diversity, LTM yes/no + visible memories, p95/p99 multiples, refuse UI, acceptable mis-route rate.
- **Tool inventory**: URLs/contracts for naive, hybrid, graph. For each: exists / not built / exists but cannot answer relational gold. **Absent tools are dropped from the allowlist in writing.**
- **Eval set v0**, frozen, working floors:
  - ≥ 40 single-turn items with **gold_tool** ∈ {naive, hybrid, graph} — and if graph is in the allowlist, ≥ 8 gold-graph items a human confirmed the *graph actually contains a path for*.
  - ≥ 10 **two-or-more-turn** dialogues (follow-up constraints).
  - ≥ 5 **cross-session** preference probes (session A writes, session B later must use).
  - ≥ 5 **poisoning** items (sarcasm, injection, "store this secret," KB-shaped false "preference").
  - ≥ 2 **isolation** scripts (two users).
  - ≥ 5 **out-of-corpus / missing-edge** items that must refuse.
  - Lookup / exact-token / relational slices reported separately; also a **traffic-weighted** mix estimate.
- Scoring rubric: gold_tool match (Y/N), iterations, supported-by-KB (Y/N), memory_leak / poisoning_persisted (Y/N), latency, tokens. Not a vibe score as primary.
- Pins: `max_iterations=2`, wall-clock, token cap, memory token budget, TTLs, model ids for route/grade/generate/extract, packing order.
- Cost/QPS sketch: 20% switch rate, 10% graph share, grade every hop. Write down whether siblings and the LLM provider survive.
- One-page unknowns log.

**Exit Gate:**
- [ ] Product signed strategy diversity **or** explicitly chose always-one-tool. If one-tool: **kill the router** (you may continue Phase 1–2 for session only, then skip 3).
- [ ] If LTM required, product signed GET/DELETE memories. If not, **LTM off** (Redis only); skip Phase 4 writes.
- [ ] Refuse UI signed **or** project killed (cannot have generate-anyway and this runtime).
- [ ] Latency multiples signed or project scoped down (no graph tool, `max_iterations=0` extra hops = route-once-no-retry — which is "router + one retrieve + grade," still not cheap).
- [ ] Eval set frozen with the categories above **before** prompt fiddling on the router.
- [ ] Graph gold items verified against the real graph, or graph removed from allowlist.
- [ ] Feasibility: each remaining tool has a retrieve contract the adapter can call without the model inventing Cypher.

Do not "start the LangGraph in parallel" before this gate.

## Phase 1 — Session Runtime, Fixed Tool, No Router, No LTM Writes

**Objective**: Follow-ups work with Redis + resolve + **one** frozen tool (working: `hybrid_rag`) + generate. Prove session isolation and per-turn budget reset **before** adding choice or durable memory.

**Deliverables:**
- Ask API, auth, Redis session keys with `user_id`, bind check, turn cap, TTL.
- Question resolver (heuristic skip on empty session).
- Adapter to **one** tool. Grade node **may** be shadow (log only) or omitted until Phase 3; if omitted, this phase is "session + hybrid," not CRAG — label it honestly.
- Per-message budget object exists and resets; even with one hop, leftover-budget-across-turns tests must pass.
- Isolation: user B cannot resume user A's `session_id`.
- Eval: follow-up dialogues vs no-session baseline (raw turn 2 only).

**Exit Gate:**
- [ ] Follow-up slice: constraint carry beats no-session baseline on the frozen dialogues.
- [ ] Isolation test green.
- [ ] Budgets reset per message (unit test).
- [ ] Lookup single-turn latency vs calling hybrid directly is measured (should be resolve-skip + small overhead). If it is already > signed lookup budget, **stop** — a router will not make it faster.
- [ ] No Postgres LTM writes. No second tool.

If follow-ups do not improve, debug resolve/session; do not add a router to compensate.

## Phase 2 — Tool-Selection Policy in Shadow (still one live tool)

**Objective**: Put the structured (and heuristic) policy on the resolved question, **log** `chosen_tool` vs `gold_tool`, **do not** call the chosen tool yet if it is not the frozen Phase 1 tool. Measure whether a router would pay rent.

**Deliverables:**
- Policy node: heuristic + LLM enum; invalid → hybrid; telemetry `confidence` unused for branching.
- Confusion matrix vs gold_tool on the single-turn holdout.
- Predicted cost: if we *had* routed live, graph share and latency using Phase 0 tool timings.
- Graph runtime wired; **live retrieve still frozen tool** (or live route only on a dark slice that cannot affect users).

**Exit Gate:**
- [ ] Router accuracy **beats always-hybrid** (and beats always-gold-majority) by a margin written in Phase 0. Working kill: accuracy ≈ chance, or graph-predicted share would blow the cost sketch for no quality story.
- [ ] Heuristic precision on exact-token / relational patterns reported. If heuristic is the only thing that wins, consider shipping heuristic-only (no LLM route) — that is a successful reduction.
- [ ] Lookup items are not majority-routed to graph.
- [ ] Shadow only. Claiming "agentic tool use" in this phase is a failed gate.

If the router loses to always-hybrid: **kill the policy**. Continue with Phase 1 session + later grade/loop on **one** tool (you have reinvented `rag-selfheal` + session). That is an acceptable outcome. Do not proceed to Phase 3 live routing.

## Phase 3 — Live Routing + Bounded Grade Loop (LTM still off)

**Objective**: Call the selected tool, grade, reformulate/switch inside `max_iterations`, refuse when insufficient. No durable memory writes yet (fewer poisoning variables). Calibrate the grader as in `rag-selfheal` Phase 2–3, now with `tool_id` in the log.

**Deliverables:**
- Grade schema; parse-fail conservative; memories not in play.
- Live Select → Call → Grade → Reformulate/switch or Generate or Escalate.
- Decrement-before-reentry tests; identical-hop skip; `max_iterations` extra hops.
- Shadow-then-live grader: if uncalibrated, **do not** enable switch (route-once + grade + refuse/generate only).
- Eval: gold_tool match **and** end-to-end support on slices; lookup non-regression; iteration histogram; switch-path latency.

**Exit Gate:**
- [ ] Grader parse_ok ≥ 90% on sample. False-sufficient / false-insufficient named and accepted (same kill idea as `rag-selfheal`).
- [ ] Sufficient queries do not iterate (test).
- [ ] After max hops, no further CallTool (test).
- [ ] Relational slice improves vs always-hybrid **or** the improvement is only on items the router got right — if live routing does not beat always-hybrid+grade (`rag-selfheal`-shaped), **revert live routing**, keep grade+session.
- [ ] Lookup slice latency/quality inside signed band.
- [ ] No LTM writes.

If the loop's extra hops never help (iteration_depth useful rate ~0): set `max_iterations=0` extra (route once). That is still a router product, cheaper. Do not raise the cap to "make hops useful."

## Phase 4 — Long-Term Memory Read/Write with Filters

**Objective**: Extracted LTM, recall on bind, packing order [ADR-009](./04_architecture_decision_records.md#adr-009). Poisoning probes must fail to persist. Only if Phase 0 signed LTM.

**Deliverables:**
- `ltm_memory` table, `user_id` NOT NULL, upsert, caps, TTL, revoke.
- Extractor + deterministic filters. Await with timeout; skip on timeout.
- Recall by recency/type (no global ANN).
- Packing: memories tagged, below KB, do not count as sufficient.
- GET/DELETE memories API.
- Cross-session probes; poisoning probes; 50-turn soak (preferences survive).

**Entry Gate:** Phase 3 green **or** you are on the one-tool reduction path with session+grade. LTM is independent of the router *if* product still wants it.

**Exit Gate:**
- [ ] Cross-session preference probes pass.
- [ ] Poisoning items are **not** in `ltm_memory` after the turn.
- [ ] Isolation: user B recall never contains user A ids (CI).
- [ ] Forget-me clears text and embeddings.
- [ ] KB-sufficient items do not regress when memories are packed (lost-in-the-middle probe).
- [ ] Extract skip on timeout does not fail the user-visible answer.
- [ ] If any poisoning probe fails: **writes off**, gate failed. Do not "fix" by summarizing harder.

## Phase 5 — Breakers, Ladder, Failure Injection

**Objective**: Prove the fuses. Chaos the tools. This is the runtime's reliability gate, not a feature sprint.

**Deliverables:**
- Per-tool circuit breaker; degrade ladder on errors (not on insufficient grade).
- Run-level token/wall-clock/max-steps fuses; tests that trip them.
- Chaos: hybrid 500s → expect naive or refuse, not retry storm; graph timeout → ladder; wall-clock short → `breaker_time` mid-graph.
- Dashboards: tool mix, iterations, breaker rate, refuse rate, extract skip, cost vs naive and vs `rag-selfheal` shadow.

**Exit Gate:**
- [ ] Same-tool retry storm test fails closed (does not happen).
- [ ] Ladder vs reformulate distinction covered by tests.
- [ ] Breaker cannot be skipped via config in the deployed "prod-like" profile used for the report.
- [ ] Open circuit on graph does not block hybrid lookups.

## Phase 6 — Baseline Capture (the actual done state)

**Objective**: Publish the table later work must beat, plus a failure-mode catalog with real examples. This phase is the product of a documentation-then-build effort.

**Entry Gate:** Phases 1–5 green as applicable (skipped router/LTM documented as reductions, not as "all features shipped"). Eval set still the Phase 0 freeze (adding items allowed; **deleting failures not allowed**).

**Deliverables:**
- Scored table **by slice**: lookup, exact-token, relational, follow-up, cross-session, poisoning, isolation, out-of-corpus. Columns: gold_tool, chosen_tool, iterations, supported-by-KB, poisoning_persisted, leak, latency, tokens, terminal.
- Comparison rows: naive (if runnable), always-hybrid+grade (`rag-selfheal`-shaped), this runtime.
- Failure-mode catalog matching [System Design §12](./03_system_design.md#12-known-failure-modes): real example or "probe attempted, did not fire."
- Pins dump: budgets, allowlist, model ids, packing order, corpus/tool versions.
- Narrative: where the router paid rent, where memory paid rent, where you should have killed a layer.
- Explicit statement of reductions (e.g. "graph removed," "max_iterations=0," "LTM off").

**Exit Gate:**
- [ ] Table complete; no dropped failing items.
- [ ] Catalog complete.
- [ ] Isolation and poisoning slices clean **or** LTM/session writes disabled and labeled.
- [ ] Pins dump sufficient to replay as a control for `agent-core` / `agent-harness` later.
- [ ] Honest recommendation: keep runtime / keep session-only / revert to `rag-selfheal`.

After Phase 6, **stop this project.** Next work is not "add MCP and email tools." Those are later roadmap items. v1.1 of this repo that adds unbounded hops or transcript dump is a regression, not an enhancement.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop and escalate — do not "make the agent nicer" — if any of the following hold:

1. **No strategy diversity / no memory requirement** after Phase 0 honesty. Redirect to `rag-selfheal` or hybrid. Do not keep the slide.
2. **Router loses to always-hybrid.** Kill the policy; do not fan-out-all.
3. **Graph gold is unanswerable by the graph.** Remove the tool.
4. **Grader uncalibrated.** Do not route on it; do not compensate with more hops.
5. **Poisoning persists** or **isolation fails.** Writes off; treat leak as incident if it reached a shared environment.
6. **Unbounded loop / forgotten decrement / breaker skipped** to save a demo. Revert; failed gate.
7. **Transcript dump or global ANN** introduced as "better memory." Revert.
8. **Side-effecting tools** (email, PR, SQL write). Wrong project.
9. **Eval theater**: single-turn only, failing items deleted, prompt iterated until the demo question routes to graph. Restore freeze.
10. **Ceiling**: this is not 50M-doc serving, not multi-tenant KB ACL (beyond per-user memory), not a platform. Scope breach → other repos.
11. **Product forbids refuse** or forbids memory visibility while demanding LTM. Kill LTM or kill the project.
12. **Phase 6 skipped** for a GIF. The project is not done.

Rollback is to the last phase whose exit gate was honestly green, including "router off, LTM off, session+hybrid+grade only." After a kill, stakeholders still get: mix report, confusion matrix, probe results, and a recommendation — shrink to `rag-selfheal`+session, drop graph, or accept the tax. They do not get "production agentic RAG" this design never promised.
