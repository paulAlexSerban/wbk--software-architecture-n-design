# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This is the document that answers the scenario's questions directly. The other docs exist so those answers are implementable. If you only read one file after the [Business Overview](./01_business_overview.md), read this one.

The scenario: **detect LLM hallucination in production, at scale, without ground truth.** The trap: ship "another LLM checks the first LLM" and call it a system. The actual work is proxy signals, known blind spots, a cost tax you can defend, and an operating point whose false-positive bill the product can pay.

There is no architecture in which this detector "solves hallucination." There is an architecture in which you **know what you are catching, what you are missing, and what each extra point of recall costs.**

## 1. Named blind spots of each signal

If a method cannot see a class of error, stacking more of that method does not help. This table is the coverage map. It is also the list of claims this project **refuses to make**.

| Signal | Catches (when it works) | Blind or inverted | What people pretend |
| --- | --- | --- | --- |
| **Calibrated confidence** (logprobs, verbalized) | Errors that historically co-occur with uncertainty in *this* model, *this* domain, *this* week | **Overconfident systematic mistakes**; many instruction-tuned models; anything after a model swap until refit; verbalized confidence that was prompted into existence | "Low logprob means hallucinated; high means true" |
| **Self-consistency** (k samples, agreement/entropy) | **Variance-driven** unreliability: the model doesn't stably believe the answer | **Confident, consistent hallucination** — the model would say the same invented citation ten times; also greedy T=0 production vs off-policy higher-T probes | "If 5 samples agree, it's verified" |
| **Entailment vs. retrieved sources** | **Unfaithfulness**: claims not supported by, or contradicted by, what you retrieved | **No retrieval** (ungrounded envelope); **faithful summary of a wrong/stale/irrelevant chunk**; claim-splitter errors both ways | "Grounded means true" |
| **LLM-as-judge** (demoted) | Some errors a similar model is willing to call out, sometimes | **Correlated fabrications**, style bias, prompt instability, cost | "It's an independent checker" |
| **User thumbs-down** | Some noticed failures, mixed with everything else | **Errors the user cannot see** (the entire point of the problem); tone/latency/refusal noise | "Feedback loop = labels" |

### The failure mode that should scare you

The dangerous production incident is rarely the model that hedged. It is the model that **always** emits a plausible, stable, well-formed falsehood: a fake case citation, a confident API that does not exist, a policy clause that reads like the rest of the PDF. Self-consistency nods. Logprobs look fine. If you are in RAG and the retriever brought a look-alike wrong paragraph, NLI nods too.

That residual is not a Phase 4 item. It is **structural**. Mitigation that actually works sits **outside** this detector: better retrieval, tools that execute instead of invent, constrained decoding against a schema, human process for high-stakes acts, or **not using an LLM** for that act. A detector program that does not say this out loud will be asked to catch it anyway, and will fail quietly.

### Grounded vs. ungrounded is not a skin

