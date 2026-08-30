# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone pays for a router, a second grade, a graph hop, and a memory extractor on a question that was "what's the PTO cap."

The expected clever answer is: **LangGraph agent + naive/hybrid/graph as tools + Redis + Postgres memory + iterate until confident.** Those words are directionally the roadmap. They are not free, they do not make the router correct, they do not make memory true, they do not make the grader honest, and they do not fix a missing edge in Neo4j. Passing the interview by drawing a loop between three cylinders and skipping the bound is capitulation of a different kind. This page is the cost of not capitulating.

## 1. What I would build

A **bounded runtime** over tools you already have, with memory that is extracted and scoped.

- **LangGraph (or equivalent) explicit graph**, not ReAct-until-finish. [ADR-001](./04_architecture_decision_records.md#adr-001).
- **Adapters** to naive / hybrid / graph services; serial one-tool hops; prompted policy with default hybrid. [ADR-002](./04_architecture_decision_records.md#adr-002).
- **Redis session** (capped turns, TTL) and **Postgres LTM** (typed rows, per-user predicate). [ADR-003](./04_architecture_decision_records.md#adr-003).
- **Extract + filter** writes; memories untrusted and below KB in the prompt. [ADR-004](./04_architecture_decision_records.md#adr-004), [ADR-009](./04_architecture_decision_records.md#adr-009).
- **Shared iteration budget** for reformulate *and* switch; token + wall-clock breaker. [ADR-005](./04_architecture_decision_records.md#adr-005).
- **Typed grade as stop**, memories never suffice. [ADR-006](./04_architecture_decision_records.md#adr-006).
- **Error ladder** vs **healthy-but-insufficient switch**, distinguished. [ADR-007](./04_architecture_decision_records.md#adr-007).
- **Isolation tests**. [ADR-008](./04_architecture_decision_records.md#adr-008).

I would not wrap three notebooks as LangChain tools and call the recursion limit a bound. I would not embed every chat turn. I would not call all three retrievers "to be safe." I would not enable this route as the company-wide RAG middleware.

If Phase 0 shows **one gold topology for ~all traffic** and **no real cross-session requirement**, this whole runtime is overkill. Ship [`prj--rag-selfheal`](../../prj--rag-selfheal/) (or hybrid alone) plus, if follow-ups matter, Redis session resolve *on that pipeline*. The clever answer is for when **wrong topology is expensive** and **state across turns/sessions is a signed requirement** and you have labels for both.

## 2. What I would give up

Be explicit. These are not "later." They are not in v1, and some of them are never in this design.

**Single-pass latency as the SLO.** Happy path already adds recall + route + grade + extract. Switch path is another tool (often the slow graph) + another grade. Anyone quoting naive-RAG p95 for this system is lying or has deleted the runtime. The tax is the point of the scenario.

**Determinism.** Strategy choice × grade × rewrite is a combinatorial test surface. Temperature-0 on policy/grade reduces variance; it does not make the system a function. Eval must report disagreement across seeds or accept that one frozen run is a snapshot.

**The cheap chain and the cheaper CRAG-on-one-index.** Operability now includes three adapters, Redis, LTM filters, isolation, breakers, and a dashboard that splits paths *and* tools. That is more parts than `rag-selfheal`, which was already more parts than naive RAG.

**A guarantee the router is right.** Prompted tool choice will mis-route. Graph-on-lookup taxes everyone. Naive-on-relation misses paths. Always-hybrid may beat the router. If it does, the router was vanity.

**A guarantee the grade is right.** Same as CRAG. False sufficient → wrong answer, slower. False insufficient → hop to max, bill.

**A guarantee memory is true or kind.** Extractors store the wrong preference, miss the right one, and — if filters fail — store injection. Stale "I am on Team X" outlives a transfer. Memory is untrusted context with a TTL, not a profile database of record.

**A fix for missing documents or missing graph edges.** Switching tools cannot mint coverage. Three hops then refuse is success. Product will still hate it.

**Always-answer UX.** Refuse is the honest terminal. The lying bot wins demos.

**Unbounded "until confident."** Confidence is not an observable you have. `max_iterations=2` will feel stingy; it is the architecture.

**Learned policies, MCP, multi-agent, org memory, extra tools.** Out of scope. Adding them to pass a gate is a failed gate.

**Cheap eval.** Single-turn FAQ sets cannot certify this. You need gold-strategy tags, dialogues, poisoning, isolation. That labeling is the actual project duration.

## 3. What I would ask for, even though I expect friction

Ask **once, in writing, in Phase 0**. Silence is not "they meant we can add 6 seconds and store chat forever."

Ask product:

1. **Is strategy diversity real?** Show three query shapes that *need* three tools, with corpus evidence the graph can actually answer the relational ones. If they cannot, do not build a three-tool router.
2. **Is cross-session memory a requirement or a slide?** If they will not ship "what we remember" + forget-me, I will not write LTM.
3. **What is acceptable p95 / p99 vs today's RAG, including the switch path?** Working illustration: happy ~2× naive; switch ~3–5×; p99 up to ~5–8× if graph is involved. If they need "must stay under 1.3× always," they have forbidden this runtime (or they skip graph and skip retries, which is hybrid+grade, i.e. `rag-selfheal`).
4. **Will you ship `cannot_answer`?** If no, they want generate-anyway with extra steps.
5. **What mis-route rate is acceptable?** If they expect 100% optimal tool choice from a prompt, they have not used a router.

Ask eval / domain experts:

6. **Who labels gold tool, gold constraints for follow-ups, and poisoning items?** Without this, Phase 2 is vibes.
7. **Holdout must be multi-turn and cross-session**, not 20 paraphrases of the handbook.

Ask engineering / security:

8. **Are the three services actually deployed with contracts you can adapter to?** A paper graph RAG is not a tool.
9. **QPS headroom on each service × retry/mis-route.** Graph is usually the fragile one.
10. **Identity on every request; Redis and Postgres ownership.** Isolation is a ship gate.
11. **Confirm skip-grade and skip-breaker are not load-shed levers.**

What I would **not** ask for: a fine-tuned router in v1, LangGraph Cloud, a fourth tool "just in case," org-wide memory, Kubernetes HPA on the graph workers.

## 4. Complexity inventory (what those clever words cost)

| You take on | You shed |
| --- | --- |
| Explicit graph, three adapters, two stores | The fantasy that one pipeline fits all queries and all turns |
| Prompted router + gold-strategy eval | Always-hybrid simplicity (you may have to *return* to it) |
| Grade on every hop | Open-loop hope; verbal confidence |
| ~1.6–5× latency/cost vs naive depending on path | Sub-second FAQ as a given |
| Redis + Postgres LTM + filters + forget-me | `chat_history` concatenation as "memory" |
| Isolation tests and poisoning probes | Optional `user_id` |
| Breaker + ladder + identical-hop skip | Retry storms and recursion-limit-as-product |
| Combinatorial eval | A notebook that looked good on five questions |
| Explaining why a lookup got slower | Pretending routing is free |
| Refuse UX | Fluent empty-context answers |

Net: **more parts, in the right places, stacked on top of CRAG's already-expensive parts.** Naive RAG is simple and blind. Hybrid+rerank is a better first retrieve. `rag-selfheal` observes and sometimes recovers on **one** index. This runtime adds **choice** and **state**. Each addition is a tax. The interview is whether you name the taxes and kill the layers that do not pay rent.

### Cost / latency multiplier (order of magnitude)

| System | Typical extra vs naive `1R+1G` | When it is the right system |
| --- | --- | --- |
| Naive RAG | 1.0× | Tiny corpus, demo, baseline |
| `retrieval-x` hybrid+rerank | ~1.1–1.4× (rerank) | Exact tokens, quality table |
| `rag-selfheal` happy | ~1.4–1.8× | One topology, observed insufficiency |
| `rag-selfheal` + 1 correction | ~2.5–3.5× | Same, first window bad |
| This runtime, happy hybrid, first turn | ~1.6–2.2× | Follow-ups later; router correct |
| This runtime, follow-up + resolve | ~1.8–2.5× | Session actually used |
| This runtime, one switch onto graph | ~3–5× | The only slice that *needs* this project |
| This runtime, max hops | ~5–8× | Must be signed p99; often a fail of routing |

If 80% of traffic is the first row of this table's *need*, putting 100% of traffic on the last three rows is how you light money on fire.

### What is not worth building

- Unbounded ReAct with a timeout sold as a breaker.
- Transcript-embedding "memory."
- Parallel try-all-tools as v1 agentic.
- A learned router before gold labels exist.
- Org-wide memory with no ACL design.
- Skipping grade when router confidence is high.
- `max_iterations` as an on-call slider.
- Company-wide agentic-RAG wrapper.
- Extra tools (web, SQL, email) "because agents have tools."
- Claiming eval is done with a single-turn set.

## 5. When I would not do this

- **One topology wins.** Phase 0 gold-strategy labels are 90% hybrid (or 90% naive). Keep that pipeline. Add session resolve if follow-ups hurt.
- **Graph gold items cannot be answered by the actual graph.** Then graph is not a tool. A two-tool router (naive vs hybrid) may still be weaker than always-hybrid; measure; probably skip.
- **No cross-session requirement** and follow-ups can live in the client. Then you wanted `rag-selfheal`, not LTM.
- **Latency budget cannot absorb route+grade**, let alone a graph hop. Then you cannot observe or choose. Improve the one index or accept open-loop.
- **No willingness to label gold tools, dialogues, poisoning.** Kill. Branching without labels is a résumé graph.
- **Product forbids refuse and forbids showing memories.** They want a lying, forgetful-or-quietly-hoarding bot. Do not launder it through LangGraph.
- **The real problem is chunking, freshness, extraction precision, or ACL.** The agent will loop and refuse. Spend the quarter on the index.
- **QPS is a firehose.** Agentic-per-request will dominate. Different design.

When I **would** do this: an internal assistant where (a) the mix **measurably** includes lookup, exact-token, *and* relational questions the graph can answer, (b) users return and correct themselves across turns/days, (c) wrong-topology answers are expensive, (d) product signs slower p99, refuse UI, and visible memory, (e) the three services exist as dependencies, (f) security signs per-user isolation. Then this runtime is the design, and this document is the bill.

Even then I would **phase** it so the router can die without killing session memory (see [Phased Implementation Plan](./06_phased_implementation_plan.md)). The synthesis story is composition with kill switches, not a monolith of cleverness.

## 6. Memory-specific risks (read this twice)

**Poisoning.** User sarcasm, injected "preferences," assistant hallucinations extracted as facts. Next session these are in the prompt. Filters are brittle. Probes are the gate. If probes fail, **writes off**.

**Staleness.** Team, region, "use the runbook" after the runbook was deprecated. TTL and upsert and a UI. No TTL is how memory becomes a second stale index.

**Privacy.** Employee identifiers, health, compensation accidentally extracted. This route is a KB assistant; over-retention is a data incident. Forget-me must include embeddings.

**Cross-user leakage.** The career-ending bug. Required predicates, no global ANN, CI isolation test. Do not "add multi-tenant later."

**Eval echo.** Memory helps the eval because the eval dialogue stuffed the answer into a preference. Separate memory probes from KB questions. A preference should change *which doc is preferred*, not *invent the PTO cap*.

**Junk drawer.** Summaries every turn evict preferences. Cap and priority (preferences survive). Soak test.

## 7. Why evaluation is qualitatively harder

Naive RAG eval: 20 questions, was the chunk in top-k, was the answer supported. Painful but one-dimensional.

This runtime adds:

- **Gold strategy** per item (router accuracy).
- **Iteration depth** (did we loop when we should not / not loop when we should).
- **Multi-turn scripts** (constraint carry).
- **Cross-session scripts** (preference recall after TTL-of-session).
- **Poisoning and isolation** (security as eval, not a footnote).
- **Non-regression on lookups** (the political metric).
- **Cost/latency by path** (the finance metric).

A single "faithfulness went up 0.04" is eval theater. Phase 6 is a **table with slices**, or it is not done.

Variance: run the holdout more than once if any node is non-zero temperature. Report it. Hiding variance is how you overfit a lucky graph walk.

## 8. What this does not solve

- Bad chunking, stale crawl, failed graph extraction, missing BM25.
- Faithfulness of the completion (sufficient context, wrong summary).
- Prompt injection against *write* tools (there are none here; the moment you add them, this design is insufficient — go to harness/HITL projects).
- MCP interoperability, multi-agent debate, org-wide assistants.
- A learned optimal policy.
- Sub-second p95 on graph-backed questions.

## 9. Pushing back on the prompt (the actual interview)

The prompt is constructed so you either **draw LangGraph + Redis + Postgres and smile**, **ship unbounded ReAct**, or **say "just use hybrid."** This project is the middle, with the pushback stated:

1. **A chain cannot pick a strategy or remember.** If they wanted a chain, they should not have asked for agentic RAG with memory.
2. **An unbounded loop is not a runtime.** Max iterations, tokens, wall-clock, decrement-before-reentry. Recursion-limit is not a product.
3. **Memory is not a vector dump of the chat.** Extraction, filters, isolation, untrusted packing. Otherwise you built a second poisoned corpus.
4. **The router is prompted, not learned, and may lose to always-hybrid.** Measure; kill the router if it loses. That is architectural maturity, not a failed demo.
5. **This is the most expensive Tier 2 RAG you can build without adding side-effecting tools.** Most products should not. The portfolio value is the *runtime* write-up and the kill criteria, not the loop on a slide.

If they insist on "keep calling tools until confident" with no refuse, they have asked for the outage. If they insist on storing every interaction forever, they have asked for the leak and the junk drawer. If they insist on three tools without a graph that answers any gold item, they have asked for a costume.

## 10. Bottom line

Build a **bounded LangGraph runtime** that treats Tier 1 retrievers as tools, grades before it generates, switches or degrades inside a shared fuse, and remembers users through **extracted, scoped, visible** memory. Pay a real latency and eval tax. Do not build it if Phase 0 cannot show strategy diversity and a memory requirement. Do not let any layer (router, loop, LTM) survive a failed gate by merging into the next phase. The synthesis of Tier 1 is composition with honesty, not a Russian doll of every paper at once.
