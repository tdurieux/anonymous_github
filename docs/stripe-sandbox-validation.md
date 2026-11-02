# Stripe sandbox validation

Validated November 2, 2026 using a real Stripe sandbox, disposable local MongoDB, Stripe-hosted Checkout and the customer portal. The Stripe CLI forwarded real signed events to the application's raw webhook route.

## Results

The repeatable API suite passed 16 scenarios:

- Checkout creation, reuse, unpaid-access denial and session expiry for all four plans.
- Successful monthly and annual subscription payments and author entitlements.
- Duplicate subscription prevention for both recurring plans.
- Scheduled cancellation preserves the paid period.
- Immediate cancellation removes paid capacity; never-expiring repositories retain the recorded grace deadline and enter expiration after it.
- A declined initial payment grants no subscription access.
- Subscription refunds revoke access. Repeated signed events are idempotent; altered payloads fail signature verification; later subscription sync does not undo revocation.
- A Stripe test clock advances a monthly subscription through successful renewal, failed renewal and recovery. Only paid invoices advance paid-through time.
- Account deletion cancels its subscription.

Interactive checks also passed:

- A repository pass purchased through hosted Checkout activated through a real webhook.
- A conference purchase changed pending payment to ready through a real webhook.
- Monthly Checkout displayed an insufficient-funds decline without granting access, then activated after retry with a successful test card.
- Annual Checkout granted no access after failed 3-D Secure authentication and activated after successful authentication.
- Refunding the repository pass revoked its grant through a real webhook.
- The customer portal showed billing details and invoices and scheduled cancellation at the paid-period boundary.
- A disputed sandbox subscription payment triggered a real dispute webhook, revoked access and remained revoked after resync.

The local billing regression suite passed 23 tests, including quota concurrency, coauthor accounting, authorization/CSRF, grace periods and signature checks. TypeScript and targeted lint checks passed.

## Fixes found by real Stripe testing

1. Open subscription Checkout sessions do not yet have a subscription ID. Fulfillment now ignores unfinished sessions instead of reporting an invalid purchase.
2. The customer portal can schedule cancellation using cancel_at while cancel_at_period_end remains false. The app now recognizes either representation when displaying cancelled renewal.

## Repeating the API checks

Create a private JSON file outside the repository with a secret field containing a sandbox secret key. The script rejects live keys and verifies Stripe reports sandbox mode before creating fixtures.

Run against a disposable MongoDB database whose name begins with billing_test_:

```sh
STRIPE_SANDBOX_CREDENTIALS=/absolute/path/to/private-credentials.json \
BILLING_TEST_MONGODB_URI=mongodb://127.0.0.1:27029/billing_test_stripe \
node scripts/test-stripe-sandbox.js
```

The script creates tagged test customers, one product and four test prices. It deletes its customers and test clocks and deactivates its prices/product afterward. Stripe retains transaction history. It does not change existing prices or production settings. Test price amounts are fixtures, not a published price commitment.

## Limits of this validation

- This covers the implemented card-payment flows, not every Stripe payment method or account configuration.
- Automatic tax was disabled. Tax registration, live tax calculation, live settlement, seller details and production email delivery were not tested.
- The test clock changes Stripe time, not the application's wall clock. Failed-renewal tests verify paid-through does not advance; local tests exercise access expiry and the 90-day boundary.
- Hosted Checkout, portal and live CLI-forwarded webhook checks were interactive. The repeatable API suite uses real Stripe responses with locally generated webhook signatures for its HTTP replay test.
- No production deployment or live payment occurred. Sandbox customers and active subscriptions from this run were cleaned up; products and prices were archived.

## Reliability follow-up

The repeatable 16-scenario sandbox suite passed again after introducing durable webhook
receipt, asynchronous processing, checkout expiry, and provider reconciliation. The
HTTP refund replay check now explicitly drains the inbox before asserting entitlements.
No live payments or production deployment were performed.

The local billing suites now include crash recovery, concurrent event receipt, retry
exhaustion, privacy of stored envelopes, reconstruction after missing local grants,
missed renewal recovery, refund-before-fulfillment ordering, partial refunds, uncertain
checkout recovery, purchase shutdown, and expiration deferral during provider outages.
These are deterministic failure simulations against disposable MongoDB, not a claim
that production backup infrastructure or external alert delivery has been tested.

Final follow-up checks passed: 38 local billing tests, 155 frontend regression/UI tests,
TypeScript compilation, the production build, and targeted ESLint checks. The 16-scenario
real Stripe sandbox suite also passed with historical invoice recovery enabled.

## Full application UI check — November 2, 2026

Used the built application in the collaborative browser, production billing routes,
an isolated MongoDB database and real Stripe sandbox Checkout and customer portal.
GitHub login was replaced with a test-only session fixture outside the repository.

| UI flow | Observed result |
| --- | --- |
| Free account | Five repositories and 2 GiB displayed. |
| Monthly subscription | Insufficient-funds decline granted no access; successful retry activated 20 repositories and 10 GiB. |
| Duplicate subscription | App rejected another subscription and displayed the explanation. |
| Customer portal | Billing details and invoices loaded; cancellation stopped renewal while preserving paid access. |
| Annual subscription | Failed 3-D Secure granted no access; successful authentication activated annual access. |
| Delayed webhook processing | With the worker paused, the checkout return recovered annual access from Stripe. Both billing and quota panels reflected the upgrade. Queued events completed after resuming the worker. |
| Abandoned repository pass | Returning without payment granted no access. Reopening reused the same checkout session. |
| Paid repository pass | Successful checkout created a repository-scoped grant. |
| Refunded pass | A sandbox API refund generated real webhooks; refreshing in the UI showed revoked access. Refund initiation was an operator action, not an app UI feature. |
| Conference package | Checkout from the pending conference activated the package; the conference page showed Ready. |

Two UI issues were fixed during this run: checkout reconciliation now refreshes the
quota panel, and revoked purchases no longer display a future paid-access date.
The quota issue has a regression test. Four targeted UI tests and the UI build passed;
both fixes were also checked in the real browser. No failed or pending received
webhook events remained at the final pre-cleanup inspection.

This run does not cover GitHub OAuth, repository ingestion, production deployment,
tax, email delivery, or the passage of the 90-day grace period. Those should not be
inferred from the payment UI results. Temporary customers/subscriptions were deleted,
prices and product archived, and the disposable local services removed after testing.
