# Legacy PHP API Strangler: Business Overview
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Product Vision

A JSON API that a mobile client can call, built over the **same data and the same business rules** as an existing PHP 8 HTML application — without rewriting that application, without swapping its session-based login, and without shipping a mobile client that disagrees with the website about what a number means.

This is not an API platform. It is a **strangler-fig at the edge of a working, untested, framework-less monolith**. The design exists to let a second client exist without turning every template into a shared library overnight, and to refuse two failure modes that look like progress: duplicating the rules in a new codebase, and wrapping HTML in JSON.

## Problem Statement

An existing PHP 8 application renders HTML pages. Business logic is mixed into the templates. There is no framework. There are no tests. A mobile client now needs a JSON API over the same data.

The design must answer, concretely:

1. How requests get routed so `/api/v1/*` never runs through a page that `echo`s HTML.
2. Where shared logic goes, and how it is extracted from a template without changing what the page currently renders.
3. How the API authenticates, given that the web side uses PHP sessions (cookies, `session_start()`, `$_SESSION`).
4. How errors are returned as JSON with correct status codes, even when the code being reused still wants to `echo` a warning or `exit`.
5. How the new endpoints are tested when the existing code has no tests at all.

This is the template-strangler trap. The naive answers — "just `include` the page and parse the HTML," "reuse `PHPSESSID` from the mobile app," "add a `?format=json` branch at the top of each file," "write the API against a fresh query and hope the numbers match" — are the failure. They couple two clients to one entanglement, or they fork the business rules on day one.

## The Trap, Stated Directly

Standard API design assumes **a domain layer you can call**. This application does not have one. The query, the calculation, the access check, the session write, and the HTML are one script. There is no `OrderService`. There is `orders.php`.

If the API is built by copying those queries into new handlers, the two clients will diverge the first time anyone "just fixes a bug" in one place. If the API is built by executing the templates and scraping markup, every CSS change is an API break, and `Content-Type` is a coin flip. If the API is bolted into the existing per-page dispatch, every request pays the cost of whatever that dispatch does for browsers (session cookies, output buffering nobody understands, `header()` calls that already ran).

The correct shape is: **leave the legacy front door alone; add a second front controller that owns `/api/v1`; extract one vertical slice at a time behind characterization tests; share the extracted class, not the template; authenticate mobile with tokens, not cookies.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true when there are no tests, some scripts `exit` mid-render, and the first mobile screen is due before the monolith is "clean."

## Current State (Assumed Starting Point)

A typical version of this application looks like:

1. Apache/nginx maps URLs to PHP files (`/orders.php`, `/order.php?id=`, `/login.php`). There may be a common `include 'header.php'` and `include 'db.php'`. There is no router.
2. Each page: `session_start()`, ad-hoc SQL, calculations inlined between HTML, `echo` of prices/status/messages, occasional `header('Location: ...')` and `die()`.
3. Login writes `$_SESSION['user_id']` (and maybe a role). Logout `session_destroy()`. CSRF, if it exists, is a hidden form field, not a header.
4. Autoloading is `include`/`require`. Composer may be absent. Namespaces may be absent. PHP 8 is the runtime, not an architecture.
5. Tests: none. Staging is "click the pages." Production incidents are reported by a human looking at HTML.

That version will appear to work for the website indefinitely. It will fail as an API the first time a mobile client needs a stable JSON contract, the first time a warning leaks into a response body, the first time a session cookie is expected to survive a React Native WebView, or the first time someone extracts "just the query" and silently changes a rounding rule the page still displays the old way.

This project documents the strangler, not a rewrite of those pages.

## Target Users

- **Owning engineer**: implements the API and the extractions; needs a procedure they can repeat without gambling production HTML.
- **Mobile client team**: needs a versioned JSON contract, bearer auth, and errors they can branch on. They should not need to know that `orders.php` exists.
- **Web users (incumbent)**: must keep seeing the same pages. Their session login must keep working. They are the regression constraint, not a migration audience.
- **On-call**: needs to tell, from logs and status codes, whether a failure is "API boundary," "extracted domain," or "legacy include that printed a warning."

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which screens the app has, which fields a list includes) are out of scope except as they force a vertical slice.

