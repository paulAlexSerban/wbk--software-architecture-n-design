# LLM Output Flakiness Triage: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

A teammate insists the fix for flaky LLM outputs is "just add more few-shot examples." The design must answer, concretely:

1. **In under two minutes**, why that is usually the wrong first move — not as a vibe, as a statement about what few-shot examples actually do.
2. What "flaky" decomposes into: formatting drift vs. reasoning error vs. retrieval gap vs. sampling variance vs. an underspecified instruction. These are **different defects**. They do not share a lever.
3. What you would actually do instead: a diagnosis-before-mitigation path, with a named owner per class, and a check that the chosen lever moved the class it claimed to move.

This is the few-shot-as-universal-patch trap. The naive answer — paste two more (input, output) pairs into the system prompt, ship, declare the flake gone — is the failure. It treats five unrelated failure modes as one prompting problem. Sometimes the flake even appears to go away, because you overfit the one case someone happened to notice, while the rest of the class stays, the prompt gets longer, and the next flake gets the same "fix."

The correct shape is: **classify the failure against a frozen taxonomy, route to the lever that can actually move that class, and verify with a paired before/after on a frozen sample — never by eyeballing the ticket that started the conversation.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true under fuzzy class boundaries, small samples, and a teammate who can ship a prompt change in twenty minutes.

## The 2-Minute Answer

Say this, then stop talking until they object to a specific sentence.

> Few-shot examples demonstrate a mapping. They show the model "inputs that look like this should come out looking like that." That is a real tool — for **format and style**. It is not a tool for the other things we call flaky.
>
> If the model is emitting valid JSON with the wrong *answer*, more examples of valid JSON will not invent the missing fact. If retrieval never put the policy clause in context, no example in the prompt can put it there. If temperature is 0.8 and we sample once, the next call will still wander; examples do not reduce sampling entropy. If the instruction is ambiguous, an example locks in *one* interpretation and hides the others.
>
> Worse: examples have a bill. Every call now carries them. They compete with the actual retrieved context for window. They rot — nobody deletes the pair that patched last month's one-off. And they can teach a *shortcut*: the model copies the surface of the example and skips the reasoning the example was supposed to illustrate.
>
> So we do not start by adding examples. We start by **naming the class**. Format drift → constrain the schema, maybe keep a *small* few-shot as reinforcement. Reasoning error → decompose, tool-offload, or change the model; do not few-shot a wrong chain. Retrieval gap → fix retrieval. Non-determinism → temperature, validation-and-retry, majority vote. Ambiguous prompt → rewrite the instruction. Then we measure the class rate before and after on a frozen sample. If the examples still win that test for a confirmed format class, we keep them. If they don't, we don't.

That is two minutes. The rest of this document is what you do when they say "okay, then what."

## The Trap, Stated Directly

Standard LLM debugging culture treats **the last bad output** as the specification of the next prompt. If the response was supposed to be JSON and came back with a preamble, someone pastes a JSON example. If the refund amount was wrong, someone pastes a refund example. If the citation was invented, someone pastes a "good citation" example. The prompt becomes a graveyard of incidents. Quality is inferred from "that ticket stopped reproducing."

That version fails for structural reasons, not prompt-quality reasons:

| What the teammate thinks few-shot does | What it can actually do |
| --- | --- |
| Teach the model the *task* | Demonstrate a local input→output mapping for *shape and style* |
| Inject missing knowledge | Nothing. Knowledge that is not in weights, tools, or retrieved context is not in the example either — unless you paste the missing document into the example, at which point you have invented an ad-hoc, unindexed knowledge base inside the prompt |
| Fix a reasoning error | Sometimes it appears to, by accident, on the demonstrated instance. Often it teaches the model to imitate the *form* of the example (the "let's think step by step" cadence, the JSON keys) while the actual inference stays wrong. Few-shot as a **bad prior** |
| Make outputs "more consistent" | Consistency of *format*, maybe. Consistency of *sample* across temperature>0, no |
| Be free | Tokens on every call, latency, window pressure against retrieval, and maintenance. Stale examples are negative signal |
| Be the scientific method | It is an uncontrolled experiment with n=the tickets someone filed this week |

A prompt that grows by one example per incident is not a quality system. It is an unversioned, unmeasured, ever-lengthening patch file that happens to be concatenated into the model.

## Failure-Mode Taxonomy