RAG with NLI is a real, limited product: **faithfulness scoring**. Open-domain chat with T0+T2 is a **weaker** product: instability and (mis)calibration scoring. Averaging their AUCs into one "hallucination detection accuracy" is how you hide that ungrounded chat barely works. [ADR-008](./04_architecture_decision_records.md#adr-008) refuses to paper over the gap with live web search in v1, because that is a search/verification product with its own lies (which page is canonical, as of when, in which jurisdiction).

## 2. False-positive cost is not a footnote

Every ROC curve has an operating point. Architecture does not pick it. **Money and trust pick it.** [ADR-005](./04_architecture_decision_records.md#adr-005).

### What a false positive costs

| FP manifestation | Who pays | How it dies |
| --- | --- | --- |
| Hedge banner / "might be unreliable" on good answers | User attention | Cry wolf: the banner becomes wallpaper; true positives stop working |
| Hard block / refuse | Task completion | Abandonment; users learn the magic words to jailbreak the hedge, or they leave |
| Extra wait for k samples on the critical path | Latency SLO, conversion | Product team turns T2 off in a hotfix and never turns it back on |
| Human review | Staff hours | At 100 QPS, 1% escalate = 86,400 items/day. That is not "HITL." That is a company. Overflow rubber-stamps or the queue is a landfill |
| Extra tokens | Margin | T2 at k=3 on 10% of traffic is a **30% generation-budget tax**. If hallucination harm on that product is smaller than 30% of serving cost, the detector is a net loss even at perfect precision |

### What a false negative costs

Highly domain-dependent. That sentence is the whole policy design.

- **Low**: wrong restaurant hours, slightly wrong trivia, a made-up but harmless metaphor. FP cost of aggressive blocking exceeds FN cost. Annotate lightly or accept residual.
- **Medium**: wrong internal policy to employees, wrong code that looks like it compiles, wrong citation in a blog draft. Mix of annotate + optional tool-check; rarely hard-block all traffic.
- **High**: medical, legal, financial advice, safety procedures, anything that triggers a regulated action. FN cost can justify fail-closed, buffered (non-streamed) answers, and a staffed queue — **if** those are funded. A high-FN-cost domain with **no raters, no queue, and streamed tokens** cannot honestly deploy this detector as a control. It can deploy it as telemetry while the actual control is "don't let the model do that."

### There is no universal precision/recall

A number like "we target 90% recall at 80% precision" is meaningless until you plug in base rate and costs. If 2% of answers are hallucinated and you flag 10% of traffic, you are mostly flagging good answers even at "pretty good" precision. If you then send those flags to humans, you have built a machine for burning reviewer attention on true negatives.

**Worked sketch (illustrative, not a measurement):** 1M responses/day, 3% hallucination base rate (30k bad). A threshold with 70% recall and 40% precision catches 21k bad and flags 52.5k total, of which **31.5k are fine**. If action is a banner, you trained 31.5k users that day to ignore you. If action is a human, you need ~31.5k extra reviews of good content plus 21k of bad. If action is T2 k=5 on all flags, you just bought ~260k extra generations/day to *maybe* refine the score.

Tune that sketch on **your** base rate in Phase 0. If you do not know the base rate, you are not ready for live actions. The labeled sample is how you estimate it.

## 3. Cost and latency: the 2–5× tax is real

Self-consistency is the scientifically fashionable method in this scenario, and it is the expensive one.

| Design | Extra generator work | Typical placement | Honest yield |
| --- | --- | --- | --- |
| T0 logprobs + calibration | ~0 | Inline | Weak on overconfident errors; cheap enough to always have |
| T1 claim NLI | 0 generator; small model | Inline/near-inline | The actual RAG detector; quality capped by retrieval and decomposition |
| T2 k=3–5 on 100% wait-path | 3–5× **all** traffic, plus wait | User-critical | Research demo; rarely a product |
| T2 k=3 on 5% stratified + trigger | ~0.15× fleet-wide if only stratified 5%; more with triggers | Async or post-stream | Eval + some catch of uncertain errors; **still blind to consistent-wrong** |
| T3 LLM-judge 100% | ~1× more, often longer prompts | Anyone who "just ships the obvious" | Correlated, expensive, circular eval |

**Latency:** NLI on 20 claims × 8 chunks is a batch of cross-encoder forwards. On a small model that can be tens of milliseconds; on a sloppy implementation (serial, huge model, no cap) it becomes another generation. T2 on the wait path adds **another full decode of k-1** (or k if you don't count the user-visible sample). Streaming products almost never get to do that. So the method the interview question wants (self-consistency) is, in production, **mostly an audit/trigger method**, not a pre-send gate. Saying otherwise is a latency lie.

**If the serving API does not return logprobs**, T0 is gutted. Do not "fix" that by scoring every completion with a second forward pass at 100% — that *is* the 2× tax, quietly. Sample it.

## 4. What I would build

A **sidecar risk pipeline**, not a debate-of-models.

1. **Trace ingest** with envelope and domain ids, chunk **text**, model version. Without this, nothing else is a system.
2. **T0** uncertainty features where logprobs exist, calibrated on a **stratified human sample that oversamples high-confidence traces**.
3. **T1** for every grounded surface: claim decompose + small NLI, claim caps, contradiction treated more severely than mere unsupported.
4. **T2** under a token budget, default **not** on the wait path, stratified fraction sized from a cost spreadsheet not from a paper's k.
5. **A tiny ensemble** fitted on human labels, missing-feature indicators, no judge-in-the-loop.
6. **Per-domain policy** starting in **shadow**, with queue quotas, fail-open default, fail-closed only where an owner funded the fallback.
7. **Probes** for known fabrications and for consistent-wrong, reported as a **residual**, not averaged into a vanity accuracy.
8. **No 100% judge.** Optional async judge as a bias study.

I would **fund raters before GPUs**. The scarce resource is the labeled sample and the honesty to keep it current when the model changes. A beautiful NLI stack on unlabeled traffic is a dashboard.

## 5. What I would give up

Be explicit. These are not "later" unless marked.

**A verdict.** The system outputs risk and a policy action. It does not output "this is false."

**Catching consistent, confident fabrications as a design guarantee.** We will try with probes and high-confidence audit slices. We will miss many. Products that cannot live with that must change the *generator contract* (tools, RAG, schema, human), not file tickets against the sidecar.

**World-truth for ungrounded chat.** No Wikipedia sidecar in v1.

**LLM-as-judge as the architecture.** Analysis tool only.

**Wait-path self-consistency as the default.** Audit/trigger default.

**A global threshold and a single accuracy number.**

**Live banners on day one.** Shadow until the Phase 3 gate.

**Training on thumbs-down.** Prioritization only.

**Fail-closed everywhere.** That is how you take the host product down with your sidecar.

**Open-ended claim counts.** Caps, with a truncation metric.

**Calling telemetry a detector** if labels are unfunded.

## 6. What I would ask for, even though I expect friction

Ask on day 1, in parallel with Phase 0. A no does not block telemetry; it blocks *live actions* or specific signals.

1. **Logprobs (or equivalent token uncertainty) from serving.** Without them T0 is thin. Expected: "the API strips them" or "too much payload." Then T0 is optional and RAG NLI carries the product — if you have RAG.
2. **A funded annotation budget** with dual rating, including high-confidence slices. Expected: "use the judge." Refuse that substitution ([ADR-004](./04_architecture_decision_records.md#adr-004)).
3. **Model-version and prompt-template as first-class serving fields.** Expected: they already exist and are messy. Make them a go-live dependency for calibration.
4. **Envelope honesty from product:** which surfaces are actually "answer from these docs"? Expected: half the "RAG" traffic is the model chatting around the chunks. Those need a product fix, not a more sensitive NLI.
5. **A cost cap** expressed as extra-tokens % and as review-hours. Expected: "quality is the priority." Translate to: *then here is the tax; sign it.*
6. **Retrieval-quality ownership** as a sibling. This detector will otherwise be blamed for faithful-wrong. Expected: retrieval team is busy. Still name the interface.
7. **Permission to keep high-stakes actions off the model** (tools, forms, humans). Expected: the whole point of the LLM project was to automate those. If so, FN cost may exceed what any detector can underwrite.

What I would **not** ask for: a larger judge model, a multi-agent "critic society," or a week of prompt-tuning the generator as a substitute for scoring. Prompting can lower base rate; it is not detection.

## 7. Complexity vs. payoff

| Investment | Complexity | Payoff | Verdict |
| --- | --- | --- | --- |
| Trace contract + shadow logging | Low–medium | Attribution; the whole program's spine | Mandatory |
| Human labeled sample + guidelines | Medium (people, not code) | The only real eval and calibration | Mandatory for a detector; skip ⇒ telemetry |
| T1 NLI on RAG | Medium | The best independent signal in the set | Mandatory if you have grounded traffic |
| T0 calibration | Medium | Cheap ranking; dies on overconfidence and drift | Do; do not oversell |
| T2 budgeted consistency | Medium–high (serving, money) | Some uncertain-error catch; eval | Do on a budget; do not put on 100% wait path |
| Tiny ensemble + per-domain policy | Medium | Operating point in product hands | Mandatory if multiple surfaces |
| LLM-judge 100% | Low engineering, high $ | Looks like progress; correlated FN | Do not |
| Multi-agent debate / k=10 wait-path | High | Research-shaped; product-hostile | Do not |
| Open-domain web verification | High | Different product | Out of v1 |
| Retrieval eval / index freshness | High | Fixes faithful-wrong | Sibling project |
| Tool/schema constraints | Medium, on the generator | Actually reduces consistent invention of APIs | Often higher leverage than the detector |

**The uncomfortable summary:** the methods this scenario wants — self-consistency, entailment against sources, confidence calibration — are the right *families*. In production they are **not** a single inline oracle. Entailment is the RAG workhorse and still cannot see retrieval errors. Calibration is cheap and lies after every model bump. Self-consistency is informative when the model is unsure and **silent when the model is a confident liar**, and it is the line item that blows the bill if you treat a paper's k as a default.

If leadership needs "we detect hallucinations" as a binary, this project should not ship. If they need a **risk instrument with a residual**, this is that instrument.

## 8. Direct answers the scenario is fishing for

**Q: How do you detect hallucination without ground truth?**  
A: You don't, per request. You score **proxies** (uncertainty, disagreement, unfaithfulness to retrieved text), you fit and evaluate those proxies on a **small labeled sample**, and you accept a **named residual** (consistent-and-wrong, faithful-wrong).

**Q: Why not another LLM?**  
A: Correlated errors, ~1× cost, not gold, circular eval. Optional async analysis only. [ADR-003](./04_architecture_decision_records.md#adr-003).

**Q: Isn't self-consistency the answer?**  
A: It is an answer to **instability**, not to hallucination. Production placement is budgeted and usually off the wait path. [ADR-002](./04_architecture_decision_records.md#adr-002).

**Q: What about RAG?**  
A: Check **faithfulness**, with claim decomposition and a small NLI model. Do not advertise truth. [ADR-006](./04_architecture_decision_records.md#adr-006).

**Q: Where do you set the threshold?**  
A: Per domain, from labeled precision/recall plus an explicit FP cost (banners, blocks, review hours, extra tokens). There is no architecture default. [ADR-005](./04_architecture_decision_records.md#adr-005).

**Q: When is the program a failure?**  
A: When live actions ship without labels; when flag rate exceeds review or UX budget and nobody moves the threshold; when a model swap keeps the old curve; when exec reporting hides the consistent-and-wrong slice; when extra-token tax exceeds harm avoided. Those are kill criteria in the [Phased Implementation Plan](./06_phased_implementation_plan.md).
