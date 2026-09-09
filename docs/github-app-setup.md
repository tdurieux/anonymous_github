# GitHub App setup and OAuth transition

The GitHub App is opt-in for operators. Existing OAuth configuration and resources
continue working with `GITHUB_APP_ENABLED=false` (the default). This feature uses
existing repository streaming/proxy paths and does not introduce ZIP uploads or
permanent repository copies.

## Register the GitHub App

Create a GitHub App at https://github.com/settings/apps/new. This is separate from
the existing OAuth App; retain its client credentials and callback.

Configure:

- Callback URL: `https://YOUR_HOST/github/app/callback`.
- Setup URL: `https://YOUR_HOST/github/app/setup`; enable **Redirect on update**.
- Webhook URL: `https://YOUR_HOST/github/app/webhook`; enable webhooks and generate
  a strong random webhook secret.
- Repository permissions: **Contents: read-only**, **Metadata: read-only**,
  **Pull requests: read-only**, **Pages: read-only**. Do not grant write permissions.
  Pull requests read also permits [reading PR issue comments](https://docs.github.com/en/rest/issues/comments#list-issue-comments); Issues permission is unnecessary.
- Keep user access token expiration enabled. Private email permission is unnecessary.
- Leave **Request user authorization (OAuth) during installation** unchecked.
  Anonymous GitHub authorizes the user before opening installation; the setup
  redirect must remain available afterward.
- Allow installation on any account if this is a public service.
- Generate a private key and record the App ID, slug, client ID and client secret.

GitHub delivers installation, installation repository selection, and App user
revocation lifecycle events. The webhook verifies raw request bytes before parsing
JSON. Failed processing returns an error for operational visibility; use GitHub's
delivery redelivery controls after an outage. Pending installation checks also
retry on repository access. Access checks verify the user's current repository
access before each new upstream access.

GitHub documents [registration](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app),
[return redirects](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url),
and [repository preselection for OAuth migration](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/migrating-oauth-apps-to-github-apps).

## Environment and deployment

Set these on every API process, background worker and streamer:

```dotenv
GITHUB_APP_ENABLED=true
GITHUB_APP_NEW_CONNECTIONS=true
GITHUB_OAUTH_ENABLED=true
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=your-app-slug
GITHUB_APP_CLIENT_ID=Iv.your-client-id
GITHUB_APP_CLIENT_SECRET=your-client-secret
GITHUB_APP_CALLBACK=https://YOUR_HOST/github/app/callback
GITHUB_APP_WEBHOOK_SECRET=your-random-webhook-secret
GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github-app.pem
```

Supply the PEM key through a read-only secret mount at that path on **both**
`anonymous_github` and `streamer`. Alternatively, `GITHUB_APP_PRIVATE_KEY` accepts
the actual multiline PEM value from your secret manager. Never commit the PEM or
secrets. The optional Compose override `docker-compose.github-app.yml` mounts
`./secrets/github-app.pem` in both services:

```sh
docker compose -f docker-compose.yml -f docker-compose.github-app.yml up -d --build
```

Keep the existing `CLIENT_ID`, `CLIENT_SECRET`, `AUTH_CALLBACK`, `SESSION_SECRET`
and credential encryption keyring unchanged. The App adds encrypted credentials
under `github-app-user`; legacy `github` credentials remain OAuth credentials.
Refresh tokens have a distinct authenticated encryption purpose. The existing
credential verification command now checks both envelopes.

Deploy this release to all readers/workers **before** enabling App connections.
Existing records without a connection binding retain OAuth behavior; no bulk
credential migration is necessary for an already encryption-capable deployment.
Do not rerun plaintext cleanup just to enable the App.

## User flow

Sign in offers App and OAuth choices. Both resolve the same existing account by
its GitHub numeric user ID. A signed-in user cannot attach a different GitHub
identity. Legacy accounts without a verified GitHub ID require account recovery;
App login never automatically links by username or email.

On the anonymization form, **Connect read-only GitHub access** starts user
authorization and then repository installation. **Allow repository access on
GitHub** opens installation/configuration directly, preserving the current draft
in this browser tab for 30 minutes. Confirm access on GitHub and return to the
form. Existing installations have direct account-specific configuration links.
GitHub may require organization administrator approval. Use **Refresh access
after approval** on the Connections page when approval is delayed.

App-connected accounts default to the App for new repository/PR access. The
explicit **Use existing OAuth access** choice handles repositories not yet
available through the App. An App error never silently selects OAuth. Gists
continue using OAuth in this release.

**GitHub connections** lists each resource's current connection. First check
read-only access, then switch the resource. The switch validates the existing
commit or PR and conditionally updates the binding; it preserves the anonymous
URL, settings and existing content. Busy resources must finish before switching.
Each resource can be switched back to a verified existing OAuth grant.

OAuth can be explicitly revoked once all dependent resources, including gists,
have been migrated or removed and a working App sign-in remains. Merely connecting
the App does not revoke or narrow the OAuth grant.

## Access lifecycle and rollback

Installation tokens are short-lived, minted for one repository, and cached only
in process. Encrypted App user grants allow server-side renewal without a browser
session. Token refresh is serialized through MongoDB with conditional writes,
so a concurrent login or revocation cannot be overwritten. Background source
reads verify the owner's current App access; losing user access stops new reads.
App-bound resources never use the global token or another user's grant.

Uninstall, deselection, suspension and user grant revocation block new upstream
reads. Already published anonymized content follows existing expiration/removal
settings. Account removal revokes the user's grants and removes their resources;
it does not uninstall a shared organization installation.

Failed installation webhook checks remain pending in MongoDB and are retried on
the next repository access. Access stays blocked until reconciliation succeeds.
Revision checks prevent older responses from undoing newer lifecycle events.
User-revocation events verify the current grant, so delayed deliveries cannot
revoke a working grant created by reconnecting.

Set `GITHUB_APP_NEW_CONNECTIONS=false` to pause new App sign-ins/installations and
migrations while continuing to serve existing App resources. Setting
`GITHUB_APP_ENABLED=false` also disables existing App access; it does not fall
back to OAuth. After creating App bindings, rollback must stay on an App-aware
release with the same encryption keys. OAuth removal is not part of this release.

## Validation before enabling production

Run `npm test`, `npm run lint`, `npm run build`, and `npm run test:ui`.
MongoDB integration tests require a disposable test server:

```sh
TEST_MONGODB_URI=mongodb://127.0.0.1:27029 npm test
```

The tests create and drop separately named databases. Validate the configured App
against a disposable private GitHub repository: sign in, install with only that
repository selected, import, view files, refresh, migrate an OAuth resource, and
remove App access. Verify a second unselected private repository is inaccessible.
Exercise a private PR including comments and a Pages-enabled repository. Confirm
signed webhook deliveries arrive successfully and that reconnecting restores
access. Live GitHub acceptance requires a registered App and cannot be simulated
by the local test suite.