These five classes are the load-bearing ontology of the project. If a failure does not fit, that is a taxonomy defect (version the taxonomy) — not permission to skip classification. Worked incidents below are illustrative; they are the same shape as production tickets.

### Class F — Format / schema drift

**What's actually wrong:** the model does not reliably emit the *shape* the downstream parser or UI needs. Extra prose, missing keys, wrong enum, markdown fences around JSON, schema version skew.

**Worked incident:** a support-bot tool call is supposed to be `{"intent":"refund","order_id":"...","amount_cents":1234}`. About 8% of calls come back as `Sure, I can help with that. {"intent": "refund", ...}` and the parser throws. The teammate pastes two clean JSON examples. The preamble rate drops on the tickets they re-ran. A week later a new enum value ships in the tool spec; the examples still show the old enum; the model now *faithfully* emits the stale shape.

**Does few-shot fix it?** Partially, for the demonstrated shape, until the schema moves. It is the one class where examples are a legitimate *reinforcement*.

**Correct lever:** structured output / function-calling schema / grammar-constrained decoding where the provider supports it. Parser-validate and regenerate as a backstop. A *small* few-shot set is optional reinforcement, versioned with the schema, deleted when the schema constraint is enough. See [ADR-003](./04_architecture_decision_records.md#adr-003).

### Class R — Reasoning error

**What's actually wrong:** the facts (or the retrieved context) were sufficient, and the model still drew the wrong conclusion, skipped a step, inverted a policy, or arithmetic'd its way to a confident wrong number.

**Worked incident:** retrieved policy says "refunds over 30 days require manager approval." The model has the clause in context and still issues the refund. A few-shot example of a correctly-denied refund is added. The next failure is a 29-day case that now gets denied too — the example taught "be conservative about refunds," not "apply the 30-day rule."

**Does few-shot fix it?** No. Examples can lock in a flawed shortcut. Apparent wins are often overfitting to the demonstrated story.

**Correct lever:** decompose the task (extract fields, then apply a deterministic rule); chain-of-thought or a scratchpad *only if* you will inspect it; tool-offload arithmetic and policy lookup to code; a verification/self-check step that is itself evaluated; or a stronger model. Do not few-shot a rule that belongs in code.

### Class G — Retrieval / context gap

**What's actually wrong:** the information needed to answer was not in the prompt, not in the retrieved chunks, or was retrieved but drowned. The model then guesses, hedges, or silently fills.

**Worked incident:** a RAG assistant is asked for the Q3 return window of a SKU whose policy lives in a PDF that was chunked at 200 tokens, splitting the table. Top-k returns the product description, not the table. The model invents "30 days." Someone adds a few-shot example of a correctly-cited return window from a *different* SKU. The original SKU is still missing from retrieval. The example now *also* occupies window that the right chunk might have used.

**Does few-shot fix it?** No. No example supplies a fact that is not in context — unless you paste the missing document into the prompt, which does not scale and is not retrieval.

**Correct lever:** fix retrieval (chunking, metadata filters, query rewrite, hybrid search, more/better sources), then a groundedness check. This class is a sibling of unfaithfulness in [prj--llm-hallucination-detection](../../prj--llm-hallucination-detection/README.md); this project *routes* to that concern, it does not re-implement a detector.

### Class S — Sampling non-determinism

**What's actually wrong:** the same prompt, same context, same model, different samples, different answers, because temperature / top-p / lack of seed made variance the product. "Flaky" here is literal: re-run the call.

**Worked incident:** an extraction job at temperature 0.7 produces different `due_date` values on two runs of the same invoice. An engineer adds three few-shot extractions. Variance drops a little (the output distribution is now biased toward the example formats) and then a fourth run still flips the date. CI is red/green/red.

**Does few-shot fix it?** No. It does not reduce sampling entropy in any way you should bet CI on.

**Correct lever:** lower temperature / top-p for extraction and tool-calling (often 0); pin seed where the provider actually honors it (many do not — verify, do not assume); schema constraint (Class F helps Class S when the *disagreement* was format); validate-and-regenerate; self-consistency / majority vote for the cases where you *want* temperature for quality and will pay k×. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md) for why majority vote is not a default.

### Class A — Ambiguous / underspecified prompt

**What's actually wrong:** the instruction admits multiple valid interpretations. Different samples (or different users) get different, *defensible* answers. The team calls this flakiness because they had one interpretation in mind.

