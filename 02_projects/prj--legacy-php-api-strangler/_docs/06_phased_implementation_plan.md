# Legacy PHP API Strangler — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. Phases 0–3 are sequential. **Phase 0 is not optional and is not documentation theater** — extracting `orders.php` without a snapshot is how the website's totals move and nobody can prove it. Phase 4 repeats Phase 3's gate per slice. Phase 5 is hardening after at least one real slice is in production.

Rollback/kill criteria at the bottom apply at every phase. In particular: **never ship an API endpoint whose backing rule was not characterized (or explicitly exempted as a dated duplicate per [Trade-offs §4](./05_tradeoffs_and_honest_assessment.md#4-when-this-approach-is-not-worth-it)).**

Calendar assumptions: one engineer who already knows the PHP app, a CI system that can be made to boot it (or Phase 0 fails the CI ask), mobile's first screen identified. "The whole website as an API" is not a date; it is a series of Phase 4 slices.

## Phase 0 — Inventory, Fixtures, Characterization Harness

**Objective**: Replace folklore with a list of seams, a seedable test database, and a green golden-master run against **current** HTML for the first target page(s). No API handlers yet except perhaps a spike that is thrown away.

**Deliverables**:
- **Page inventory** for the ranked mobile screens: file path, URL, session required, important implicit rules (hidden rows, rounding, who may view), `echo`/`header`/`exit`/`$_SESSION` notes, first-guess seam.
- **Login facts**: hash algorithm, 2FA or not, lockout, what `$_SESSION` keys exist.
- **DB access facts**: PDO/mysqli, how connections are created, whether `mysql_*` still appears (if it does on PHP 8, stop and deal with that as a separate emergency — it should not).
- **Test DB + seed script** that can reproduce at least the first page's cases: empty, typical, other-user, ugly totals.
- **CI path**: app boots, PHPUnit runs, at least one HTTP request to a legacy URL succeeds in CI.
- **Golden-master harness** with a documented normalizer (CSRF, timestamps). Snapshots **recorded from the current app**, reviewed once so we know they are not already garbage.
- **First slice pick**: one resource (list and/or detail) that mobile actually ships first. Not "auth" yet unless the first screen is login-only.
- Written asks from [Trade-offs §3](./05_tradeoffs_and_honest_assessment.md#3-what-i-would-ask-for-even-though-i-expect-a-no). Do not wait for replies except the kill-level ones (CI, disposable DB).

**Exit Gate**:
- [ ] Inventory exists for the first-ship screens, including implicit rules observed from the HTML, not from memory.
- [ ] CI runs the harness against the first target page; the snapshot is committed and green.
- [ ] Other-user / logged-out cases are in the snapshot set (or explicitly N/A with evidence).
- [ ] Test DB can be dropped and reseeded in one command.
- [ ] Feasibility call: **CI + disposable DB → proceed.** **No CI and no prospect of CI → do not enter a large extraction program**; see standing kill criteria.
- [ ] First slice is named. If mobile has not ranked screens, pick the smallest real read and say so.

## Phase 1 — API Skeleton and Error Boundary

**Objective**: Prove the second front door: routing, JSON-only errors, zero legacy page execution. The website must be bit-identical for URLs you are not editing (you should be editing none in this phase except webserver config).

**Deliverables**:
- Webserver rewrite: `/api/v1/*` → API front controller.
- Composer, PSR-4 for `src/`, PHPUnit in CI.
- Router: `GET /api/v1/health` returns JSON 200.
- Error boundary as in [System Design §5](./03_system_design.md#5-errors): `display_errors` off for this entry, exception/error/shutdown handlers, envelope for 404/405/500.
- Contract tests: health 200 JSON; unknown path 404 envelope; wrong method 405; a deliberately thrown exception in a test-only route (or equivalent) yields 500 envelope and valid JSON (`json_decode` succeeds).
- A test that the response body is not prepended by a notice (fail if first byte is not `{`).
- **No** `session_start()` in the API bootstrap.

**Exit Gate**:
- [ ] `GET /api/v1/health` never includes a legacy page script (grep/review the handler path).
- [ ] Contract tests above are green in CI.
- [ ] Golden masters from Phase 0 still green (prove the rewrite rule did not steal website URLs).
- [ ] A request to an existing page URL still hits the old script (spot-check in CI or a documented manual check plus access log).
- [ ] Unmatched `/api/v1/nope` is JSON 404, not the website HTML 404.

Do not start extracting business pages in this phase. Temptation will be high. The boundary is the product of Phase 1.

## Phase 2 — Auth: Shared Credential Check and Tokens

**Objective**: Mobile can log in without a PHP session. Website login still uses sessions. Password verification lives in one place.

**Deliverables**:
- Characterization of `login.php` (success redirect, failure HTML, session cookie set) **before** touching it.
- Extract credential check to a domain class/function: no `header`, no `$_SESSION`.
- `login.php` calls it, then starts session as before. Golden master green.
- `api_tokens` table. Issue/hash/lookup/revoke per [System Design §4](./03_system_design.md#4-authentication).
- `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, auth middleware.
- Login throttling on the API (even if the website has none).
- PHPUnit on credential check (wrong password, right password) and on token expiry/revocation.
- Contract tests: login 200 + token; login 401 generic; authenticated logout; revoked token 401; missing header 401; cookie-only request 401 (prove we do not honor `PHPSESSID` on the API).
- Rate-limit or lockout test for API login (at least a unit test of the policy).

**Exit Gate**:
- [ ] Website login golden master green.
- [ ] API login does not `Set-Cookie` a `PHPSESSID` that subsequent API calls require. (A leftover cookie from a confused client must not be sufficient auth.)
- [ ] Revoked token fails on the next request.
- [ ] Destroying a web session (logout on the website) does **not** revoke the API token (document this; add a test that logs in both ways).
- [ ] Raw token is not in the database (query the table in a test).
- [ ] Credential check is the only password-verify path used by both logins (review).

## Phase 3 — First Vertical Slice

**Objective**: One real resource, shared class, mobile can call it, website HTML unchanged. This is the proof of the whole architecture.

**Deliverables**:
- Follow [System Design §3](./03_system_design.md#3-extraction-procedure) on the Phase 0 named slice.
- Domain class: user id as argument, typed exceptions, no SAPI I/O.
- Page wired to the class; autoload bootstrap on that page.
- PHPUnit on the class (same cases as snapshots).
- API handler with explicit JSON field allow-list.
- Contract tests: 200 shape, 401, other-user 403/404 per policy, validation if any.
- Debt log entry if `ob_start` was required (or a signed note that it was not).

**Exit Gate**:
- [ ] Golden master diff empty in CI for every URL listed for this slice.
- [ ] Domain class contains the query/calculation; handler and page do not duplicate it.
- [ ] `$_SESSION` does not appear in the domain class.
- [ ] Other-user case matches the documented policy on both HTML and API (HTML via snapshot, API via contract test).
- [ ] JSON allow-list does not dump raw PDO rows with extra columns.
- [ ] Autoload is required on the edited page; a CI request to that page does not 500 with "class not found."

If the slice is a dated duplicate exemption (§4 of Trade-offs): this phase's extraction gate is replaced by: written exemption, kill-by date, contract tests for the handler, and **no claim of shared rules**. That exemption cannot be used for a write endpoint or a price/permission rule.

## Phase 4 — Expand by Slice

**Objective**: Repeat Phase 3 for each remaining first-ship screen, in rank order. No new architectural components without a new ADR.

**Entry Gate**: Phase 3 shipped (or an approved exemption) and is in the same CI as the rest.

**Deliverables**:
- Per slice: the Phase 3 list.
- Shared helpers only when a second slice proves duplication inside `src/Domain` (not on speculation).
- If a new slice would use a rule already duplicated under exemption, **pay the extraction tax now**.

**Exit Gate (per slice)**: identical to Phase 3.

**Exit Gate (for "v1 mobile")**:
- [ ] Every endpoint the shipped binary calls has passed a Phase 3 (or documented exemption) gate.
- [ ] No endpoint in that set `include`s a render-only template.

This phase has no calendar end. It ends when mobile stops needing endpoints or when someone funds a rewrite.

## Phase 5 — Harden

**Objective**: Operate the API like a small production surface, without turning it into a platform rewrite.

**Entry Gate**: at least one non-health, non-auth endpoint has passed Phase 3 and been used by a real client (or a staging client that is not the author).

**Deliverables**:
- Request id + structured request logs (no raw tokens, no passwords).
- Rate limiting beyond login (per token / per IP) if abuse is plausible.
- Token sweeper for expired rows.
- OpenAPI or equivalent field list published to the mobile team (can be handwritten).
- Deprecation policy: how `/api/v2` would be stood up; additive-vs-breaking rules restated.
- Revisit the debt log: any `ob_start` older than one slice cycle is either removed or re-justified.

**Exit Gate**:
- [ ] Logs can answer "which user, which route template, which status" without the raw bearer token.
- [ ] 500 spike has an alert path using whatever already pages people.
- [ ] Debt log reviewed; no silent catch-all buffer.

Laravel, GraphQL, and "now we extract the rest of the site" are not Phase 5.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop and escalate — do not "keep the mobile demo green" — if any of the following hold:

1. **No disposable test DB and no CI HTTP** to the real front controllers. Characterization is fake. Do not extract; at most, dated duplicates plus a written "we do not match the website."
2. **Golden master red** and the slice is merged anyway. Roll back the page change.
3. **API honors PHP sessions** as sufficient auth. Roll back middleware to tokens only.
4. **Handler `include`s a page template** to produce JSON. That is the architecture failing. Delete the handler.
5. **Catch-all `ob_start` in the API bootstrap** "to make tests pass." Remove it; fix the `echo`.
6. **Pressure to skip snapshots** because a deadline. Either slip, or ship a dated duplicate with the honesty label — do not skip the snapshot *and* claim extraction.
7. **Credential hashes re-encoded** in the same PR as API login without a migration plan. Split the PR.
8. **Mobile promised the entire website** as if Phase 4 were a weekend. Reset the backlog to ranked slices; do not "just add routes."

Rollback is always to the last phase whose exit gate was honestly green. After a kill on extraction, the website snapshots remain the source of truth for HTML; the API may be reverted independently because it is a second entry point. That independence is the point of [ADR-001](./04_architecture_decision_records.md#adr-001). Use it.
