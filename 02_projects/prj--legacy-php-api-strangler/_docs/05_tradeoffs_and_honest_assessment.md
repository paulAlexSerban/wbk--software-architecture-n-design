# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone adds a router and calls it a platform.

The trap, once: **the domain is the template.** There is no framework, no tests, and a mobile client that will treat your JSON as truth. Designing a "clean API layer" without a procedure for getting logic *out* of `echo` is not ambitious. It is how you ship two applications that disagree.

## 1. What I would build

A **second, small PHP application at the edge**, not a JSON mode on `orders.php`, and not a rewrite.

- **Webserver split**: `/api/v1/*` → new front controller; everything else untouched. This is a rewrite rule, not a product.
- **A tiny router, a JSON error boundary, a health endpoint.** Prove that a request can go through PHP and come out JSON even when `display_errors` used to be on. If you cannot do this, you cannot do the rest.
- **Composer + `src/Domain` + PHPUnit**, scoped to new code. The legacy include graph stays a soup.
- **Characterization harness** for pages you will touch, in CI, **before** extraction. This is the actual project. The API is the easy consumer of work the harness makes safe.
- **Credential check extracted once**, then **opaque hashed bearer tokens** in `api_tokens`. PHP sessions continue for browsers. No attempt to unify.
- **Vertical slices in mobile-ship order**: characterize → extract → page call → same class on the API → contract tests. One resource that matches the website is a win. Twelve handlers that `include` templates are a loss.

If Phase 0 finds that the first screen needs two fields from a table the 800-line page barely uses, I would still build the edge, the boundary, and auth — and I would **consider a documented duplicate read** for that screen rather than extracting the 800 lines to ship a phone number. The strangler is a default, not a religion. See §4.

I would not build: Laravel beside the app "to do the API properly," a microservice that owns orders, GraphQL, JWT, a BFF on Node that reimplements prices, or a session-cookie adapter for React Native.

## 2. What I would give up

Be explicit. These are not "later" in v1. Some are never in this design.

**A single auth mechanism.** Two systems is the product of matching two clients. They will not collapse because we wrote an ADR. SSO/token unification is a different budget.

**Feature-complete API on the first deadline.** The API's surface area is the set of extracted slices. Anyone promising "whatever the website can do, the app can do" in the first milestone is promising a rewrite. I would give up that sentence in writing on day 1.

**Pretty domain model / repository/unit-of-work / events.** Slice 1 is a class that runs the query and returns an array (or a boring DTO). If that offends, the mobile client can wait while we name things.

**Fixing the website's error handling, CSRF, or session flags as a prerequisite.** Those are real bugs. They are not this project's ticket unless they block characterization or leak onto the API process. Scope predator.

**Global output buffering as architecture.** We give up the convenience of "just catch whatever the legacy prints." Leaks must be loud.

**JWT fashion.** We give up stateless verification we do not need, and we keep revocation.

**Testing the unextracted 80% of the app.** We give up coverage percentages as a success metric. We characterize what we touch.

**The fantasy that extraction is free because "it's just moving code."** The cost is discovering implicit rules (sort order, hidden rows, who may see a total) that were never written down. Moving code is the short part.

**Microservices.** One DB. In-process classes. A separately deployed "order service" is how you spend six months on network failure modes instead of on golden masters.

**Breaking the website to go faster.** If the harness is red, the slice is not done. Demo day is not an exit gate.

## 3. What I would ask for, even though I expect a no

Ask **once, in writing, on day 1**, in parallel with Phase 0. A no must not block the strangler. A yes is a gift.

Ask product / mobile:

1. **The actual first-ship screen list**, ordered. "The API" is not a backlog. Expected: a slide with twenty screens. Ask them to rank anyway.
2. **Permission to ship v1 with a subset**, and a written statement that extra screens wait on extra slices. Expected: they say everything is P0. Make them rank in public.
3. **Whether mobile may show a different (simpler) number** than the website for a known field. If yes, that is a bounded context, not an extraction. Expected: "must match." Then extraction is not optional for that field.

Ask whoever owns the PHP app:

