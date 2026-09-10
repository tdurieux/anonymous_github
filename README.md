<div align="center">

# Anonymous GitHub

**Share your code and data for double-anonymous peer review — without giving your identity away.**

[![npm](https://img.shields.io/npm/v/@tdurieux/anonymous_github?logo=npm)](https://www.npmjs.com/package/@tdurieux/anonymous_github)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![Live instance](https://img.shields.io/badge/live-anonymous.4open.science-e5503a)](https://anonymous.4open.science/)
[![GitHub stars](https://img.shields.io/github/stars/tdurieux/anonymous_github?style=social)](https://github.com/tdurieux/anonymous_github/stargazers)

[**Public instance**](https://anonymous.4open.science/) · [How it works](#how-it-works) · [Self-hosting](#self-hosting)

![Anonymous GitHub screenshot](public/imgs/screenshot.png)

</div>

## Why

Double-anonymous review asks you to anonymize the artifact behind your paper — the code and data — exactly like the paper itself. Doing that by hand (owner, organization, repository name, logins, and every mention buried in the files) is tedious and easy to get wrong. Anonymous GitHub does it for you and serves the result behind a shareable link.

A free public instance is available at **[anonymous.4open.science](https://anonymous.4open.science/)**.

## What it anonymizes

- The GitHub **owner, organization, and repository name**
- **File and directory names**
- **File contents** of every extension (Markdown, text, source code, …), replacing a configurable list of terms

## Usage

### Public instance

Just open **[anonymous.4open.science](https://anonymous.4open.science/)**, paste your repository URL, add the terms to hide, and share the generated link.

### CLI

Anonymize a repository locally and produce an anonymized zip:

```bash
npm install -g @tdurieux/anonymous_github
anonymous_github
```

## Self-hosting

<details>
<summary>Run your own instance with Docker</summary>

**1. Clone and install**

```bash
git clone https://github.com/tdurieux/anonymous_github/
cd anonymous_github
npm i
```

**2. Configure GitHub access** — create a `.env` file:

```env
GITHUB_TOKEN=<GITHUB_TOKEN>
CLIENT_ID=<CLIENT_ID>
CLIENT_SECRET=<CLIENT_SECRET>
CREDENTIAL_KEYS='{"2026-09":"<base64-encoded 32-byte random key>"}'
CREDENTIAL_ACTIVE_KEY_ID=2026-09
CREDENTIAL_LEGACY_READS=false
PORT=5000
DB_USERNAME=
DB_PASSWORD=
AUTH_CALLBACK=http://localhost:5000/github/auth
```

- `GITHUB_TOKEN` — create one at <https://github.com/settings/tokens/new> with the `repo` scope.
- `CREDENTIAL_KEYS` / `CREDENTIAL_ACTIVE_KEY_ID` — generate a key with `openssl rand -base64 32`. Existing installations must follow the [credential migration guide](docs/credential-encryption.md) before starting this release.
- `CLIENT_ID` / `CLIENT_SECRET` — from an OAuth App at <https://github.com/settings/applications/new>.
- The App's callback must be `https://<host>/github/auth` (matching `AUTH_CALLBACK`).

To enable read-only access to selected private repositories alongside OAuth, follow
the [GitHub App setup guide](docs/github-app-setup.md).

**3. Start the server**

```bash
docker-compose up -d
```

**4. Open** <http://localhost:5000>. The port can be changed in `docker-compose.yml`; putting Anonymous GitHub behind nginx is recommended for HTTPS.

For an optional remote, hidden, delayed MongoDB replica and backup source, see
the [MongoDB replication guide](docs/mongodb-replication.md).

</details>

## Scope of anonymization

In double-anonymous review, the boundary of anonymization is **the paper plus its online appendix — and only that**. Googling part of the paper or appendix to reveal authorship is considered a deliberate attempt to break anonymity ([explanation](https://www.monperrus.net/martin/open-science-double-blind)).

## How it works

Anonymous GitHub either downloads the full repository and anonymizes each file, or proxies requests to GitHub on the fly. In both cases the original and anonymized versions are cached on the server, so even large repositories stay responsive.

## Related tools

- [gitmask](https://www.gitmask.com/) — contribute anonymously to a GitHub repository.
- [blind-reviews](https://github.com/zombie/blind-reviews/) — browser add-on that hides identifying information when reviewing a pull request.

## See also

- [Open science and double-anonymous peer review](https://www.monperrus.net/martin/open-science-double-blind)
- [ACM policy on double-blind reviewing](https://dl.acm.org/journal/tods/DoubleBlindPolicy)

## License

[GPL-3.0](LICENSE) © [Thomas Durieux](https://durieux.me)

### Frontend development

The UI uses Vue 3 and Vue Router with the existing Express API. Page setup
functions live in `public/script/app.js` and `admin.js`; the Vue templates are
in `public/partials/`. Gulp compiles the templates and bundles the app with
esbuild, then updates the asset manifest used by Express.

Run `npm run build:ui` after changing a template or frontend script. Use
`npm run dev:ui` to serve the built UI locally with API requests proxied to the
configured upstream. `npm run test:ui` rebuilds the assets and runs the frontend
regression and DOM interaction tests. `npm run build` also builds the UI for
production.

The initial bundle contains the Vue app. Markdown extensions load on content
routes; PDF.js, Ace, and notebook support load when their viewers mount.
Org support loads in the repository explorer, and Mermaid loads only when a
diagram is encountered. These libraries use hashed URLs and load once per tab.

The Docker build compiles the same bundles and copies them, the asset manifest,
and document-worker assets into the runtime image. The Compose app serves these
assets directly; no frontend development server is needed.
