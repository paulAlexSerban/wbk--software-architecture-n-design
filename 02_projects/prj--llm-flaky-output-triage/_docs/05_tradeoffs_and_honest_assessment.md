# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This is the document that answers the scenario's questions without theater. The other docs exist so those answers are implementable. If you only read one file after the [Scenario](./01_scenario_and_requirements.md), read this one.

## 1. Direct answers

### 1.1 Why "just add more few-shot examples" is usually wrong

Few-shot examples demonstrate an input→output **mapping**. That mapping is a legitimate control for **shape and style** (Class F, and illustrating a rewritten Class A contract). It is not a control for:

- **Missing facts** (Class G). The example does not retrieve the policy table. If you paste the missing document into the example, you have built a non-indexed, unmaintainable knowledge base inside the prompt, and you will do it again for the next SKU.
- **Broken inference** (Class R). The model can copy the *cadence* of the example ("step 1… step 2… therefore deny") and still apply the wrong rule. You have installed a prior. Priors are sticky.
- **Sampling variance** (Class S). Entropy comes from temperature/top-p (and from the provider ignoring your seed). Extra examples bias the format of the distribution; they do not make CI deterministic.

The move is also **not free**: tokens and latency on every subsequent call, window stolen from retrieved context (which can *create* Class G), stale examples after the schema or policy moves, and a debugging culture that never looks at retrieval or decoding.

If the teammate's evidence is "I added two examples and the paste looked better," that is the expected overfitting signature. It is not a class-rate result.

### 1.2 What you actually do

