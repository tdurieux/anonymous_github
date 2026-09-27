# Artifact consent page

`/review-link` serves a separate page without the ordinary site's third-party widget or profile header. Its content security policy allows only first-party scripts and connections. The page rejects URL queries and noncanonical aliases, disables caching and referrers, and accepts only filename-shaped manifest entries.

The handoff fragment contains exactly `clientId`, `intentId` and `token`. The application removes it from the current history entry before starting application requests or the router. Intent credentials and signed preview tickets stay in a controller closure. They are not rendered or written to browser storage. Reloading loses the handoff; users must reopen a new link from their submission. Signed-out users sign in before reopening the link.

Owners enter the anonymous repository ID and request a preview. The backend supplies the repository name, access policy, retention deadline and expiry. Confirmation requires two separate unchecked approvals. A failed confirmation keeps the same signed ticket and random request ID for an explicit retry. Repository changes are disabled while that confirmation is uncertain. Account changes and page disposal cancel requests and discard late results. Success says that consent is recorded and that artifact linking remains incomplete.

The page does not mount the consent API or advertise available integration capabilities. Startup configuration, final binding exchange, provider activation and a review-side link launcher remain unfinished. The consent HTTP router still needs to be mounted after authentication and before body parsing.

Validation uses the compiled frontend bundles. Targeted tests cover fragment removal, storage, approval flags, replay identity, departure during CSRF, account changes during preview, invalid handoffs and policies, endpoint unavailability, expiry, sign-in and mismatched receipts. Server tests check canonical paths, headers and unsafe manifests. Chromium checks at 1280 and 320 pixels exercise the full synthetic form flow with CSP enabled and check overflow, external requests, script errors and WCAG A/AA rules. No live database or provider request is involved.

Run `npm run build:ui`, then `npx mocha test/review-consent-page.test.js test/review-consent-ui.test.js`. Set `TEST_REVIEW_PAGE_PERF_REPORT` to a private output path to measure 100 isolated HTML responses over loopback HTTP. This benchmark excludes browser rendering, database operations and provider latency.
