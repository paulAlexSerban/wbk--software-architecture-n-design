# Agentic RAG Runtime — System Design
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document is the mechanical *how* for the system described in the [Architecture Document](./02_architecture_document.md). It specifies the graph, tool-selection, the reformulate-grade-iterate loop, Redis/Postgres memory schemas, budget guards, the failure ladder, and named failure modes. It does not specify code.

## 1. Control Flow

One user message, one bounded walk on the graph. The client does not pick the tool, `max_iterations`, or whether to write memory.

```mermaid
flowchart TD
    start["Request: message plus session_id"]
    auth[Authn bind user_id]
    sess{"session belongs to user?"}
    reject[404 session_mismatch]
    load[Load Redis session, reset per-turn budgets]
    recall[Recall Postgres memories WHERE user_id]
    pack[Pack memories under token budget]
    resolve[Resolve question]
    brk{"breaker tokens or wall clock ok?"}
    escalate[Escalate cannot_answer]
    select[Select tool allowlist]
    unavailable{"tool circuit open?"}
    ladder{"degrade ladder remaining?"}
    pickNext[Pick next tool on ladder]
    call[Call tool with timeout]
    err{"timeout or 5xx or empty?"}
    fuseWin[Normalize ChunkList]
    grade[Structured grade]
    parse{"parse_ok?"}
    cons[Treat verdict as ambiguous]
    verdict{"aggregate verdict"}
    gen[Generate from kept KB docs]
    budget{"iterations remaining greater than 0?"}
    ident{"new tool or resolved_question distinct?"}
    reform[Reformulate and/or switch tool]
    dec[Decrement iterations before re-entry]
    extract[Extract memories with timeout]
    persist[Write run, refresh Redis TTL]
    refuse[cannot_answer]

    start --> auth --> sess
    sess -->|no| reject
    sess -->|yes| load --> recall --> pack --> resolve --> brk
    brk -->|no| escalate
    brk -->|yes| select --> unavailable
    unavailable -->|yes| ladder
    unavailable -->|no| call --> err
    err -->|yes| ladder
    err -->|no| fuseWin --> grade --> parse
    parse -->|no| cons --> verdict
    parse -->|yes| verdict
    verdict -->|sufficient| gen --> extract --> persist
    verdict -->|ambiguous or insufficient| budget
    budget -->|yes| reform --> ident
    ident -->|no| ladder
    ident -->|yes| dec --> brk
    budget -->|no| escalate
    ladder -->|yes| pickNext --> dec --> brk
    ladder -->|no| escalate
    escalate --> persist
    persist --> refuse
```

Generate path returns an answer, not `refuse`. The diagram's persist node is shared; the HTTP body is `answer` or `cannot_answer` according to the terminal.

