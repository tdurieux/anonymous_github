# Review service capabilities

`GET /service/v1/capabilities` is an optional server-to-server endpoint for the
`4open.artifacts/1` contract. It returns the authenticated client ID, the supported
contract version, and an empty `available` list. Linking, snapshots, protected
files, retention, publication, entitlements and usage are not advertised. Clients
must decline those workflows until their required capabilities are implemented.

The endpoint is mounted before JSON parsing, browser sessions and passport. The
entire `/service` namespace returns a typed 404 when configuration is absent.
Only the exact GET path is accepted. Query strings, browser context headers,
cookies, bodies, duplicate authentication headers and unknown paths are rejected.
Responses contain no credentials, owner identity, repository data, cookies or CORS
permission; they have `no-store` and `no-referrer` headers. No database, queue or
provider call is involved.

## Private configuration

Leave `REVIEW_SERVICE_KEYS` unset until activation is approved. If configured,
its value is a JSON object with exactly `version: 1` and `keys`. Each key has
exactly these fields:

- `clientId`: 32 lowercase hexadecimal characters.
- `keyId`: 1–64 ASCII letters, digits, underscores or hyphens.
- `tokenSHA256`: SHA-256 of the **ASCII 64-character lowercase hexadecimal bearer
  token**, stored as 64 lowercase hexadecimal characters. Do not hash the decoded
  token bytes and do not store a plaintext token in this registration.
- `notBefore` and `notAfter`: UTC timestamps, `YYYY-MM-DDTHH:mm:ssZ`, in 2000–2099.
  The start is inclusive and the end exclusive.

Use private runtime configuration outside Git. The caller sends
`Authorization: Bearer <token>`, `X-4open-Artifact-Client-Id` and
`X-4open-Artifact-Service-Key-Id`. Keys grant only capabilities reads. Generate a
separate token for this operation and environment; never reuse GitHub credentials,
webhook secrets or future exchange credentials. The Go review client requires
HTTPS with a trusted server certificate; a deployment must provide that transport.

The registry is bounded to 64 KiB, 64 keys, 32 clients and 16 keys per client.
Duplicate client/key pairs and reused digests are rejected. Unknown fields,
plaintext secret fields, invalid timestamps and empty configuration fail startup
with a generic diagnostic. Configuration uses ordinary JSON object parsing.
Credentials are copied into a private registry and compared by constant-time
SHA-256 digest equality. Overlapping validity windows permit rotation. Remove a
key and restart to revoke it; this is not hot reloading.

Authenticated clients share 60 reads per minute across their keys. Counters are
bounded by registered clients, reset lazily, and have no timer. Limits are local
to each server process; they are not a distributed quota. A 429 response supplies
a typed failure and a bounded retry delay. This endpoint does not accept browser
session or repository-owner authority.

## Verification

`mocha --no-config --no-package test/review-capabilities.test.js` passes seven
HTTP/configuration scenarios, including 60 concurrent reads, cross-client and
wrong-key rejection, raw duplicate headers, exact path checks, browser context,
expiry, overlapping keys and restart revocation. Add
`RUN_REVIEW_SERVICE_BENCHMARK=1` for a 150-request synthetic loopback measurement.
The recorded run averaged 1.708 ms, median 1.657 ms and p95 1.974 ms with fresh
HTTP connections. These are local tooling measurements, not production latency.

A local HTTPS interoperability rehearsal uses the existing Go
`artifactclient.NewCapabilitiesReader` at review source `ee07d06`. It verifies
certificate trust, accepts the empty capability response, rejects both unsupported
access policies and rejects a wrong credential. No external provider is contacted.

The isolated new module passes strict TypeScript checking. The repository-wide
check fails with the same diagnostics on unchanged base `083544b`: ES6 does not
support existing named regex groups, an existing Octokit response type is missing
`retryCount`, and the existing library target lacks `String.at`. These are retained
as baseline limitations; this change does not claim a passing full upstream build.

The endpoint is implemented and tested locally. Upstream deployment, private key
distribution, ownership consent and the remaining artifact workflows are pending.
