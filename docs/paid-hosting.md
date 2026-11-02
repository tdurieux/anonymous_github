# Paid hosting

Billing is opt-in. `BILLING_ENABLED=false` preserves self-hosted behavior. This implementation uses Stripe Checkout and the customer portal. No card details are stored in the application.

## Offers

Configure four EUR prices in Stripe. The amounts below are suggested launch prices, not hard-coded charges:

- Author monthly: €5/month, recurring monthly.
- Author annual: €49/year, recurring yearly.
- Author review pass: €15 once, one existing repository for 180 days from checkout creation.
- Conference review package: €199 once, up to 100 repositories during a fixed review window of at most 180 days.

Checkout uses the configured Stripe Price ID. The settings page displays its actual amount and cadence. Do not configure trials, metered prices, tiered prices, adjustable quantities, or subscription changes to unrelated products in the customer portal. New subscriptions need a paid invoice before access is granted. A failed renewal does not extend paid time. Cancellation at period end keeps access until that period ends; immediate cancellation ends new paid usage immediately.

Only repository hosting is covered. Gists and pull requests retain their existing behavior. Lab plans are not included.

Default capacities, all measured in source-file bytes:

- Free account: 5 repositories, 2 GiB total.
- Author subscription: 20 repositories, 10 GiB total, and never-expiring repositories while subscribed.
- Repository pass: 1 repository, 2 GiB.
- Conference: 100 repositories, 50 GiB total.

These are admission limits, not a measure or guarantee of physical disk consumption. Original files, anonymized caches, metadata and backups need additional capacity. Review production usage before enabling billing. File-size safeguards and request throttles still apply to paid users. Reviewers do not need accounts or payment.

## Configuration

Set these environment variables in your deployment's secret/configuration manager:

```text
BILLING_ENABLED=true
BILLING_ORIGIN=https://anonymous.example.org
STRIPE_SECRET_KEY=<Stripe secret key>
STRIPE_WEBHOOK_SECRET=<Stripe webhook signing secret>
STRIPE_AUTHOR_MONTHLY_PRICE=<monthly recurring EUR price ID>
STRIPE_AUTHOR_ANNUAL_PRICE=<annual recurring EUR price ID>
STRIPE_AUTHOR_PASS_PRICE=<one-time EUR price ID>
STRIPE_CONFERENCE_PRICE=<one-time EUR price ID>
BILLING_AUTOMATIC_TAX=false
```

Price IDs can be omitted to hide offers. Use test-mode keys and prices for staging. `BILLING_ORIGIN` must be the application's canonical HTTPS origin; HTTP is accepted only for localhost development. Redirects never use request-supplied hosts or return URLs. Enable and configure Stripe Tax before setting `BILLING_AUTOMATIC_TAX=true`; otherwise configure the appropriate tax treatment in Stripe before launch. Receipts, seller details and portal settings also need configuration in Stripe.

Capacity overrides are positive integers:

```text
FREE_AUTHOR_REPOSITORIES=5
FREE_AUTHOR_STORAGE=2147483648
PAID_AUTHOR_REPOSITORIES=20
PAID_AUTHOR_STORAGE=10737418240
PAID_PASS_STORAGE=2147483648
PAID_CONFERENCE_REPOSITORIES=100
PAID_CONFERENCE_STORAGE=53687091200
```

Changing these values changes the allowance of existing plans too. Keep existing Price IDs configured for as long as subscriptions using them remain active. Plan and conference review-window changes are intentionally locked in this first version.