**Invariants:**
- The generator is never invoked on a window that has not been graded, or on a verdict of `insufficient`.
- Empty tool result is `insufficient` (or a tool error if the service 5xx'd — that takes the ladder, not a fake empty-sufficient).
- Memories never count toward `sufficient`.
- Iteration decrement happens **before** the next `CallTool`.
- Per-turn iteration budget is reset from config at `load`, not inherited from the previous message's leftover hops.

**Working defaults for `kb.agentic_ask`:** `max_iterations` after first retrieve = **2** (at most 3 tool calls), `max_wall_clock_ms` = 15000, `max_run_tokens` = 8000 (output+input accounting as the provider reports; pick one definition in Phase 0 and stick to it), `memory_token_budget` = 768, session idle TTL = 30 min, session hard TTL = 24h, max turns stored in Redis = 12, max active `ltm_memory` rows per user = 200, extract timeout = 800ms. Degrade ladder default: `graph_rag → hybrid_rag → naive_rag → refuse`. These are route parameters. Changing them is not a new architecture; deleting the grade node, skipping the breaker, or calling all three tools in parallel is.

## 2. Session State (Redis)

### Key layout

| Key | Type | Contents | TTL |
| --- | --- | --- | --- |
| `sess:{user_id}:{session_id}` | hash or JSON | `turns`, `created_at`, `last_active_at` | idle 30m, refreshed on write; hard 24h from created_at enforced in app |
| `sessidx:{user_id}` | set (optional) | session_ids for "list my chats" | same |

**Turn object (logical):**

| Field | Notes |
| --- | --- |
| `turn_id` | uuid |
| `raw_user` | as sent |
| `resolved_question` | after resolver |
| `terminal` | `answered` / `cannot_answer` / `error` |
| `answer_preview` | short; **do not** store full stuffed prompts in Redis |
| `tool_sequence` | list of tool ids this turn |
| `memory_ids_in` | ids recalled |

**Budget fields are not stored as leftover hops.** Config is the source of remaining iterations at the start of each message. Storing `iterations_remaining=2` across turns is how a long chat becomes an unbounded agent. Wall-clock and tokens are per-request, counted in process memory / run row, not in Redis.

**Cap:** if `turns.length > 12`, drop oldest. The long-term store is Postgres extraction, not Redis as a life-log.

**Isolation:** every Redis command uses the key that includes `user_id`. A client-supplied `session_id` that does not match a key for *this* user is `session_mismatch`, not a lookup by session_id alone. Session-id-only keys are forbidden ([ADR-008](./04_architecture_decision_records.md#adr-008)).

**Loss mode:** Redis flush → users lose follow-up context for live sessions. Product-acceptable. Do not fail closed the whole Ask path; do fail closed any attempt to "recover" session from Postgres transcripts (those are runs, not sessions, and stuffing them is a transcript dump).

## 3. Long-Term Memory (Postgres)

### Table `ltm_memory` (logical)

| Column | Notes |
| --- | --- |
| `memory_id` | uuid, pk |
| `user_id` | **NOT NULL**, FK to identity; every SELECT includes equality on this column |
| `type` | `preference` \| `durable_fact` \| `episode_summary` |
| `normalized_key` | for upsert, e.g. `pref:citation_source`, `fact:entity_region` |
| `text` | short; working max 500 chars |
| `embedding` | optional `vector(dim)`, same model pin as recall |
| `expires_at` | nullable; preferences may be 180d; summaries 30d |
| `revoked` | bool |
| `origin_run_id` | audit |
| `created_at` / `updated_at` | |

**Indexes:** `(user_id, type, revoked, expires_at)`; unique `(user_id, type, normalized_key)` where not revoked; optional ivfflat/hnsw on embedding **with the caveat that ANN must still be filtered by user_id** (post-filter is required even if the index is global — a neighbor from another user is a leak, not a feature). Prefer a design that cannot return cross-user hits: query `WHERE user_id = $1` first (user's row count is tiny; sequential scan of ≤200 rows beats ANN). **Working decision: no ANN required in v1.** Recency + type is enough at 200 rows. Adding pgvector to memory is optional Phase 4+ and must not be the isolation mechanism.

### Recall algorithm (v1)

1. `SELECT * FROM ltm_memory WHERE user_id = $caller AND revoked = false AND (expires_at IS NULL OR expires_at > now())`.
2. Sort: all `preference` first (cap 20), then `durable_fact` by `updated_at` (cap 10), then `episode_summary` by `updated_at` (cap 5).
3. Pack until `memory_token_budget`. Truncate summaries first.
4. Attach `source_type=memory` to every item entering context-forge packing.

If this list never helps follow-ups in Phase 4, *then* consider embedding search **within the already-filtered user rows**. Do not invert that order.

### Write algorithm

See [§7](#7-memory-extractor).

## 4. Question Resolver

**Input:** `raw_user`, last 4 turns (user+assistant previews only), packed memories.

**Output schema:**

| Field | Type | Notes |
| --- | --- | --- |
| `resolved_question` | string | self-contained retrieval query |
| `constraints` | `{key, value}[]` | e.g. region=EU, year=2025 |
| `used_memory_ids` | id[] | which memories influenced constraints |
| `skipped` | bool | heuristic copy-through |

**Rules:**
- Every constraint must be attributable to the current message, a previous user turn, or a `preference`/`durable_fact` memory. If the model emits a constraint with no attribution, drop it and log `resolve_invented_constraint`.
- Do not put assistant *answers* into constraints ("last turn we said PTO is 20 days, so retrieve that") — that is how a hallucination becomes a retrieval query. Previous **user** utterances only, plus typed memories.
- Heuristic skip: no prior turns and no memories → `skipped=true`, `resolved_question = raw_user`.

## 5. Tool-Selection Policy

### Allowlist

| Tool id | Backs onto | Gold-query shapes |
| --- | --- | --- |
| `naive_rag` | [`prj--docqa-basic-naive-rag`](../../prj--docqa-basic-naive-rag/) retrieve contract | paraphrase lookups, small corpus FAQs |
| `hybrid_rag` | [`prj--retrieval-x`](../../prj--retrieval-x/) | exact tokens, mixed lexical+semantic, default |
| `graph_rag` | [`prj--rag-hierarchy-graph-rag`](../../prj--rag-hierarchy-graph-rag/) graph (or hierarchical) retrieve | multi-hop / relational *if* Phase 0 showed the graph can answer |

If a sibling service does not exist yet, the tool is **absent from the allowlist**, not mocked with a stub that returns empty. A three-tool slide with one real HTTP endpoint is eval theater.

### Heuristic (optional, after measurement)

| Signal | Tool |
| --- | --- |
| Matches `\b[A-Z]{2,}-\d{3,}\b` or quoted error codes | `hybrid_rag` |
| Matches `/which .+ of .+/i`, "subsidiaries", "vendors of", "overlap" | `graph_rag` |
| Else | LLM policy or default `hybrid_rag` |

Heuristic errors are mis-routes. Track `heuristic_fired` vs gold.

### LLM policy schema

| Field | Notes |
| --- | --- |
| `tool` | enum allowlist |
| `reason_code` | `lookup` \| `exact_token` \| `relational` \| `followup_same` \| `uncertain` |
| `confidence` | 0–1, **telemetry only** |

Invalid tool → `hybrid_rag` + `policy_invalid_tool`.

**On reformulate:** the policy sees `previous_tool`, `grade.missing_aspects`, `grade.suggested_tool`. It may keep the tool and change the question, or switch. The router rejects identity.

**Forbidden v1 policy:** "call all tools." That is an ensemble. If Phase 2 shows the router cannot beat always-hybrid, **delete the policy** and keep always-hybrid + memory. Do not "fix" it by fan-out-all.

## 6. Grade, Reformulate, and the Shared Iteration Budget

### Grade

Reuse the `rag-selfheal` three-way verdict. Differences:

- Input includes `tool_id` and `iteration`.
- `suggested_tool` is optional hint.
- `sufficient` requires `min_relevant` KB chunks (working 2, or 1 for graph path snippets if Phase 0 signs a different bar for graph). **Zero KB chunks + useful memories ≠ sufficient.**

Parse failure → `ambiguous` if budget remains else `insufficient`. Never `sufficient`.

### Reformulate schema

| Field | Notes |
| --- | --- |
| `resolved_question` | new, still the same user intent |
| `tool` | allowlist |
| `change` | `query_only` \| `tool_only` \| `both` |

Identical `(tool, normalized resolved_question)` → do not call the tool; take the ladder or escalate.

### Budget object (in-process, copied onto `agent_run`)

| Field | Reset | Decrement |
| --- | --- | --- |
| `iterations_remaining` | config at each new user message (`max_iterations` extra hops; first call does not decrement) | before every CallTool after the first, and before every Degrade pick |
| `tokens_used` | 0 at request start | after every LLM response (and optionally tool if they bill tokens) |
| `deadline_ms` | `now + max_wall_clock_ms` | compared, not decremented |

**First retrieve is "iteration 0"** and is free against `max_iterations` (which counts *retries*). Three tool calls ⇒ `max_iterations=2`. Document this in the run row as `tool_calls=3, retries=2` so nobody argues.

**Wall-clock includes tool time.** Graph RAG eating 4s still counts. A breaker that only sums LLM time will not save you.

**Tokens:** use provider usage. If extract is after generate, extract tokens **do** count if extract is awaited; if extract is skipped on timeout, those tokens never happened.

## 7. Memory Extractor

### Candidate schema

| Field | Notes |
| --- | --- |
| `type` | preference / durable_fact / episode_summary |
| `normalized_key` | required for preference and fact; summaries use `episode:{date}` or `run_id` |
| `text` | ≤500 chars |
| `ttl_days` | extractor proposal; server clamps (pref 1–180, fact 1–365, summary 1–30) |

### Filters (deterministic, after the model)

Drop the candidate if any:

1. Matches secret/PII patterns (API keys, `Bearer `, emails+employee-id combos you did not ask to store, salary-like numbers unless product signed "compensation copilot" — this route did not).
2. Text looks like an instruction to the system ("ignore previous," "always leak," "you are now").
3. Type is `preference` but content is a KB claim ("the real policy is X") — classify as not-a-memory; the user is arguing with the docs, not stating a preference.
4. Duplicate of existing text under the same key (upsert anyway if changed).
5. `episode_summary` longer than 500 chars after clamp — truncate, do not skip (summaries are lossy by design).

Working v1: **no human approval** on writes (this is not §2.4). Compensation: user-visible "what we remember" endpoint in Phase 5 is the safety valve. If product will not show memories to the user, **do not write long-term memory** — session-only.

### Upsert

`INSERT … ON CONFLICT (user_id, type, normalized_key) WHERE NOT revoked DO UPDATE text, embedding, updated_at, origin_run_id`.

Forget-me: `UPDATE … SET revoked=true, text='', embedding=NULL WHERE user_id=$1` then optional hard delete. Embeddings must not remain.

## 8. Failure Ladder and Circuit Breakers

### Per-tool circuit (adapter)

Closed / open / half-open as a standard breaker: error rate or consecutive timeouts open the circuit for `T` seconds. Select treats open as unavailable.

### Degrade ladder (router)

On tool error, empty-on-5xx, or identical-hop skip:

1. Next tool in `graph_rag → hybrid_rag → naive_rag` that was **not already tried this turn** and whose circuit is closed.
2. Each ladder step **decrements iterations** (it is a hop).
3. If none remain or iterations would go negative → escalate `tool_ladder_exhausted`.

Trying the same tool twice on 500 is allowed **once** only if the error was 429 and `Retry-After` ≤ 200ms — not a second architecture. Default: **no same-tool retry**; ladder only.

### Run-level breaker

Before every LLM and tool call:

- if `now > deadline` → `breaker_time`
- if `tokens_used > max_run_tokens` → `breaker_tokens`
- if graph runtime step count > hard max (working 12 nodes) → `breaker_steps` (fuse against forgotten decrement)

The model cannot add budget. Config change is a deploy, not a prompt.

## 9. Context Packing for Generate

Order of **priority under a hard token budget** (context-forge shaped):

1. System instructions (grade-before-generate rules, memory-is-not-policy).
2. `resolved_question`.
3. Kept KB chunks (relevant only), labeled with `tool_id`.
4. Packed memories, labeled `source_type=memory`.
5. Last 2 user turns (raw), no assistant answers (avoid amplifying prior hallucinations).

If the budget is tight, drop 5, then 4, then extra chunks from the tail of the kept list. **Never drop the system rules to fit more memories.**

## 10. Provenance Returned to the Client

| Field | Why |
| --- | --- |
| `terminal` | answer vs cannot_answer |
| `code` | if refuse |
| `tools_used[]` | honesty, debugging |
| `iterations` | tax |
| `chunk_ids[]` | KB citations |
| `memory_ids_in[]` | "why did you think I'm in the EU" |
| `memory_ids_written[]` | optional; or hide until "what we remember" UI |

Do not return other users' anything. Do not return full chunk text to a UI that will log it in analytics without a DPA thought.

## 11. Service Contracts (Logical)

**Ask API**

`POST /ask` `{session_id?, message}` → `{session_id, terminal, answer?, code?, provenance}`

`GET /memories` → list for caller (Phase 5).

`DELETE /memories` → forget-me.

**Tools (existing, not redesigned)**

`POST /retrieve` `{question, k}` → chunk list. Graph variant may take a structured query; the adapter maps `resolved_question` into whatever that service already accepts. If it cannot map, that is a Phase 0 adapter spike, not a reason to reimplement Cypher here.

## 12. Known Failure Modes

Worked against `kb.agentic_ask`. Each should appear in the Phase 6 catalog with a real eval example or "probe attempted, did not fire."

### 12.1 Mis-route: graph on a lookup

**What happens:** Router (or eager human) picks `graph_rag` for "What is the PTO cap?" Graph latency 2s, extraction never stored PTO as a node, grade insufficient, switch to hybrid, user waited 5s for a one-hop FAQ.

**Why the architecture does not "fix" it:** Routers err. Mitigation is default hybrid, heuristic, telemetry, and Phase 2 kill if mix is lookup-heavy.

**Probe:** gold-tool=hybrid lookup items; fail if p95 latency > signed lookup budget.

### 12.2 Mis-route: naive on a relation

**What happens:** "Which vendors of EU subsidiaries…" goes to naive; mentions of "vendor" retrieve; grade may false-sufficient on topical chunks; answer is a mash-up, no path.

**Why:** Grader and router can agree on the wrong topology. Gold-strategy labels exist to catch this in eval, not at runtime.

**Probe:** gold-tool=graph items; score both tool choice and final support.

### 12.3 Follow-up without resolve

**What happens:** Turn 2 "No, EU" retrieves "EU" as a bare query or ignores it and re-runs turn 1.

**Why:** Resolver skipped or dropped constraints. Session empty (Redis TTL). 

**Probe:** scripted two-turn dialogue in Phase 0.

### 12.4 Memory cited as policy

**What happens:** Last week the model said "cap is 20 days" (hallucination). Extractor stored it as `durable_fact`. This week the assistant cites "your notes" as if it were the handbook.

**Why:** Write path allowed a KB-shaped fact; generator treated memory as a source.

**Probe:** poisoning item: assistant-wrong then new session; must not cite memory as the cap. Filter 3 in §7 is the control; the probe proves it.

### 12.5 Cross-user leak

**What happens:** `session_id` guessed; or memory SELECT missing `user_id`; or ANN neighbor from another tenant.

**Why:** Isolation was a convention.

**Probe:** two users in CI; assert empty intersection of recalled ids. Mandatory, not optional.

### 12.6 Retry storm

**What happens:** hybrid 500s; agent retries hybrid until wall-clock; never degrades to naive.

**Why:** ladder not implemented; same-tool retry in a while loop.

**Probe:** chaos: hybrid down; expect naive or refuse, not 15s of 500s.

### 12.7 Forgotten decrement / recursion limit as the only fuse

**What happens:** Reformulate edge does not decrement; LangGraph recursion_limit=25; 25 grades; bill.

**Why:** Budget was a comment.

**Probe:** unit test the graph: after `max_iterations` extra hops, next node is Escalate. Runtime max-steps is backup.

### 12.8 False sufficient, extra latency

**What happens:** Bad chunks, grader says sufficient, you paid route+grade to generate the same wrong answer naive would have produced faster.

**Why:** CRAG's original sin, now with a router on top.

**Probe:** labeled insufficient windows; false-sufficient rate in Phase 3.

### 12.9 Extractor dump / junk drawer

**What happens:** Every turn writes an `episode_summary`; 200-row cap evicts preferences; recall is a stream of "user asked about PTO again."

**Why:** Summary-every-turn without cap priority (preferences must survive eviction).

**Probe:** 50-turn soak; preferences still present.

### 12.10 Eval theater

**What happens:** Demo is one multi-hop + one follow-up. Production mix is 90% lookups. Dashboard says "agentic quality up 12%" on a 15-item set with no gold-strategy tags.

**Why:** Phase 0 skipped.

**Probe:** the Phase 0 gate itself. If the set does not exist, the project is not in Phase 6.

### 12.11 Lost-in-the-middle, now with memories

**What happens:** Packed memories + 10 chunks + history; the relevant chunk sits in the middle; generate ignores it.

**Why:** Context-forge packing still has a budget; stuffing memories first can shove KB out.

**Probe:** keep packing order in §9; eval with memories present vs absent on the same KB-sufficient item — must not regress support.

### 12.12 Stale index / missing edges, loop cannot mint facts

**What happens:** Graph missing the vendor edge; three hops; refuse. Correct outcome. Product still files a ticket "the agent should have found it."

**Why:** Runtime is not an indexer.

**Probe:** out-of-corpus and missing-edge items must refuse, not invent.

## 13. Observability

Minimum fields on `agent_run` (also trace spans per node):

`run_id, user_id, session_id, raw_hash (not always raw text in hot index), resolved_question, tools[], grades[], iterations, tokens_by_role, wall_ms_by_node, breaker_reason, memory_ids_in, memory_ids_written, terminal, code`.

Dashboards: tool mix, mean iterations, % maxed iterations, breaker rate, refuse rate, extract skip rate, p95 vs naive and vs `rag-selfheal` on a shadow sample.

## 14. Security Brief

- Authn required. No anonymous LTM writes.
- Redis keys include `user_id`. Session bind check.
- Postgres recall always `user_id = caller`.
- Tools get caller identity if they support ACL; no service-account widen.
- Memories are untrusted; prompt injection via stored preference is in-scope: filters + "memory is data."
- Ask API is ClusterIP or authenticated ingress; same warning as naive RAG: do not LoadBalancer a private corpus.
- Forget-me is a real delete path, not a UI checkbox over live rows.

## 15. What Success Looks Like Mechanically

A Phase 6 report can replay: for each eval item, gold tool, chosen tool, iterations, terminal, supported-by-KB, leaked-memory (Y/N), latency, token cost. The architecture is working if the **relational slice** improves because graph was chosen when it should be, the **follow-up slice** improves because resolve+session worked, the **lookup slice** did not get 3× slower, and the **poisoning/isolation probes** are clean. If only the demo GIF works, the design failed.