Name the class, then pull the lever that can move it, then measure that class on a frozen sample. The [playbook](./03_system_design.md#3-mitigation-playbook) is the short form. The [2-minute answer](./01_scenario_and_requirements.md#the-2-minute-answer) is the spoken form. They are the same design.

### 1.3 This is slower than their fix. That is the trade-off.

A prompt PR with two examples: twenty minutes. Capture + screens + label + retrieval ticket + paired eval: hours to days. **If the paste was Class F and the provider has no structured output, they were faster and locally correct.** The architecture pays that tax on purpose to stop the other four classes from being "fixed" that way. If your actual distribution is 90% Class F preambles on an internal tool, **do not deploy this whole machine** — add the examples, prefer a schema if you can, stop.

## 2. When few-shot *is* the right call

Say this out loud or the 2-minute answer becomes dogma and people will ignore the rest.

| Situation | Why examples are OK | Still do |
| --- | --- | --- |
| Confirmed Class F, provider has **no** structured output, fail rate is parse/preamble | Mapping is the actual defect | Cap the number (2–5), version with schema, expiry after the next eval, validate-and-retry in front |
| Confirmed Class F, schema constraint is on, a *residual* style issue remains (key order the parser is picky about, etc.) | Reinforcement, not control | Keep the schema as control; examples are optional and first to delete |
| Class A after the instruction was rewritten | Illustration of the new contract | If you skip the rewrite, you are masking other interpretations |
| Weekend prototype / throwaway notebook | Process overhead exceeds product risk | Delete the repo on Monday including the examples |
| One-off internal tool, low QPS, one user (you) | Per-call token tax is negligible | Do not cite this as production quality control |

**Not** on the OK list: unlabeled "flaky"; Class G/R/S; "we'll add examples until eval looks good" with a generic mean; examples as a substitute for a schema the API already supports.

## 3. Cost comparison: permanent few-shot vs. fixing the lever

Illustrative arithmetic — replace with your tokens and QPS in Phase 4. The *shape* is the point.

Assume 3 few-shot examples × 400 tokens × 2 (you also pay for them in the implicit "style" they induce) is conservative; many teams paste full transcripts and sit at 1–2k extra input tokens.

| | Status-quo few-shot patch | Correct-lever (by class) |
| --- | --- | --- |
| **F** | +N example tokens × every call, forever; still drifts when schema changes | Schema constraint: ~0 extra tokens, or a JSON schema once in the request; parse-fail rate usually drops harder |
| **R** | Tokens forever; may overfit and distort adjacent cases | Tool-offload / deterministic rule: one engineering task, then **zero** model tokens for that decision |
| **G** | Tokens forever **and** worse retrieval (window) | Chunking/query work is a project, not a PR. After that, examples are not on the hot path |
| **S** | Tokens forever; CI still flakes | Temperature 0: **negative** cost (often fewer garbage tokens); majority vote is the expensive option — k×, use only when you insist on T>0 |
| **A** | Tokens forever; other audiences break | Instruction rewrite: usually *fewer* tokens than the example you would have added |

**Human cost of this design:** rater time, eval tokens at merge, slower patches. **Human cost of the status quo:** every future flake, incident reviews where "we thought examples fixed it," and retrieval owners who never got the ticket.

If QPS is 0.1 (internal), the token tax is rounding error and the human process can be the larger cost — see §1.3. If QPS is 50 and the prompt picked up 1,200 tokens of incident-examples, you are paying for a small second product that does not work.

## 4. What this system cannot promise

1. **Zero flakiness.** Residual Class R (consistent and wrong), residual Class G (document never ingested), residual Class S (provider ignores seed, or T>0 is required for quality). The system **names** residuals. It does not delete them.
2. **A crisp R vs. G boundary.** A wrong answer with documents "in context" may be ignored-clause, truncated-clause, stale-clause, or wrong-doc-retrieved. Forcing a primary class is an operational convenience. Disagreement is information. Anyone selling a classifier with 99% accuracy on this boundary is classifying something else.
3. **Catching a failure mode nobody has seen.** The taxonomy is not complete. A new mode (tool-schema mismatch, prompt-injection, provider silent swap) needs a version bump or belongs in another project ([eval harness](../../prj--support-bot-eval-harness/README.md) for silent swap; [hallucination detection](../../prj--llm-hallucination-detection/README.md) for production risk scoring).
4. **Population class rates from the failure store.** The store is a biased sample of things people noticed plus parse fails. Phase 4 sampling is what makes rates honest. Until then, dashboards of "our flakes are 70% format" are "our tickets are 70% format."
5. **That the 2-minute answer will win.** A teammate with a demo and a deadline can still merge examples. The architecture's teeth are ADR-001/004 at merge time. Without that gate, this is a style guide.
6. **That structured output fixes content.** Constraining JSON can *increase* fluent wrong values in required fields. Watch Class R/G when you ship a schema. This is a known nasty interaction, not an edge case.

## 5. Classification is genuinely fuzzy — operational rules for the messy cases

| Mess | What not to do | What to do |
| --- | --- | --- |
| R vs. G | Default to prompt/few-shot | Require chunk texts; if absent, G or `class_unknown`; if present, quote the span or admit it wasn't there |
| F + semantic error | Stop at F because the parser is easy | F as secondary; keep classifying the amount/date/policy |
| S vs. R | Call it "non-deterministic reasoning" and add examples | T=0 re-run. Good at 0 → S. Bad at 0 → not S |
| A vs. R | Treat every surprising interpretation as a model bug | Ask whether the instruction allowed it. If yes, rewrite the contract |
| Judge/LLM says "hallucination" | Treat as gold class | Out of bounds for v1 classifier ([ADR-005](./04_architecture_decision_records.md#adr-005)) |

**Target agreement, not theater:** if two trained raters cannot beat ~70% pairwise agreement on R vs. G after a guide revision, **do not automate**, and consider collapsing R+G into "wrong_answer_needs_context_review" for operations while keeping the distinction as a *suspected* tag. A five-class taxonomy with coin-flip R/G is worse than a four-class taxonomy you can use. That collapse would be a taxonomy version, not a quiet slide.

## 6. Complexity vs. payoff (be adult about this)

| Investment | Complexity | Payoff | Verdict |
| --- | --- | --- | --- |
| Taxonomy + labeling guide + 30 labeled real failures | Low–medium (calendar, not code) | Makes the 2-minute answer falsifiable | Mandatory if you will argue this in production |
| Ticket template / completeness fields | Low | Stops screenshot-only "classification" | Mandatory |
| Deterministic parse screen + T=0 re-run | Low | Auto-F and cheap S; keeps ADR-001 survivable | Do |
| Schema-constrained decoding | Low–medium (provider) | Best Class F control, cheaper than examples | Default when available |
| Few-shot example table + token budget | Low | Makes rot visible | Do if any examples exist |
| Playbook as PR checklist | Low | Teeth without a platform | Phase 2 |
| Paired eval on frozen sample | Medium (harness or stub) | Catches the G-with-examples PR | Phase 3; without this the rest is a pamphlet |
| Production class-rate monitor | Medium | Notices regressions | Phase 4, after labels exist |
| LLM classifier suggestions | Medium–high | Maybe saves rater time | Phase 5, **conditional** on agreement |
| Majority vote on 100% of traffic | High (k× $ and latency) | Class S when T>0 is required | Not a default. Budgeted, triggered |
| "LLM debug agent" that reads the ticket and edits the prompt | High | Fast wrong levers at scale | Rejected |

## 7. Relationship to sibling projects (do not duplicate them)

- **[prj--support-bot-eval-harness](../../prj--support-bot-eval-harness/README.md)** is the verifier. This project specifies class-stratified metrics and the merge rule. It does not own golden-set versioning, judge calibration, or silent-swap canaries.
- **[prj--llm-hallucination-detection](../../prj--llm-hallucination-detection/README.md)** scores production risk without gold labels. Class G (and some R) *route* toward groundedness signals. This project does not ship an ensemble detector.
- If those projects are not built, this one still works at Phase 1–2 (human taxonomy + playbook) and Phase 3 stub. Claiming "we have hallucination detection because we triage flakes" is a lie.

## 8. Kill criteria

Stop calling this a quality system (keep the taxonomy as a teaching doc if you want) if:

1. Nobody will label a calibration batch, or pairwise agreement stays near chance after one guide revision.
2. Mitigations merge without class + eval as a matter of policy ("we'll backfill").
3. `incomplete_capture` stays the majority because tracing will not log chunk texts / temperature, and nobody will fund that.
4. The only lever that ever ships is still unmarked few-shot, and the example token budget only grows.
5. Phase 5 is demanded before Phase 0's batch exists.

Those are not moral failures. They are a decision that the twenty-minute prompt patch is the actual process. Document it and stop spending architecture on a gate you will not run.