**Worked incident:** "Summarize this ticket." Sometimes the model writes a one-line status for the agent dashboard; sometimes a customer-facing apology. Both match the instruction. A few-shot of the dashboard style is added. Customer-facing callers now get dashboard-ese. The prompt still does not say who the audience is.

**Does few-shot fix it?** Only for the one interpretation demonstrated. It masks the other valid readings instead of killing them.

**Correct lever:** rewrite the instruction (audience, length, forbidden content, what to do when data is missing). Examples may illustrate the rewritten contract. They are not a substitute for writing the contract.

### Class boundaries are fuzzy — that is a requirement, not a footnote

A wrong refund amount with the policy sitting in chunk 3 can be **R** (ignored the clause) or **G** (the clause was retrieved but truncated / not in the window the model actually attended). A JSON-with-preamble that also has the wrong `amount_cents` is **F and R**. Sampling variance that *looks* like a reasoning error is **S** until you re-run at temperature 0.

The architecture does not pretend these are linearly separable. It requires a **primary class**, optional **secondary tags**, and a recorded **confidence / disagreement** field. Misdiagnosis is expected; it must be visible. See [ADR-001](./04_architecture_decision_records.md#adr-001) and [System Design](./03_system_design.md).

## Current State (Assumed Starting Point)

A typical first version of "we fixed the flake" looks like:

1. A Slack thread or a ticket with one bad completion pasted.
2. Someone reproduces it once, or fails to, and still patches.
3. Two few-shot examples land in the system prompt, or a sentence is added ("always return valid JSON").
4. The original paste is re-run. It looks better. The PR ships.
5. There is no frozen sample, no class label, no paired eval, no owner for retrieval vs. prompt vs. decoding. The next flake repeats the loop. The prompt is now 400 tokens longer.

That version will appear to work for a prototype whose only flake is "please stop saying Sure!" It will fail the first time the flake is a missing document, a policy rule implemented in prose, or a temperature-0.7 extractor running in CI. It will also fail slowly: cost and latency creep, retrieval quality drops because the window is full of examples, and nobody can answer "why is this example still here."

This project documents the replacement, not a patch of that prompt.

## Target Users

- **Owning engineer / prompt owner**: needs a response to "just add examples" that is not a lecture, and a playbook that tells them which lever they are allowed to pull.
- **Eval / quality engineer**: owns the labeled failure sample, class-rate metrics, and the paired before/after. This role is not optional if mitigations are allowed to ship. See [prj--support-bot-eval-harness](../../prj--support-bot-eval-harness/README.md) — this project consumes that gate, it does not rebuild it.
- **Retrieval / RAG owner**: owns Class G. They are a different person from the prompt owner on any team large enough to have this argument. Routing exists so the prompt owner stops "fixing" retrieval with examples.
- **Platform / serving owner**: owns decoding (temperature, seed, structured output, logprobs). Class F and Class S often live here, not in the prompt file.
- **On-call / support**: files the failure record; needs the ticket to terminate in a class and a mitigation id, not in "we tweaked the prompt."

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which model, which JSON schema, which index) are out of scope except as the levers the playbook points at.

