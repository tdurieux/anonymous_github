# Browser transport for review consent

`createReviewConsentRouter` exposes the consent backend through three routes when explicitly mounted at `/api/review-consent`: `GET /csrf`, `POST /preview` and `POST /confirm`. Application startup does not mount this router. Browser UI, private configuration, startup ordering and activation remain unfinished.

The factory requires a canonical HTTPS origin, the consent backend and a dedicated private 32-byte CSRF key shared by serving processes. Mount it after Passport/session authentication and before any JSON parser. The current startup ordering must change before integration; mounting after a parser fails closed. Transport must be HTTPS directly or through the application's explicitly trusted proxy configuration.

Identity comes from Passport's authenticated account and a fresh lookup in the session store. Neither request JSON nor a bearer credential can supply it. POSTs require the exact configured Origin and a constant-time-checked CSRF token bound to the account and session. CSRF tokens are derived with a protocol-specific HMAC; issuing one never saves a session. A late CSRF response therefore cannot recreate a session destroyed by a concurrent logout. Authority is reloaded after backend work before returning a preview or confirmation response.

Requests use exact paths without queries, strict methods, closed JSON fields and literal access/retention acceptance. Cross-origin or cross-site context, bearer authentication, duplicate security headers, content encoding and unexpected content types are rejected. The CSRF GET accepts no body. JSON is limited to 12 KiB; tickets to 8 KiB. A 15-second total deadline closes incomplete requests, and browser disconnects cancel pending preview consumption. Authenticated requests are limited to 60 per account per minute with at most 1,024 live counters.

Responses disable caching and referrers. Confirmations include only the request ID, accepted policy and confirmation time. Internal account/repository identifiers and provider/database errors are omitted. A confirmation already accepted by the backend can commit despite a lost response; the UI must preserve the same ticket and request ID for explicit recovery. This transport does not create artifact bindings or bypass final review-side authority checks.

## Validation

The tests use real Express and express-session middleware with a disposable in-memory session store, a synthetic backend and loopback HTTP representing the trusted TLS proxy boundary. They do not measure real MongoDB or provider latency. TLS verification of the service client and MongoDB authority transactions are tested separately.

Coverage includes session-derived identity, CSRF replay across sessions, cross-origin/bearer rejection, bounded closed payloads, exact routes, session revocation during preview, no session resurrection during a CSRF/logout race, response redaction, fixed errors, rate limits, unauthorized incomplete uploads, browser cancellation and the authenticated 15-second slow-upload deadline. The optional benchmark performs 50 fresh loopback HTTP preview requests. The CI database job runs these HTTP tests alongside the consent transaction tests and retains both performance reports.

The final local targeted run passes 12 cases in 16 seconds. Transport-only timings are mean 4.94 ms, median 4.51 ms and p95 7.26 ms. TypeScript and targeted lint pass.

The final local broader suite passes 723 cases with 63 opt-in/environment-dependent cases pending. The separate CI replica-set job exercises the otherwise skipped consent database tests as well as this transport suite.
