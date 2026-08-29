# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: MCP as Transport, Not an Authorization Boundary

**Status**: Accepted

**Context**: MCP gives us a standard way to advertise tools (`tools/list`) and invoke them (`tools/call`). That is valuable: Cursor, Claude, our ReAct runtime, and a future sibling agent can share one first-party server. Teams routinely treat "the client connected to our MCP server" as "the client is allowed to do whatever the bot credential can do." That is the confused-deputy bug. MCP session establishment is authentication of *a client*, at best. It is not a decision about *this human*, *this account_id*, *this Jira project*, or *this write*. A second MCP client with a leaked server token would inherit the whole AWS/Jira/DB blast radius if we encoded authz as "they found the port."

**Decision**: The first-party MCP server is a transport and a *second* enforcement point, not the only one and not a replacement for IAM/ACL. Every `tools/call` authenticates a JWT (or mTLS) bound to `user_id` + `run_id` + `client_id`. Authorization is `human_grants ∩ tool_policy ∩ client_policy`. Write tools additionally require a confirmation token from our gate ([ADR-007](./04_architecture_decision_records.md#adr-007)) and an idempotency key ([ADR-003](./04_architecture_decision_records.md#adr-003)). Foreign MCP clients default to read-only scope in v1. The bot IAM/Jira/DB role is a ceiling for adapters, never the grant.

**Consequences**:
- (+) A bug in the ReAct policy cannot widen authz; the server still denies `query_customer_account` for the wrong account.
- (+) Interoperability remains: other clients can use reads; they do not silently become writers.
- (–) Two enforcement points (runtime + server) can drift (canonical fingerprint, token format). That drift is a failed test, not a reason to drop server checks.
- (–) "Just connect MCP Inspector and file a ticket" will not work without the gate. That is intentional and will annoy demo culture.
- **Alternative rejected**: authorize only in the agent runtime and let the MCP server use a static bot token internally with no per-call ACL. Faster demo; any MCP client becomes god.
- **Alternative rejected**: per-user AWS/Jira tokens forwarded through MCP. Nightmarish secret handling; still does not solve third-party MCP; still needs a gate for model-initiated writes.
- **Revisit trigger**: a future MCP spec-level authorization standard that actually binds user consent to tool invocation. Even then, keep server-side ACL for `account_id`.

## ADR-002: Hard Three-Layer Boundary (Policy / Transport / Runtime)

**Status**: Accepted

**Context**: The required showcase is a ReAct agent over MCP with a swappable loop. If policy imports the MCP SDK, we cannot change prompts without touching JSON-RPC. If LangGraph tool nodes call boto3 "to skip the hop," we no longer have an MCP server worth other clients using, and retries become a graph default. If transport retries writes, runtime classification is theater. MCP spec and SDKs are also churning (stdio, HTTP+SSE, Streamable HTTP); that churn must not rewrite the confirmation ledger.

**Decision**: Three modules with CI-enforced dependency rules:

1. **Policy** — `propose(PolicyView) -> Proposal`. LLM + prompt. No MCP SDK, no HTTP to tools, no DB.
2. **Transport** — MCP client(s). `list_tools` / `call_tool`. No prompts, no retry policy, no confirmation UX.
3. **Runtime** — loop, budgets, classification, gate, dispatch ledger, observation sanitization. The only composer. LangGraph, if present, is an implementation detail *inside* runtime, not the public shape.

The first-party **server** is a fourth deployable, not a fourth "agent layer": it is the tool process.

**Consequences**:
- (+) Swap stdio ↔ Streamable HTTP without retouching ReAct prompts.
- (+) Swap model/prompt without retouching idempotency.
- (+) Disable a framework's "retry all tools" in one place (runtime), not in every node.
- (–) More types and more wiring than a single notebook. That cost is the project.
- (–) People will try to "just bind_tools(mcp_tools)" in the policy file. Code review and import-linter are part of the architecture.
- **Alternative rejected**: one Python package "the agent" with comments labeling sections. Comments are not boundaries.
- **Alternative rejected**: skip MCP internally and only wrap at the edge for foreign clients. That forks two invocation paths; writes will be safe on one path and not the other. One path through the server for all tools.

## ADR-003: Read vs Write Classification; Idempotency Keys; No Auto-Retry of Writes

**Status**: Accepted

**Context**: ReAct loops retry. HTTP clients retry. MCP clients retry. LLM policies retry when the observation looks like an error. For `describe_ec2_instances`, that is mostly noise and AWS bill. For `create_issue` and `flag_account_for_review`, that is a duplicate ticket or a double flag. Timeout after Jira accepted the POST is not failure. MCP does not define idempotency.

**Decision**: Every first-party tool is classified `read` or `write` in the contract (`x-side-effect`) and in a server-side registry (the registry wins if they disagree — mislabeled `read` that writes is an incident). Runtime auto-retries **reads only**, bounded. Writes: record `tool_dispatches` with `idempotency_key = hash(run_id, tool, attempt, fingerprint)` **before** `tools/call`; send the key to the server; server unique-constrains and refuses different bodies on the same key. Timeouts → `unknown`, not attempt+1. New attempt only after known non-apply, and writes still need a new confirmation if args changed. Third-party tools are not writable in v1.

**Consequences**:
- (+) Crash windows do not mint a second Jira issue if the server honors the key, and *we* never issue a different key to "be safe."
- (+) Policy can *propose* the same write twice; runtime will not dispatch twice for the same pending unknown.
- (–) `unknown` needs recon and a human-honest observation. Support cost is real.
- (–) Jira may not honor keys. Then local uniqueness + no retry is the only fuse; dual writers still lose. Lease discipline is mandatory.
- **Alternative rejected**: retry everything with tenacity at the transport layer. The demo never double-files because the demo never times out.
- **Alternative rejected**: use the LLM's tool-call id as the idempotency key. New thoughts produce new ids; that is a clean-conscience duplicate.

## ADR-004: Third-Party MCP Servers and Their Outputs Are Untrusted Input

**Status**: Accepted

**Context**: The showcase requires the agent to be an MCP *client* of a third-party server. That is the interesting interoperability claim. It is also a documented threat class: malicious or compromised MCP servers can poison tool *descriptions*, change them after pinning (rug-pull), put instructions in tool *results*, and try to exfiltrate secrets via tool arguments. Treating "official vendor MCP" as inside our trust boundary is how those write-ups become our incident. Our first-party server is trusted *as software we ship*, still not trusted as "the model is aligned."

**Decision**:
- One allowlisted origin. No user-supplied MCP URLs in v1.
- Pin `tools/list` hash at session start; mismatch → `contract_drift`, do not merge.
- Third-party tools are `untrusted_read`. Write-shaped vendor tools are stripped from PolicyView.
- Observations size-capped, heuristically flagged, prefixed as untrusted. Flagged observations cannot share a step with starting a write confirmation.
- Outbound args denylist: no PII DTOs, no first-party secrets, no customer `account_id` unless Phase 0 explicitly allowlists a vendor field (default no).
- Vendor credentials ≠ first-party credentials. Separate secret.
- No stdio "fake third-party" in production architecture; a second process we wrote is not a third party.

**Consequences**:
- (+) The interoperability proof does not require pretending the vendor is us.
- (+) Rug-pull becomes a loud terminal, not a new tool appearing mid-run.
- (–) Heuristics miss. Confirmation ([ADR-007](./04_architecture_decision_records.md#adr-007)) is the actual write backstop.
- (–) Some vendor tools will be unusable because their schema wants a free-form context blob. We skip them rather than fill the blob with our transcript.
- (–) Adding MCP server #2 is an allowlist + threat review, not a config flag the agent engineer flips on Friday.
- **Alternative rejected**: concatenate vendor results into the prompt like search snippets from our own DB. Search snippets from our DB are still untrusted *content*, but they are not an *instruction channel with tool-definition privileges*.
- **Alternative rejected**: "we'll only use Microsoft/Google/Atlassian official servers so it's fine." Supply chain and description-as-prompt still apply; pin anyway.

## ADR-005: Runtime-Enforced Hard Budgets Instead of Trusting the Policy to Halt

**Status**: Accepted

**Context**: ReAct's halt condition is "the model emits a final answer." Models also emit another thought. On-call questions plus noisy `describe_*` tools plus a third-party search is a token incinerator. Prompting "you have 8 steps" is a suggestion. LangGraph `max_iterations` is closer, but must not be the only cap (tool-call count, wall-clock, and dollars can blow while iterations remain). A "one last wrap-up call" after the cap is how caps fail.

**Decision**: Runtime enforces four hard ceilings before every policy call and before every tool call: max iterations, max tool calls, wall-clock (excluding confirmation wait, which has its own expiry), cost in cents. Hitting any ceiling terminals with `budget_exhausted` and **does not** spend another LLM call to summarize, unless a reserved `budget_summary` allowance was configured and still has room (default off). Policy is told remaining numbers as hints only.

**Consequences**:
- (+) A confused loop stops. The bill has a lid.
- (+) Confirmation waits do not burn the wall-clock budget and force a stop while the human is in another channel.
- (–) Some answers will be truncated. The UI must say so. That is better than a $40 "still thinking."
- (–) Cost accounting must be approximately real-time (token estimates). Slightly early stop is better than slightly late.
- **Alternative rejected**: rely on ReAct "Final Answer:" regex. Cute until the model forgets the regex.
- **Alternative rejected**: unlimited in "serious" incidents. Incidents are when loops get *worse*. Ops can start a **new** run with a higher budget; they cannot have this run ignore the lid.

## ADR-006: Tool Contracts Versioned Like Public APIs

**Status**: Accepted

**Context**: `tools/list` is a published API the moment a second client exists. Renaming `bucket` to `bucket_name` breaks our runtime pin *and* Cursor users *and* any cached schema. LLMs will improvise around 400s by retrying with different payloads — for writes, that is how you get two tickets. Enterprise consumers need deprecation, not vibes.

**Decision**: Each first-party tool carries `{major, minor}`. Within a major: additive-only (optional inputs, additive outputs). Breaking changes bump major and keep the old tool name as a deprecated alias for a documented window, or keep the old name on the old major advertised in parallel (`create_issue` v1 alongside v2 under explicit names if we must — prefer `create_issue` stable name + major in metadata, not two names). Session pin hashes the canonical list; mid-run changes are `contract_drift`. Removal requires a deprecation window. The server validates the advertised schema; it does not "be liberal" in what it accepts for write tools.

**Consequences**:
- (+) Foreign clients and our runtime share a change control story.
- (+) Pinning has a defined meaning (bytes of canonical list).
- (–) We cannot "quickly fix" a tool name in prod without a major/deprecation. Good.
- (–) Hash changes on minor additive updates: new *runs* pick them up; in-flight runs do not. Operators must not bounce the server's advertised set in a way that reconnects drift a long confirm wait — prefer compatible add and don't re-list in-flight.
- **Alternative rejected**: unversioned docstrings as the contract. That is the notebook.
- **Alternative rejected**: semver on the whole server only. Tools change independently; `get_s3_bucket_size` should not major-bump because `create_issue` did.

## ADR-007: Human Confirmation Default-On for All Write Tools

**Status**: Accepted

**Context**: Once tools can mutate Jira or a customer row, the remaining defenses (authz, keys, pinning) still allow a *wrong but authorized* write: the human is allowed to file in PROJ, the model picked a terrible summary, or a missed injection steered `account_id`. Autonomous writes optimize for demo latency. On-call will also demand autonomy "because paging is busy." Busy is when you most want a second pair of eyes on a **customer flag**.

**Decision**: All write tools require a confirmation token bound to `user_id`, `run_id`, tool name, and argument fingerprint. Default on in every environment. Opt-out is per-tool per-environment, explicit, logged, and a production opt-out requires a named approver (security or product). There is no global `AUTO_CONFIRM=true`. The UI shows a readable summary, not raw JSON only. Reject and expiry leave no dispatch. Confirmation does not replace authz or idempotency; it is the human intent check.

**Consequences**:
- (+) Wrong writes are attributable to a click, not to "the agent did it."
- (+) Other MCP clients cannot write without the same gate (or they are read-only).
- (–) If the confirm UX is slower than opening Jira, the product fails adoption. That is a UX requirement, not a reason to skip the gate in v1.
- (–) Confirmation fatigue is real. Mitigation: few write tools, good summaries, do not propose three writes when one will do (prompt + budget), not silent auto-confirm.
- **Alternative rejected**: confirm only `flag_account_for_review` because "Jira is cheap to undo." Duplicate and wrong tickets still cost humans; `transition_issue` to Done is not cheap.
- **Alternative rejected**: "confirm the first write in a run, then trust the rest." The third-party observation often arrives *after* the first write.
- **Revisit trigger**: a high-volume write that is truly reversible, low blast, and measured error rate — still per-tool opt-out, not a new default.