1. **Diagnosis before mitigation is a gate, not a guideline.** A mitigation (prompt change, few-shot add, temperature change, retrieval change, schema constraint) cannot merge without a `failure_class` (or an explicit `class_unknown` with a time-boxed investigation). "I tried examples and it looked better" is not a class. See [ADR-001](./04_architecture_decision_records.md#adr-001).
2. **Every failure is labeled against the frozen taxonomy.** Primary class required. Secondary tags optional. Disagreement between raters is a metric, not a private Slack argument. Taxonomy changes are versioned.
3. **Few-shot is scoped to Class F (and as illustration of a rewritten Class A contract).** It is not an accepted primary mitigation for R, G, or S unless a paired regression result on a frozen sample shows that class's rate moved, and even then the docs must say this is unexpected and probably overfitting. See [ADR-002](./04_architecture_decision_records.md#adr-002).
4. **Where the provider supports it, schema-constrained decoding is preferred to few-shot for Class F.** Examples may remain as reinforcement; they are not the control mechanism. See [ADR-003](./04_architecture_decision_records.md#adr-003).
5. **Every mitigation is verified with a paired before/after on a frozen sample before it is called a fix.** The sample is stratified by class when possible. The original ticket is not the sample. Reuse the paired-comparison idea from [prj--support-bot-eval-harness](../../prj--support-bot-eval-harness/README.md); do not invent a second eval platform. See [ADR-004](./04_architecture_decision_records.md#adr-004).
6. **Cheap deterministic classification runs first.** JSON-parse / schema-validate failures are Class F automatically. Re-running the same prompt at temperature 0 vs. the original temperature is the Class S screen. Humans (and, later, a calibrated suggestion model) handle the remainder. An LLM is not the sole classifier. See [ADR-005](./04_architecture_decision_records.md#adr-005).
7. **Mitigations route to named owners.** F/A → prompt + platform; R → prompt / product logic / model; G → retrieval; S → platform decoding. A prompt PR that "fixes" Class G is a misroute, even if it appears to help one ticket.

## Success Criteria for the Design (Not Implementation Metrics)

1. Given a pasted bad completion, a trained teammate can produce a primary class (or `class_unknown`) in minutes using the labeling guide, and two raters' agreement on a held-out batch is measured and published — not assumed.
2. A few-shot-only PR against a Class G or Class S labeled batch cannot merge without failing the "did this class's rate move?" check, or without an explicit override that is audited.
3. A Class F batch, after schema-constrained decoding is applied, shows a drop in parse/schema failures on the frozen sample. Few-shot-only on that same batch is allowed to compete; if schema wins on reliability *and* cost, schema ships.
4. Class rates (not a single "quality score") are visible: format-fail rate, re-run disagreement rate, groundedness-fail rate, human-labeled R/A rates on the audit sample.
5. Prompt token count attributable to few-shot examples is a tracked number and has an owner who can delete examples that no longer move a class rate.
6. The 2-minute answer above is consistent with the playbook. If the playbook says "add examples" as step 1 for an unlabeled flake, the design has failed its own scenario.

## Business Rules (Triage-Scoped)

1. The original bug-report completion is **evidence**, not the evaluation set. Adding it to the frozen sample is a versioned set change, not a silent mutate.
2. User-facing "flaky" complaints mix this taxonomy with latency, tone, and product disagreement. Triage may reclassify a ticket out of this system (not an LLM failure). That is a success, not a miss.
3. Temperature for tool calls and structured extraction defaults toward 0 unless a documented quality test shows temperature helps *and* a Class S control (validate/retry or vote) is in place.
4. Few-shot examples, when used, are versioned with the schema or instruction they illustrate, have a created-for `failure_record` id, and expire if the next paired eval shows they do not move Class F rate.
5. A mitigation that increases prompt tokens, latency, or cost must beat the baseline on the **target class rate**. "The ticket looks better" is not a cost justification.
6. If the team will not fund a frozen labeled sample, they may still *talk* about the taxonomy (Phase 1). They may not claim production quality control. Calling a longer prompt "our flake system" is the failure mode this rule exists to prevent.

## Non-Goals

- **Not a general prompt-engineering guide.** No catalogue of CoT vs. ReAct vs. "you are a helpful assistant." The playbook is a routing table from five classes to levers, not a textbook.
- **Not a second eval harness.** Golden-set versioning, paired stats, judge calibration, and silent-swap detection live in [prj--support-bot-eval-harness](../../prj--support-bot-eval-harness/README.md). This project **cites** that gate as the verifier. Rebuilding it here is architecture theater.
- **Not a hallucination detector.** Class G and some of Class R overlap [prj--llm-hallucination-detection](../../prj--llm-hallucination-detection/README.md). This project classifies and routes; it does not score production traffic for hallucination risk.
- **Not an implementation.** No SDK, no JSON schema library, no CI YAML. Numbered steps and diagrams only.
- **Not a claim that flakiness reaches zero.** Residual Class R (the model is wrong and consistent), residual Class G (the document was never ingested), and residual Class S (the provider ignores seed) will remain. The system makes those **named residuals**, not a generic shrug.
- **Not a claim that few-shot is always wrong.** Confirmed Class F on a prototype with no structured-output support is exactly when you add two examples and move on. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md). The trap is using that move as the *default for unlabeled flakiness*.
- **Not required for a one-off internal script you will delete on Friday.** Applying this whole machine to a throwaway notebook is the same costume as applying a webhook inbox to "user updated their avatar."