Configure the Stripe customer portal for payment-method updates, invoice downloads and cancellation. Disable arbitrary subscription product switches. Configure a snapshot webhook at `/api/billing/webhook` using API version `2026-10-28.endive`, matching the installed Stripe SDK, for:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.subscription.paused`
- `customer.subscription.resumed`
- `invoice.paid`
- `invoice.payment_failed`
- `charge.refunded`
- `charge.dispute.created`

The webhook is mounted before JSON parsing so Stripe verifies the original request bytes. Failed durable receipt returns 500 for Stripe retries. Processing runs asynchronously from the stored event inbox. Duplicate deliveries do not extend passes or allocate duplicate grants. Subscription events retrieve current Stripe state and use a database revision check to prevent stale concurrent writes. Full refunds and disputes suspend the affected paid grant; partial refunds preserve access; reinstatement after a resolved dispute requires operator review.

## Lifecycle and migration

New paid conferences remain `pending_payment` until a verified checkout activates them. Collect billing addresses in Stripe. Historic conference plans remain editable and keep their existing status, but are no longer offered to new conferences. There is no automatic charge for historical estimated usage.

Existing repositories are not deleted or hidden on rollout or subscription expiry. New repositories are marked `billingManaged`; their file trees must fit an allowance before publication. A repository that fails this check remains available in its owner's dashboard for upgrading and retrying. Buy a pass by entering that repository's anonymized ID in Settings. Automatic refresh pauses for billing-managed repositories on the free allowance, including after paid access expires. Owners can still request a refresh within that allowance. Existing review links retain their configured expiration dates. This is not a guarantee of perpetual hosting.

Allowances are selected in order: paid conference, repository pass, author subscription, free account. MongoDB quota ledgers atomically reserve count and source-file bytes. They initially count existing repositories using stored size metadata. Reservations never shrink during refresh, so a concurrent or failed build cannot release capacity still in use. Confirmed removed repositories release reservations on the next admission. Expired repositories and orphan reservations remain reserved until operator reconciliation. This deliberately favors conservative capacity accounting over overselling. The account usage display uses reserved capacity once a ledger exists. A moved repository can retain conservative reservations in its previous scope until removal.

For billing-managed repositories, on-demand recovery and ZIP downloads from truncated trees are rejected with `repository_tree_incomplete`. This prevents serving unaccounted files beyond the indexed tree. A complete source tree is required; refresh after reducing repository size or excluded content upstream.

Billing records are in separate `billingaccounts`, `billinggrants`, `billingquotas` and `billinglocks` collections. They are not serialized on anonymous repository pages. Account deletion cancels recurring subscriptions and expires any known open checkout before deleting content. Minimal provider IDs and financial records remain for reconciliation. Do not disable billing configuration while active subscriptions still need webhook processing or cancellation.

## Verification and operation

Run focused policy and MongoDB tests against a disposable database:

```sh
npx mocha test/billing.test.js
BILLING_TEST_MONGODB_URI=mongodb://127.0.0.1:27017/billing_test_paid npx mocha test/billing-integration.test.js
npm run test:ui
npm run build
```

The integration suite deletes data in its test collections and requires a database name beginning with `billing_test_`. It covers concurrent admission, duplicate fulfillment, customer binding, refunds, subscription cancellation, failed renewal, stale event writes and conference activation. It uses a fake Stripe client and real MongoDB; it does not charge cards.

Before production rollout, run a Stripe test-mode purchase for each configured price, renewal with a test clock, failed renewal, cancellation, refund and webhook retry. Confirm currency, tax behavior, invoice details, capacities and backups. Inspect webhook delivery failures in Stripe. The in-app Refresh payment status action reconciles the latest checkout and known subscriptions; it is not a substitute for webhooks. Failed checkout requests preserve their idempotency key so retrying the same plan recovers the session.

Back up billing collections with the rest of MongoDB. Watch source bytes, physical storage, bandwidth and request rates separately. Stripe fees, taxes and refunds reduce gross revenue.


### Coauthors and the free allowance

Only repositories owned by an account consume its allowance. Joining another author's repository does not consume a slot, and coauthors do not need subscriptions. A coauthor's own subscription does not increase the owner's allowance. Edits and refreshes use the owner's allowance, or the repository's paid conference/pass allowance. If that allowance is full, a collaborator's attempt to refresh or enlarge the repository can also be blocked. Existing review links remain available.

The free defaults are 5 repositories and 2 GiB, revised from the initial 10-repository proposal after the November 2, 2026 production audit. The audit counted ready, unexpired repositories; stored sizes were estimates rather than a fresh recount. Paid author subscriptions retain 20 repositories, 10 GiB and automatic refresh.

### Never-expiring repositories

Monthly and annual author subscribers can choose Never expire. This requires the repository owner's subscription even when a conference pays its storage allowance. A coauthor subscription or a one-time review pass does not unlock it.

Newly selected Never expire repositories store a billing deadline 90 days after the paid-through date. The five-minute maintenance job extends that deadline on renewal and changes overdue repositories to ordinary removal expiration. Cancellation does not shorten the paid-through period. Revocation does not extend a previously recorded deadline. Renewal during the grace period preserves the repository; after expiration, the author must renew and explicitly reactivate it.

Legacy never-expiring repositories have no billing deadline and remain unchanged. Disabling billing disables this reconciliation. Free users can choose a dated expiration within one year and extend it manually. Never expire does not exempt a repository from quotas, abuse controls, or service availability.

Real sandbox validation and repeatable API test instructions are recorded in [Stripe sandbox validation](stripe-sandbox-validation.md).

## Billing recovery and operation

`BILLING_CHECKOUT_ENABLED=false` stops new purchases while webhooks, reconciliation,
the customer portal, and cancellation remain available. Keep `BILLING_ENABLED=true`
and the existing Stripe price IDs configured while subscriptions exist.

Verified webhook routing references are durably inserted into `billingevents` before
HTTP acknowledgement. A ten-second worker claims events with a five-minute lease,
retries failures with exponential backoff, and marks an event failed after 12 failed
processing attempts. Repeated delivery cannot create another inbox record. A worker
that dies after fulfillment can replay the operation without allocating another grant.
Completed envelopes are removed after 90 days; failed events remain for investigation.
The inbox deliberately omits customer names, addresses, card data, and full payloads.
Do not register Connect events on this application's platform webhook.

Every five minutes, a separate job selects up to ten due billing accounts. Each account
is normally reconciled daily; failures retry after 15 minutes. Reconciliation paginates
subscriptions, checkout sessions, and charges, including historical purchases absent
from MongoDB. It also reconstructs confirmed paid periods from invoice lines when the
latest invoice failed. This full customer-history scan favors recovery at the current
scale. Measure Stripe request volume before shortening the daily interval.

Before the 90-day deadline triggers expiration, maintenance performs a fresh owner
reconciliation. Provider or database failures defer that expiration and log an error.
Legacy never-expiring repositories remain excluded. The recorded grace period does not
restart during retries. Ordinary repository requests continue using local entitlements.

Checkout retries retain their key and exact creation parameters. Sessions have an
explicit expiry. After 23 hours, unresolved requests are searched by purchase-attempt
metadata before any retry. After 24 hours, an unmatched attempt can be replaced only if
its immutable request contains an expired session deadline. Older records without that
proof require operator review. Uncertain customer creation also stops after 23 hours;
customer discovery can recover the mapping without creating another customer.

Partial refunds preserve access. Full refunds and disputes suspend the affected grant.
`billingrevocations` records the payment decision even if its grant does not exist yet.
A dispute after a reviewed refund requires review again. Reinstatement is an explicit operator
decision; it does not create paid time or restart a subscription. Do not grant a refund
merely to cancel renewal.

The existing application error log receives billing failures and five-minute health
warnings for failed events, old pending events, unresolved checkout attempts, and failed
reconciliation. These warnings also appear in the existing admin error viewer. External
email or paging delivery still requires deployment monitoring configuration.

### Operator commands

Run with the application's normal server configuration and database access. Inspection
is read-only; mutation commands require `BILLING_OPERATOR` and an audit reason. They
write an intent record to `billingaudits` before performing work. Inspect resulting
state after a command failure; an audit intent alone does not prove completion.

```sh
node -r ts-node/register src/scripts/billing-operations.ts health
node -r ts-node/register src/scripts/billing-operations.ts inspect OWNER_ID
BILLING_OPERATOR=operator-name node -r ts-node/register src/scripts/billing-operations.ts reconcile OWNER_ID 'Investigating missing paid access'
BILLING_OPERATOR=operator-name node -r ts-node/register src/scripts/billing-operations.ts replay test:platform:evt_ID 'Retry after correcting configuration'
BILLING_OPERATOR=operator-name node -r ts-node/register src/scripts/billing-operations.ts drain all 'Process queued recovery work'
BILLING_OPERATOR=operator-name node -r ts-node/register src/scripts/billing-operations.ts discover all 'Recover customer mappings after restore'
BILLING_OPERATOR=operator-name node -r ts-node/register src/scripts/billing-operations.ts reinstate pi_ID 'Dispute resolved; access reinstatement approved'
```

Discovery binds only customers tagged for this application to existing users. Conflicting
customer mappings require investigation. `reinstate` reviews a payment reversal and
keeps a subscription suspended if other unreviewed payment reversals remain. Reconcile
the owner afterward. Restrict shell access to authorized operators; these are not public
HTTP endpoints.

### Restore and launch checks

Back up `billingaccounts`, `billinggrants`, `billingquotas`, `billinglocks`, `billingevents`,
`billingrevocations`, `billingprices`, and `billingaudits` with repository data. Test a restore into an
isolated environment with sandbox credentials. Keep destructive repository maintenance
stopped during restore, discover customer mappings, reconcile restored owners, drain
queued events, and inspect health before re-enabling normal scheduling. Never connect a
restored test copy to live Stripe credentials.

Before launch, configure seller details, live prices, tax treatment, invoice information,
portal restrictions, production email delivery, backup retention, and external alerts.
These are deployment/business settings, not changes made by this implementation. Grace
period email reminders are not currently sent by the app.

The recovery suite uses a disposable MongoDB database and simulated Stripe failures:

```sh
BILLING_TEST_MONGODB_URI=mongodb://127.0.0.1:27029/billing_test_recovery npx mocha test/billing.test.js test/billing-integration.test.js test/billing-reliability.test.js
```

## Payment within the repository workflow

Repository hosting choices now appear in the anonymization form when capacity or a
new Never expire selection requires them. Free dated submissions and coauthor work
keep their existing flow. Conference admission and final capacity are still checked
server-side; an account usage display cannot authorize or permanently block admission.
Existing repository owners can also buy a repository-scoped pass from that form.

Before leaving for hosted Stripe Checkout, the app flushes pending field edits and
saves a private task draft. `/api/billing/draft` requires authentication and the billing
CSRF token. Drafts retain only the form fields needed to resume, are limited to 64 KiB,
and expire after seven days. Retrieval checks the owner and expiry even before MongoDB's
TTL sweep runs. Account deletion also removes these drafts.

Checkout returns to the draft's validated anonymization route, or the conference
being purchased, rather than always returning to Settings. No request-supplied external
return URL is accepted. An open or uncertain checkout attempt cannot be reused for a
different task. Returning restores the draft, refreshes billing and capacity, and leaves
submission to the author. The return token is consumed after restoration so later
navigation cannot overwrite newer edits. Confirmation does not create a repository.

The payment form remains Stripe-hosted. Embedded Checkout is not required for this
workflow and is not enabled by this change. Settings remain available for invoices
and subscription management.

Validation: 40 billing tests with disposable MongoDB and 160 frontend tests passed.
Additional HTTP checks cover draft CSRF, authentication, ownership and no-store headers.
The built UI was checked at desktop and mobile widths using simulated payment responses;
redaction edits survived the checkout return. These workflow changes were not charged
through a fresh real Stripe sandbox payment or deployed to production.

### Current application layout

The anonymization page keeps the main configuration sections visible beside a live
README preview. Source controls retain the existing GitHub connection selector,
manage-access action and branch refresh button. Conference code is a visible optional
field. Hosting choices appear within configuration, with saved drafts preserved through
Stripe Checkout and return.

Settings separates anonymization defaults, hosting and billing, and account actions.
The header Upgrade action sits beside the user menu and opens the plan comparison.
Active subscribers see subscription management instead of another purchase offer.
The donation entry remains available.

Local browser checks used simulated payment responses for the final layout. The real
Stripe sandbox checks and their limitations are documented in
[stripe-sandbox-validation.md](stripe-sandbox-validation.md).

### Resolved source-file storage

Git LFS pointer sizes do not represent cached object sizes. Source-cache fills reserve
bytes beyond the tree size before writing them, in blocks of at most 1 MiB. The ledger
keeps per-path high-water marks so retries and concurrent fills do not charge twice.
Reservations remain conservative across generations and failed fills and require
operator reconciliation to release unused capacity. This also covers public raw
downloads and expanded submodule content. Existing cached content is not retroactively
measured by this write-time guard.

Accepted one-time prices are stored in `billingprices` when checkout starts and when
existing purchases are fulfilled. Hiding an offer by removing its configured price
does not remove this mapping or invalidate paid grants. Include the mapping in backups
so reconciliation can reconstruct grants for retired offers and process their refunds.
