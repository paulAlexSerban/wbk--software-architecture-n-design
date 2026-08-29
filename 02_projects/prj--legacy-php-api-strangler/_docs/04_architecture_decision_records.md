# Architecture Decision Records

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Strangler-Fig Edge Routing (Separate API Front Controller)

**Status**: Accepted

**Context**: The existing application has no router. URLs map to PHP files. Business logic and HTML share those files. A mobile client needs `/api/v1` JSON. The tempting moves are: (a) add `if (want_json)` to each page, (b) stand up a framework as the new front controller for *all* traffic, (c) put a reverse proxy in front that scrapes HTML, (d) a new front controller that *only* owns `/api/v1` and leave page dispatch alone.

(a) couples every future page change to two content types and still runs `echo` before you notice. (b) is a rewrite of the website, which the scenario forbids. (c) makes CSS a breaking API change.

**Decision**: Introduce a **second PHP entry point** (`public/api/index.php` or equivalent). The webserver sends `/api/v1/*` there and leaves every other URL mapped as today. The API process has its own router (method + path table). Legacy scripts are never the handler for an API route.

**Consequences**:
- (+) HTML dispatch is not a regression surface of "we installed a router."
- (+) JSON content type, error handlers, and "no session" can be invariants of one bootstrap, not a hope about 40 files.
- (+) The strangler is visible in ops: two entry points, one codebase, one DB.
- (–) Two bootstraps to keep aligned (autoload, config, DB credentials). Document a tiny shared `bootstrap/db.php` if needed — config, not domain.
- (–) Developers will try to `require` a page from a handler to "reuse" it. Code review must treat that as a defect.
- **Alternative rejected**: framework-for-everything. Scope explosion. **Alternative rejected**: `format=json` query flag. **Revisit trigger**: if the website itself is later given a front controller, the API can stay separate; merging bootstraps is optional and not a goal.

## ADR-002: Extract-Till-You-Drop with Mandatory Characterization, not Duplicate-or-Rewrite

**Status**: Accepted

**Context**: Logic lives in templates. The API needs the same rules. Three strategies: rewrite the app into layers then add an API; copy SQL into API handlers; extract a class per vertical slice after snapshotting the page.

Rewrite violates the scenario and has no tests to prove equivalence. Duplication is fast and produces two sources of truth. Extraction is slower per slice and requires a safety net the repo does not have yet.