1. **Existing HTML pages must not change behavior.** An extraction that alters a total, a permission, a redirect, or even incidental whitespace that a consumer's email-scraper depends on is a production defect. Characterization tests exist because of this requirement, not as a testing fashion.
2. **Web and API must share business rules, not duplicate them.** Once a slice is extracted, both entry points call the same class. Deliberate duplication is allowed only as a documented, time-boxed exception (see [Trade-offs](./05_tradeoffs_and_honest_assessment.md#4-when-this-approach-is-not-worth-it)).
3. **Routing for the API must be independent of page dispatch.** `/api/v1/*` is owned by a new front controller. Legacy scripts must not run for those URLs.
4. **Web authentication stays PHP sessions.** The API does not consume `PHPSESSID` as its primary credential. Mobile gets a parallel, revocable, bearer-token mechanism. Credential *verification* (password check) is shared; session and token *issuance* are not.
5. **Every API response is JSON, including errors.** The API process must not emit HTML, PHP warnings, or a blank 200. Status codes must be usable by a client (`401`/`403`/`404`/`422`/`429`/`5xx`), not a family of `200` with `{"success": false}`.
6. **New behavior is tested; old behavior is characterized before it is touched.** Introducing PHPUnit for new code is required. Pretending the untested templates have unit tests is forbidden. The safety net for extraction is golden-master HTTP (or rendered-output) snapshots of the pages being changed.
7. **The API is versioned from day one** (`/api/v1`). A shipped mobile binary cannot be forced to deploy in lockstep with a breaking server change.

## Success Criteria for the Design (Not Implementation Metrics)

1. A request to `/api/v1/health` never executes a legacy page script and always returns JSON.
2. After extracting a slice, the characterization snapshot of the corresponding HTML page is unchanged (diff empty, or a reviewed, documented exception for incidental whitespace that nobody consumes).
3. The same extracted class is the only place the duplicated-before rule now lives; the API handler contains no copy of the SQL or the calculation.
4. A mobile login obtains a bearer token without setting a session cookie that the API then depends on. Revoking the token does not log the user out of the website, and destroying the PHP session does not revoke API tokens unless an explicit "logout everywhere" path is invoked.
5. An unhandled `Throwable` on the API path returns the error envelope and a 5xx, never a PHP stack trace in HTML, and never a half-JSON body preceded by a warning.
6. The first extracted endpoint has: a golden-master test for the page, unit tests for the class, and a contract test for the HTTP API. Endpoints without that triple are not "done."

## Business Rules

1. The API front controller sets `Content-Type: application/json` and installs error handlers **before** including any legacy file.
2. Extracted domain classes do not `echo`, `print`, `header()`, `setcookie()`, `session_start()`, or `exit`/`die`. If they must talk to a world that still does those things, a wrapper at the edge does, not the class.
3. A vertical slice is extracted only after a characterization harness exists for the pages that slice will change.
4. Output buffering around a legacy function is **debt**, recorded as such, with an owner and a revisit trigger. It is not the target architecture.
5. Auth tokens are stored hashed, have an expiry, and can be revoked. The raw token is shown once, at login.
6. Breaking JSON contract changes require `/api/v2` (or a negotiated compatibility window documented in the deprecation policy). They are not "a mobile hotfix."

## Non-Goals

- **Not a rewrite.** The HTML app stays. Templates stay until a slice is extracted, and many templates will stay forever.
- **Not a framework migration.** Laravel, Symfony, Slim-as-the-whole-app, etc. are out of v1. A tiny router inside the API front controller is not "adopting a framework."
- **Not removing PHP sessions.** Web login remains cookie sessions. Unifying on tokens/SSO is a different project.
- **Not a microservice split.** One database, one deployable (or two PHP entry points on the same app servers). Extracted classes are not a separately deployed "order service."
- **Not GraphQL, not realtime, not an SDK.** JSON over HTTPS, versioned paths, documented errors.
- **Not a guarantee that all logic is extractable.** Some scripts will remain wrapped. The design admits that.
- **Not an implementation.** No PHP code, no `composer.json`, no migrations. Numbered steps and diagrams only.
- **Not a claim that this is cheap.** Characterization tests plus careful extraction are 30–40% of the work. A duplicated read-only query for two fields can be the honest answer for a deadline. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).

## Core Value Propositions

1. **A mobile client without a second source of truth.** Once a slice is extracted, the rule lives in one class.
2. **The website remains the incumbent.** Routing, sessions, and untested pages are not collateral of the API project.
3. **Safety is procedural, not heroic.** Characterization before extract; extract before API; tests on the new code. The procedure is the architecture.
4. **Auth mechanisms match their clients.** Browsers keep cookies. Mobile gets bearer tokens. Shared secret is the password check, not the session store.

## Success Metrics

These are starting points, not SLAs pulled from a hat.

1. **Zero unreviewed HTML diffs** on pages touched by an extraction, as measured by the golden-master suite in CI.
2. **API error leak rate**: count of API responses that are not valid JSON or that have a non-JSON content type. Target after Phase 1: zero in the test suite; treat production leaks as incidents.
3. **Rule-drift incidents**: bugs caused by web and API disagreeing. After a slice is extracted, this number should be zero for that slice. If it is not, the slice was not actually shared.
4. **Time-to-next-endpoint**: after Phase 3, a subsequent slice should follow the same procedure. If each slice still feels like a unique research project, the procedure is not written down well enough or Phase 0's inventory was fiction.
5. **Token revocation works**: a revoked token is rejected on the next request. This is a functional test, not a metric, and it is load-bearing because JWT-without-a-store cannot do it cheaply.

## Stakeholders / Consumers

1. **Mobile client**: HTTPS JSON, bearer token, `/api/v1`.
2. **Web users**: unchanged HTML and cookie login.
3. **Owning engineer**: two entry points, one extracted domain, a test harness that did not exist last month.
4. **Mobile team**: contract consumers; they do not get to require a rewrite of `orders.php` as a prerequisite of sprint 1, and they do not get an endpoint whose backing logic was not characterized.
