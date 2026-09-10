# GitHub App migration with OAuth coexistence

Status: proposed implementation plan. No authentication behavior changes in this document.

## Outcome and scope

Add a GitHub App that reads selected private repositories, while keeping the existing OAuth App operational throughout the transition. Users can connect both to the same Anonymous GitHub account and migrate individual anonymized resources without changing their URLs, ownership, settings, or cached content. Make the GitHub App the preferred connection after validation; removing OAuth is a separate future decision.

GitHub Apps support granular read permissions and installation repository selection. The existing OAuth `repo` scope cannot provide the equivalent read-only private repository grant. A GitHub App still uses an OAuth web flow for user authorization; the migration changes the application and credential model, not the underlying sign-in protocol. See [GitHub's comparison](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps).

Read-only describes access to GitHub. Anonymizing a private repository still publishes the configured anonymized content through this service; preserve that explanation in the creation flow.

## Current implementation and affected areas

| Area | Current behavior | Required change |
| --- | --- | --- |
| `src/server/routes/connection.ts` | `/github/login` requests `repo`; `/github/auth` saves one GitHub token; sessions contain the local user ID | Separate provider callbacks and credential writes, shared account identity |
| `src/core/credentials.ts`, `model/credentials/credentials.model.ts`, `credential-crypto.ts` | Encrypted credentials indexed by owner and provider; provider enum only accepts `github` | Preserve existing OAuth envelopes and add distinct App user credentials |
| `src/core/GitHubUtils.ts` | OAuth reset after seven days, `/user` token check, global `GITHUB_TOKEN` fallback; throttling keyed by token suffix | Provider-specific validation/renewal, explicit access resolution, stable rate-limit identities |
| `src/core/User.ts` | Repository discovery through `/user/repos`, cached on the user | Discover App installations and user-accessible repositories; merge provider availability |
| `src/server/routes/repository-private.ts`, `src/core/Repository.ts` | Creation, claim, preview, branches, updates and diagnostics pass owner tokens | Resolve the selected connection consistently and persist resource bindings |
| `src/core/source/GitHubRepository.ts`, `GitHubBase.ts`, `GitHubDownload.ts`, `GitHubStream.ts` | Metadata, commits, README, Pages, trees, raw content and archives use token-based clients | Use renewable access contexts across requests and stream retries |
| `src/core/PullRequest.ts`, `src/core/Gist.ts` and their routes/models | Separate owner-token lookup and fallback paths | Explicit provider handling; retain OAuth compatibility for both features |
| `src/queue`, `src/streamer`, scheduler callers | Downloads and updates run without an interactive session | Resolve bindings at execution time, renew tokens, stop on revoked access |
| `src/server/routes/user.ts` | Account removal revokes the OAuth grant | Revoke each user grant using its own client; remove local bindings |
| `src/config.ts`, Compose files, `README.md`, frontend partials/scripts/locales | OAuth-only configuration and connection UI | Dual configuration, connection management, deployment instructions |

The README currently calls the registration at `/settings/applications/new` a GitHub App; implementation documentation should identify it as an OAuth App and provide a separate GitHub App registration procedure.

## Proposed access model

### Separate identity, user authorization, and installation access

Use the GitHub numeric user ID in `externalIDs.github` to resolve the same local account for either login. Preserve local IDs, admin flags, quotas, coauthors and API tokens. App linking must reject a different GitHub identity and disabled accounts. Do not automatically link App accounts by username; handle legacy accounts without a verified GitHub ID through explicit recovery.

Use an App user access token for identity, installation discovery, and verification that the connecting user can access the selected repository. Use an installation access token for bound repository downloads and scheduled updates. Installation access is independent of the individual user, so an installation ID supplied by a browser is never sufficient authorization. GitHub documents the user/app permission intersection in [user token generation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).

For a new binding or a manual source change, verify the local owner and the GitHub user's current access through the App user token. For background synchronization, revalidate that owner's repository access at the start of each job/update cycle, with a short bounded cache for streaming requests. Refresh the user grant server-side; if it expires or is revoked, pause new source access until reauthorization. This deliberately prevents an organization installation from preserving a departed user's ability to synchronize private content. Coauthor permission to manage an anonymized resource does not grant permission to attach another installation or replace its owner's connection.

### Permissions

Register a public-installable GitHub App for personal and organization accounts. Recommend “Only select repositories” during installation.

| Permission | Level | Purpose |
| --- | --- | --- |
| Repository metadata | Read | Repository identity and metadata |
| Contents | Read | Commits, branches, trees, README, files and archives |
| Pull requests | Read | Preserve PR metadata and diff support |
| Pages | Read | Preserve the current Pages source lookup |

Request no repository write permissions. Verify PR issue-comment reads with the Pull requests permission before finalizing the manifest; add Issues read only if an actual required endpoint demands it. Private email access is unnecessary for the initial migration; preserve available profile data and tolerate absent email addresses.

Pages lookup specifically requires Pages read; lack of Pages access must not make ordinary repository import fail. See [Pages endpoint permissions](https://docs.github.com/en/rest/pages/pages#get-a-github-pages-site).

Gists are a separate capability. Keep existing gist resources on OAuth in the first release, and show that requirement for App-only users. Do not send installation tokens to gist endpoints. Evaluate App user-token support for gist content, comments and raw downloads as a later compatibility step using the [gist API reference](https://docs.github.com/en/rest/gists/gists). OAuth retirement depends on resolving this gap.

### Persistence and credential lifecycle

- Keep `provider: "github"` meaning legacy OAuth. Add `github-app-user` with encrypted access and refresh tokens, expiry timestamps, grant status and a concurrency version. Login through either provider must not overwrite the other.
- Preserve the existing ciphertext/AAD contract for OAuth. Extend encryption with a distinct field/purpose binding for refresh tokens so access and refresh ciphertexts cannot be swapped. Extend credential verification, migration tooling, hidden projections and redaction accordingly.
- Add an installations collection keyed by App ID and installation ID, recording GitHub account ID/type, repository selection, permissions, suspension/deletion status and reconciliation time. Store user-to-installation associations separately; organization installations can serve multiple local users.
- Add an explicit access binding to anonymized repositories and PRs: `kind` (`oauth` or `github-app`), local credential owner, stable GitHub repository ID, and installation ID for App resources. A missing binding means legacy OAuth during compatibility rollout. Keep bindings out of public anonymized responses.
- Treat shared repository metadata as metadata, never as proof of access. Partition discovery/authorization caches by user, provider and installation; invalidate them on connection changes.
- Store no installation tokens in MongoDB resource records, sessions, job payloads, public responses or URLs. Cache them briefly in process, keyed by App/installation/repository/permissions, with expiry skew and shared in-flight minting. Give workers and streamers secure access to the App key and resolver.

Mint installation tokens restricted to the bound repository and required read permissions. GitHub installation tokens expire after one hour; renew before expiry and retry an idempotent read once after an authentication failure. Long downloads must reacquire archive URLs/tokens when restarting rather than persist signed URLs. See [installation token generation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

Enable expiring App user tokens. Store returned expiry values, rotate access/refresh pairs atomically, and serialize refresh across processes to avoid consuming the same refresh token twice. GitHub currently documents eight-hour access tokens and six-month refresh tokens. Keep this separate from the existing OAuth reset endpoint. See [refreshing user tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).

### Provider selection and failure behavior

Introduce a central access service with operations for user identity, repository discovery, repository access and resource access. Return an authenticated client/access context with provider, repository scope and expiry, rather than letting callers guess a token type. Installation tokens cannot be validated with the current `/user` check.

| Situation | Behavior |
| --- | --- |
| Existing resource without binding | Resolve legacy OAuth |
| New resource with verified App access | Default to App; record binding |
| New resource available through both | Prefer App, allow explicit OAuth selection |
| Resource explicitly bound to OAuth | Continue OAuth until the owner migrates it |
| App unavailable, suspended, revoked or repository deselected | Pause source access; show reconnect/configure action |
| Organization approval pending | Keep the existing OAuth resource working; leave migration pending |
| No private repository grant | Deny source access; do not use another user's or global token |

Never silently fall back from an App binding to OAuth or `GITHUB_TOKEN`. This prevents a removed App grant from being bypassed by broader retained credentials. Restrict any public fallback path to independently verified public resources. Preserve CLI user-supplied token support as a distinct context.

Keep rate-limit behavior across token renewal by using provider-aware quota identities (installation for installation access, GitHub user for user access), while retaining GitHub response-driven backoff. Do not log token suffixes as identifiers in new paths. Distinguish expired credentials, revoked access, missing repository, missing permission, rate limit and transient upstream failures.

## User transition

1. Add “Connect GitHub App — read-only repository access” alongside “Connect with OAuth — legacy repository access.” Retain the existing OAuth callback URL; introduce dedicated App authorize/callback/setup routes.
2. Bind authorization and installation setup to short-lived, single-use session state with a fixed local return path. Validate installation ownership/access through GitHub APIs after callback. Support installations initiated on GitHub, canceled flows and organization approval delays without trusting setup query parameters.
3. Discover installations using the App user token and paginate `/user/installations/{installation_id}/repositories`. Merge with OAuth discovery by GitHub repository ID, showing connection availability without exposing installation-wide repositories the user cannot access. See [installation endpoints](https://docs.github.com/en/rest/apps/installations).
4. Provide a migration preview listing eligible resources and blocked resources, with reasons such as repository not selected, approval pending, missing permission or gist compatibility.
5. On explicit migration, verify App access and read the resource's configured commit (or PR) before conditionally updating its binding. Preserve all anonymization settings, URLs and caches. A partial batch reports per-resource results and can be rerun; jobs read the latest binding and reject stale results if the binding changes while running.
6. Display each resource's connection and reconnect action. Connecting the App alone does not migrate resources or revoke OAuth.
7. Offer OAuth disconnect after listing remaining dependencies, including gists. A new sign-in does not reduce an existing OAuth grant's scope. Complete removal of the broad grant requires explicit revocation; warn about affected resources in that concrete disconnect flow.

## Revocation, webhooks and retained content

Add a webhook route that verifies `X-Hub-Signature-256` against the raw body before JSON processing. Deduplicate deliveries, queue durable processing, and reconcile authoritative state for delayed/out-of-order events. Handle installation creation/deletion/suspension/unsuspension, repository selection changes and user authorization revocation. See [GitHub webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads).

Invalidate tokens, discovery caches and access checks when a grant changes; block new upstream reads for affected resources. Reconcile periodically and on access failures so missed webhooks do not indefinitely preserve access. Repositories transferred to a different installation require revalidation and explicit rebinding; numeric repository IDs remain the identity across renames.

Proposed retention policy: revocation pauses source synchronization but preserves already published anonymized snapshots under existing expiration/removal rules. Show that policy when connecting/disconnecting. Account/resource removal continues deleting content according to current behavior. On account deletion, revoke both user grants and remove that user's bindings, but do not uninstall a shared organization installation or erase other users' connections.

## Implementation sequence and release gates

1. **Access abstraction and compatibility.** Inventory all GitHub calls, add provider-aware contexts and explicit fallback rules, adapt OAuth callers, and add optional binding fields. Gate: existing OAuth, CLI, API-token login, repository, gist and PR paths pass without requiring App configuration.
2. **App infrastructure.** Add installation/grant models, encryption extensions, token issuance/refresh and dual configuration. Proposed settings: `GITHUB_APP_ENABLED`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY_FILE`, `GITHUB_APP_CALLBACK`, `GITHUB_APP_WEBHOOK_SECRET`; retain `CLIENT_ID`, `CLIENT_SECRET`, `AUTH_CALLBACK` for OAuth. Validate only enabled providers. Gate: test App accesses a selected private repository with read permissions and cannot access an unselected one.
3. **Connection and lifecycle.** Add App login/link/setup, verified discovery, webhooks, reconciliation, account deletion and frontend connection states. Gate: both logins resolve the same account; multi-user organization installations cannot leak access; cancellation and pending approval preserve OAuth behavior.
4. **Repository and PR integration.** Route creation, previews, branch/commit/Pages reads, updates, claims, admin diagnostics, streams, archives and queued work through the resolver. Gate: App-only private repository and PR workflows succeed, including renewal during delayed jobs; gist compatibility is clearly represented.
5. **Migration UX and tooling.** Add preview, per-resource switching, OAuth disconnect dependency checks, provider labels and retryable batch results. Any administrative migration tool defaults to dry-run and requires verified owner authorization before switching bindings. Gate: mixed-provider resources for one account operate independently without changing public URLs.
6. **Staged rollout.** Deploy schema/read compatibility to all API instances, workers and streamers before enabling App writes. Enable for maintainers, then an opt-in cohort, then make App the new-connection default. Keep separate controls for new App connections/migrations and serving existing App bindings. Publish setup, key rotation and recovery instructions in README/docs and Compose configuration.

Do not relabel or re-encrypt existing `github` credentials in bulk. An optional idempotent backfill can mark legacy bindings as OAuth after every deployed reader supports them. Extend the existing credential migration verifier before App credentials are written, so it does not misclassify their provider or envelope format.

Monitor success/error rates by provider, token issuance/refresh failures, permission failures, paused resources, webhook lag and migration outcomes. Never include private names, installation metadata or credentials in public error responses. Advance rollout only after the cohort exercises token expiration, queued work and revocation without regressions.

Rollback disables new App connections and migrations while keeping the dual-provider resolver running for already migrated resources. Roll back only to an App-aware release once bindings exist. Switching a resource back to OAuth requires explicit owner selection and a verified remaining OAuth grant; restoring a global fallback is not a rollback mechanism.

## Validation checklist

- Both login providers, account linking, disabled/deleted accounts, mismatched identity, callback state replay, unchanged ID-only sessions and API-token login.
- OAuth-only, App-only and mixed accounts; personal/organization installs; selected/all repositories; pagination; users sharing an installation with different repository access.
- Private metadata, branches, README, commit/tree/raw reads, archives, streaming, Pages and PR comments/diff; preserve OAuth gist and CLI behavior.
- App user refresh rotation under concurrency; installation token expiry during queued work and retries; transient GitHub errors and shared rate-limit backoff.
- Forged installation/repository IDs, cached private metadata, coauthor/admin paths and all global-token fallback branches.
- Suspension, deselection, uninstall, user grant revocation, lost organization membership, repository rename/transfer, webhook duplicates/out-of-order delivery and missed-event reconciliation.
- Migration cancellation, partial success, reruns and in-flight jobs; stable anonymous URLs and options; OAuth disconnect dependency detection; account deletion with shared installations.
- MongoDB encryption/projection/migration integration tests, token redaction and no secrets in sessions, queues, responses or stored archive URLs.
- Run `npm test`, `npm run lint`, `npm run build`, relevant UI checks, and existing MongoDB integration tests with a disposable `TEST_MONGODB_URI`. Perform sandbox GitHub App acceptance checks against disposable repositories before rollout; inspect granted permissions rather than issuing writes against real repositories.

Completion means existing OAuth users continue operating, App users can anonymize selected private repositories using only read permissions, users can migrate resource by resource, and revocation/expiry never bypasses the chosen connection.