**Decision**: For each slice the mobile client needs, **characterize the HTML, extract a domain class with no SAPI I/O, point the page at it, prove the snapshot, then have the API call the same class.** Duplication is allowed only as a documented, time-boxed exception for a narrow read-only field set — see [Trade-offs §4](./05_tradeoffs_and_honest_assessment.md#4-when-this-approach-is-not-worth-it). A full rewrite remains out of scope.

**Consequences**:
- (+) Web and API cannot silently drift on an extracted slice.
- (+) Each slice leaves the page slightly more testable.
- (–) First mobile screen is slower than a copied SELECT.
- (–) Some scripts will not extract cleanly; buffering debt will exist.
- **Alternative rejected**: "API-only rewrite of the rule, website later." That is two products. **Revisit trigger**: if product permanently accepts different rules on mobile (a different price list, etc.), that is not this architecture — it is a new bounded context and should be named as such, not sneaked in as an endpoint.

## ADR-003: Opaque DB-Backed Bearer Tokens, Decoupled from PHP Sessions

**Status**: Accepted

**Context**: The website uses PHP sessions (cookie + server-side store). Mobile clients are bad session-cookie citizens (WebViews, cookie flags, CSRF, session locking on parallel API calls). JWT is the résumé default. Sharing `PHPSESSID` looks like reuse.

Revocation (logout, stolen device, password change) is a real requirement for an app that can hold a token in OS storage. A signed JWT without a store makes revocation a denylist, which is a store with extra steps. There is one app and one database; there is no fleet of independently deployed resource servers that need to verify without I/O.

**Decision**: **Web keeps PHP sessions. API uses opaque bearer tokens** stored as hashes in `api_tokens`, issued after the shared credential check. No cookie fallback. No JWT in v1. Session destruction does not revoke tokens; token revocation does not destroy sessions, unless a later explicit "logout everywhere" feature is specified.

**Consequences**:
- (+) Native clients send `Authorization` headers, which they understand.
- (+) Revoke is an `UPDATE`. Parallel API requests do not take a PHP session lock.
- (+) Website login remains the boring path that already works.
- (–) Two credential artifacts to reason about in incidents ("logged out of web, app still in"). This is **permanent v1 complexity**, not a bridge. Unifying later is an identity project (SSO, one token family). See [Trade-offs](./05_tradeoffs_and_honest_assessment.md#2-what-i-would-give-up).
- (–) A DB round-trip per authenticated API request. Fine. If it is not fine, the HTML app's session store is probably worse.
- **Alternative rejected**: session cookies for the API. **Alternative rejected**: JWT access tokens with long TTL and no denylist. **Revisit trigger**: a real second service that must validate tokens without hitting this DB — then consider JWT *plus* a denylist/short TTL, not JWT as a simplification.

## ADR-004: Per-Entry-Point Exception Boundary, Typed Errors, JSON Envelope; Output Buffering as Recorded Debt

**Status**: Accepted

**Context**: Legacy code `echo`s warnings, `die()`s HTML, and calls `header()` after output. An API client needs parseable JSON and honest status codes. PHP error handling is process-global if you set it globally, which would change website behavior — forbidden.

**Decision**: The API bootstrap **sets `Content-Type: application/json`, disables `display_errors` for that request, and registers exception/error/shutdown handlers scoped to that entry point**. Domain and handlers throw a small typed set (`Validation`, `NotFound`, `Forbidden`, `Unauthenticated`); the boundary maps them to the envelope in [System Design §5](./03_system_design.md#5-errors). Success responses are the resource, not a `{success,data}` wrapper. `ob_start()` around a specific legacy call is allowed only as **named debt**, never as a global catch-all.

**Consequences**:
- (+) Mobile can `JSON.parse` every response in the test suite.
- (+) Website error display is unchanged.
- (–) Warnings-as-exceptions on the API path can 500 a request that the website would have rendered with a notice in the HTML. That is a feature: the website was lying. Fix the notice in the extracted class.
- (–) Global catch-all buffering will be proposed after the first leak. Reject it.
- **Alternative rejected**: `200` + `{ "ok": false }` for all errors. **Alternative rejected**: HTML error pages when a handler forgets to set content type — the bootstrap sets it first so this is harder.

## ADR-005: Golden-Master Characterization Before PHPUnit on Extracted Code; Contract Tests on New HTTP

**Status**: Accepted

**Context**: There are no tests. Adding PHPUnit around `orders.php` as a unit does not pin HTML. Skipping tests and "being careful" is how the first extraction ships a price change. Writing only API tests proves the API is consistent with itself, not with the website.

**Decision**: **Three layers, ordered:** (1) golden-master HTTP snapshots of pages that will be touched, created *before* edits; (2) PHPUnit on extracted classes against a real test DB; (3) HTTP contract tests for `/api/v1` endpoints, which have no legacy and are written with the handler. CI runs (1) for listed pages and (2)+(3) always. Coverage vanity on unextracted files is not a goal.

**Consequences**:
- (+) Extraction has a diff, not a prayer.
- (+) New code is actually unit-tested, which is the only place unit tests are cheap.
- (–) Snapshot brittleness (CSRF, dates). Must normalize explicitly ([System Design §6](./03_system_design.md#61-characterization-golden-master)).
- (–) 30–40% of project effort. If this ADR is "accepted" but the schedule has no CI, it is not accepted.
- **Alternative rejected**: "characterization later, after we see what HTML we want." Too late. **Alternative rejected**: only contract tests.

## ADR-006: Composer and PSR-4 for New Code Only; Legacy Includes Stay

**Status**: Accepted

**Context**: The app may have no Composer autoload. Extracted classes need a home (`src/Domain/...`) that both entry points can load. Migrating every `include` to PSR-4 is a rewrite of the load graph (circular includes, load-order side effects, files that run code on include).

**Decision**: **Introduce Composer, PSR-4 for `src/`**, phpunit as a dev dependency. Legacy files keep `require`. Pages that call extracted classes `require vendor/autoload.php` (or a 5-line bootstrap). No mandate to namespace `header.php`.

**Consequences**:
- (+) New code looks like PHP 8 anyone can test.
- (+) The load-order minefield of the old app is not a Phase 1 project.
- (–) Two loading styles until the heat death of the app, or until a later, separate cleanup.
- (–) Forgetting autoload on a barely-edited page causes "class not found" in production for a URL that worked before the extraction. The slice checklist includes this ([Phased Plan Phase 3](./06_phased_implementation_plan.md)).
- **Alternative rejected**: "while we're here, PSR-4 the world." **Revisit trigger**: a later dedicated "autoload migration" with characterization of *all* pages — not piggybacked on the mobile API.

## ADR-007: Path Version `/api/v1` from Day One

**Status**: Accepted

**Context**: A mobile binary, once shipped, is not updated when the server is. HTML websites can break clients on every deploy; native apps cannot. Unversioned `/api/orders` looks tidy until the first breaking change.

**Decision**: **All API routes live under `/api/v1`.** Additive JSON fields are compatible. Breaking changes require `/api/v2` or a documented overlap window with a minimum client version. There is no unversioned alias.

**Consequences**:
- (+) The first break does not require a coordinated app-store deploy on the same hour.
- (–) URLs are uglier. Survive.
- (–) People will copy routes to `/api/v1` and then also export them unversioned "for convenience." Do not.
- **Alternative rejected**: header-based versioning as the only scheme (`Accept: application/vnd.acme.v1+json`). Harder to see in logs and access rules for this size of app. Can be added later *in addition*, not instead.
- **Revisit trigger**: if there is never a second client version in years, you paid a four-character tax. Good.
