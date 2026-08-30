# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone `pip install`s an MCP SDK and calls it an agent platform.

The trap, once: **MCP is a tool-interop protocol, not a safety protocol.** ReAct is a prompting pattern, not a runtime. Wrapping boto3 and Jira in `tools/list` makes you compatible with more clients. It does not make the LLM a safe deputy, it does not make writes idempotent, and it does not make a vendor's tool description honest. The interesting artifacts are the three-layer split, the first-party server as a second enforcement point, the dispatch ledger, the confirmation gate, and the third-party pin. The MCP server is the *reuse* play. The harness is the *control* play. Confusing the two is how this becomes a resume line and an incident.

## 1. What I would build

A **small first-party MCP server** and a **stricter agent runtime** than the demo you have in mind.

- **`agent-core-mcp-server` as its own process**, versioned tool contracts, read-only AWS, structured Jira search, named DB queries only. Authz as the human, bot credential as ceiling. Write tools that *refuse* to run without `idempotency_key` + `confirmation_token`.
- **Three modules**: policy (ReAct proposer), transport (MCP client, first-party + one third-party), runtime (loop, budgets, classify, confirm, dispatch-first, sandbox observations). LangGraph, if used, is hidden inside runtime — it does not own retries or tool execution.
- **A confirmation UX** that is faster than opening Jira: one screen, the actual fields, confirm/reject. If we cannot beat Jira's latency to *intent*, the agent loses and people bypass it.
- **A dispatch ledger** for writes. Unknown is a state. Recon is a worker. No tenacity on `create_issue`.
- **One allowlisted third-party MCP origin**, pinned hash, capped output, no vendor writes, no PII outbound. That is the interoperability proof. It is also the threat we are actually taking on.
- **Hard budgets.** The loop stops. There is no wrap-up token burn.

The LLM never holds cloud keys. The third-party server never sees customer rows. Anyone who implements tool use as `bind_tools` on an MCP session in the same file as the prompt has not implemented this design.

If Phase 0 finds we have **no second client** that will speak MCP, and **no third-party server** we are willing to allowlist, then MCP is optional complexity for a private RPC. Build the runtime + confirmation + ledger against a plain HTTP tool API, keep the *interfaces* MCP-shaped so you can add the server later, and **do not** pretend you shipped interoperability. The inventory is the fork.

## 2. What I would give up

Be explicit. These are not "later." They are not in v1, and some of them are never in this design.

**Autonomous writes.** Default confirm-on. If product wants the agent to file tickets while the human sleeps, they are choosing a different incident profile. Opt-out is named, per-tool, not a `.env` surprise.

**Instant ReAct.** Confirmation and dispatch-first add hops. MCP adds a hop versus in-process SDK calls. The hop is the enforcement point.

**Arbitrary SQL, shell, `boto3` passthrough, `aws s3 rm`.** Those are a different blast radius (see the coding-agent harness project). Named tools only.

**Trusting third-party tool descriptions.** We pin and subset. Some vendor tools will be unused because their schema is a secret vacuum.

**A generic MCP gateway / catalog / "internal Glean for tools."** One server, one vendor client. A platform is a year. This scenario is a showcase.

**Solving prompt injection.** We mitigate a channel. The human prompt can still ask to flag the wrong account; confirmation is how we live with that.

**Exactly-once Jira/DB.** Ceiling is at-least-once with keys. Anyone quoting exactly-once has not timed out a REST API.

**Parallel tool calls, sub-agents, swarms.** They multiply confirm UX and unknown joins. Sequential is how you explain the drain.

**Treating LangGraph as the architecture.** It is a loop library. If it disappears in two years, policy and ledger remain.

**stdio to a "third-party" we also wrote, for the demo.** That is first-party with extra steps. It proves the client *code path* and **not** the trust model. Lab-only, labeled as such, never in the architecture diagram as ThirdParty.

**MCP as a reason to skip IAM reviews.** Security still reviews the adapter role and the Jira bot.

**Cheap ReAct.** The pattern is token-heavy. Budgets exist because this algorithm is wasteful. If you need cheap, fewer tools, shorter observations, maybe not ReAct (tool-calling without printed thoughts). Policy is swappable; the showcase still uses ReAct.

## 3. What I would ask for, even though I expect a no (or a fight)

Ask **once, in writing, at Phase 0**. A no must not block the read-only server. A yes changes whether writes exist, whether MCP is justified, and whether a third-party origin is allowed.

Ask **security**:

1. **The human ∩ bot grant model** for `query_customer_account` and `flag_account_for_review`. If we cannot row-level authz, those tools are out. Expected: fight about the bot DB role being broad "for now."
2. **Production confirmation opt-out policy.** Expected: product wants it for Jira, security wants it for neither. Default is both gated.
3. **Allowlist of third-party MCP origins** (maybe empty). Empty is a valid answer and it *kills Phase 3*, not the whole project.

Ask **Jira / AWS / DB owners**:

4. **Idempotency and lookup** for creates/flags. Expected: Jira is weak. Then recon is human + a fingerprint comment. Ask if we may stamp `[agent-key:]` in the description.
5. **Read-only IAM** for v1 AWS tools. Expected: yes if we do not ask for mutate.
6. **No `execute_sql`.** Expected: someone will ask. The answer is no.

Ask **product / on-call**:

7. **Whether confirmation can be faster than Jira.** If they will not use a gate, do not ship writes; ship a read-only investigator.
8. **Budget numbers they will accept** (truncated answers vs. surprise bills).

Ask **whoever owns "AI platform"**:

9. **Whether any other client will actually connect to this MCP server in 90 days.** If no, MCP's benefit is speculative. Still build the *server* if you believe Cursor/Claude users are real; do not build a *gateway product*.

What I would **not** ask for: that the MCP spec will add safety for us, that the vendor will not change descriptions, that the model will "usually" stop, that LangGraph retries are "probably fine."

## 4. Complexity, priced honestly

This is not a large distributed system. It is a **small system with a nasty deputy problem and a protocol people currently over-trust**. The MCP hello-world is an afternoon. The confirmation gate, canonical fingerprints, pin hashes, and unknown recon are the actual project. Most failure modes will not show in a demo unless you test them on purpose (Phase 1–3 gates).

| Approach | What you save | What you pay later |
| --- | --- | --- |
| Notebook ReAct + boto3 + Jira SDK, no MCP | Weeks, and a hop | No reuse; retries duplicate writes; no second enforcement point |
| MCP server wrapping SDKs, LangGraph retries, shared bot token | The "we did MCP" slide | Confused deputy, duplicate tickets, third-party injection, runaway bill |
| This design, skip third-party | Phase 3 threat work | You did not prove MCP *client* interoperability; still valid if security refuses a vendor |
| This design, skip confirmation | UX latency | One poisoned observation or one wrong thought becomes a customer flag |
| Company-wide MCP gateway on day one | Nothing in this scenario | A platform project that still needs ADR-001–007 per tool |

**When MCP is worth it:** more than one client (our agent + Cursor/Claude/sibling), or more than one server (ours + a vendor we actually need), and you will maintain tool contracts like APIs. Then the extra hop and spec churn are rent on interoperability.

**When MCP is theater:** one agent, tools you own, no foreign client, no vendor server. Then a versioned internal HTTP API + the same runtime/gate/ledger is simpler, cheaper to debug, and just as safe. You can still *shape* the contracts so an MCP adapter is a later transport.

The overkill line: **read-only internal Q&A with three GET tools and no vendor.** Then you need budgets, authz, and a transcript — not pinning theater, not confirmation, not a dispatch outbox. The moment `create_issue` or `flag_account_for_review` exists, confirmation + keys are justified. The moment a third-party MCP origin exists, pinning + sandboxing are justified. MCP-the-protocol is justified by the *second* client or the *second* server, not by the first tool.

## 5. How the answer changes for other stacks

| Choice | What changes | What must not change |
| --- | --- | --- |
| Python vs TS MCP SDK | Transport module internals | Ledger, gate, authz, classification |
| LangGraph vs a 80-line loop | Runtime internals | Policy interface; no retries in the graph |
| Streamable HTTP vs stdio | Deploy story; stdio third-party still forbidden | Pin, authn |
| Jira vs GitHub issues | Adapter + idempotency evidence in Phase 0 | Write path |
| ReAct vs plain tool-calling | Policy prompt | Runtime law |
| Adding `terminate_instances` | **New ADR, new blast radius, almost certainly a no** | "It's just another tool" is forbidden |

## 6. Brutal summary

`agent-core` is **harness engineering wearing an MCP interoperability coat.** The coat is real and resume-worthy if you actually speak MCP on both sides and treat contracts as APIs. The coat is fake if you only wrap SDKs and let LangGraph retry.

If you remember one sentence for the review: **MCP moves tool calls onto a standard wire; it does not decide who is allowed to pull that wire, whether pulling it twice is safe, or whether the words on the wire are instructions from an enemy — those are runtime and server problems, and writes still need a human.**

If product wants "the agent just files the ticket," they need to sign an opt-out and own the incident. Architecture cannot invent a trustworthy deputy because the protocol is new.
