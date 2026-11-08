# Review intent consumption client

`src/server/service/review-intent-client.ts` consumes a saved review-side link intent over authenticated HTTPS. The caller supplies a trusted, exact HTTPS origin, a client-bound service credential with a validity window, and an explicit request ID. The returned policy and opaque identifiers come from the authenticated review response. Browser-supplied access, retention and callback fields are rejected.

The factory returns only `consume`; it copies credential values into a closure. A call makes one POST to `/service/v1/artifact-intents/consume`, validates the peer certificate with Node's trust store, and sends no browser cookies or origin. Redirects and automatic retries are disabled. An uncertain result requires the caller to retain the same request ID for an explicit retry.

Limits are four active attempts, a ten-second total deadline, five-second inactivity timeout, 16 KiB response headers and 64 KiB body. An AbortSignal cancels the attempt. Invalid credentials or payloads fail before I/O. Responses must match the configured client and requested intent, use the v1 closed schema and valid future timestamps, and omit cookies and content encoding. Duplicate JSON keys, including escaped spellings, invalid UTF-8 and unknown fields fail. Errors expose only a fixed category; remote bodies and credentials are not included.

This module is not wired into a route or configured in production. It does not authenticate an artifact owner, obtain consent, create a binding, exchange a completion code, or establish browser callback authority. Those are separate pending tasks. Credential distribution and upstream deployment also remain pending.

## Validation

Local tests use a disposable certificate and loopback HTTPS server. A child process loads that certificate through `NODE_EXTRA_CA_CERTS` at startup; an independent child with ordinary trust rejects it before sending credentials. No TLS bypass is used. Tests cover successful policy reads, copied configuration, request-ID replay, rejection before I/O, status classification without retry, malformed and oversized responses, duplicate keys, four-slot saturation and recovery, cancellation, credential expiry, inactivity and slow-stream total deadlines.

- `npx mocha test/review-intent-client.test.js`: 11 behavioral cases; one performance case is opt-in.
- `npm test`: 712 pass, 50 pending opt-in or environment-dependent cases.
- Full TypeScript check and targeted ESLint pass.
- Opt-in 100-request performance run: fresh loopback TLS connections, mean 12.36 ms, median 12 ms, p95 15 ms. These are local synthetic timings, not an external-service latency promise.

Run the measured test with `TEST_REVIEW_INTENT_PERF=1 TEST_REVIEW_INTENT_PERF_REPORT=/tmp/review-intent-perf.json npx mocha test/review-intent-client.test.js`.