4. **CI that can boot the app and hit it over HTTP** (docker-compose, a staging box, anything that is not a laptop). If this is a no, characterization is a ritual and the design is compromised. Escalate; this is the one ask that is close to a kill criterion.
5. **A test database we are allowed to destroy and seed.** If the only DB is production, we do not extract.
6. **Time in the estimate for 30–40% test scaffolding.** If PM deletes that line, they have deleted the safety net. Say that.

Ask security/ops (cheap asks):

7. **HTTPS and `display_errors=Off` in production** if not already true. If production HTML shows notices, we still turn them off on the API process; the website remains a separate embarrassment.
8. **Where secrets live** (DB password, future token pepper). If they live in a PHP file in git, Phase 1 still ships, but we record it.

What I would **not** ask for: a freeze on all HTML changes (you will not get it; characterization will hurt instead), a rewrite in Symfony as a prerequisite, a dedicated API team with no permission to edit `orders.php` (they will duplicate; that is the failure mode).

## 4. When this approach is not worth it

The strangler is the default because disagreement is expensive. It is the wrong spend when:

**The page is an 800-line entanglement and mobile needs two inert fields.** Example: `GET /api/v1/store/phone` when `store.php` also computes inventory, VAT, and PDF invoices. Extracting "the store" to ship a phone number is how the API project becomes a VAT project. Honest move: a 20-line handler with its own SELECT of those two columns, a comment `DUPLICATE OF store.php lines 40-42, kill by DATE or when we extract billing`, and a calendar reminder. The **second** handler that needs a rule from that page pays the extraction tax. One duplicate is a tactic. Five is a new monolith in `src/Api`.

**The rule is already wrong on the website and product wants mobile to be correct.** Then you are not extracting; you are changing the business. Do it as a product change with a website HTML update and a snapshot update, or accept two rules and name them (`legacy_total` vs `tax_inclusive_total`). Pretending an extraction "cleaned" a number the page still shows wrong is how support tickets go in circles.

**There is no CI and no prospect of CI.** Then golden masters will not run. I would not run a large extraction program. I would build the edge + auth + a handful of **duplicated, obviously simple reads**, and I would say in writing that matching the website is **not guaranteed**. That is an ugly design. It is more honest than a strangler on paper.

**The mobile client is a WebView of the existing site.** Then you do not need this API. That is a product choice. Do not build tokens for a WebView that should have sent cookies to the website (and then you live with the WebView cookie pain, which is still cheaper than a fake REST layer).

**You are six weeks from a planned rewrite.** Do not extract into a building that is coming down. Duplicate the three reads, and spend the characterization budget on the rewrite's acceptance tests.

## 5. Complexity, said without romance

| Thing people think is the work | What is actually the work |
| --- | --- |
| Writing a router | An afternoon |
| JSON envelope | A morning |
| Token table | A day including hashing and logout |
| "Moving logic into a class" | Finding the implicit rules, seeding fixtures that reproduce them, and discovering the template had three copies of the total |
| Golden masters | Fighting CSRF, dates, and "this button only shows on Tuesdays" |
| Not breaking prod HTML | The job |

**Two auth systems:** you will explain, more than once, why logging out of the website did not kick the phone off. That is not a bug in the design. Put it in the mobile FAQ. If product demands one logout switch, that is a small explicit feature (revoke all tokens *and* destroy session) — still two stores, one button.

**Output buffering:** every use is a place the API can still emit garbage. Treat the debt log like a vuln list.

**PHP 8 + notices:** the website may run with notices swallowed into HTML. The API will 500. Engineers will ask to "be more like the website." The answer is no; fix the notice.

**Time:** a competent engineer, existing CI, a cooperative first page (list + detail, one query each, no `exit` in helpers): **on the order of 1–2 weeks to Phase 3** (health, auth, one slice). An uncooperative first page (god file, globals, `header()` in helpers, no fixture environment): **Phase 0 alone is a week**, and the honest conversation is §4.

This is not "senior architecture." It is disciplined plumbing. The architecture is mostly the list of things we refuse.

## 6. Brutal summary

The clever design is not a framework. The clever design is **a second front door, a snapshot before you touch a template, one class that both clients call, and tokens that are not cookies**.

The website stays ugly. The API stays small. They agree where it matters because we paid to extract, or they agree to disagree on a two-field duplicate we are ashamed of and dated.

If that still sounds like too much, copy the SELECT, ship the screen, and put the divergence incident on the calendar. Do not call the copy a domain layer.
