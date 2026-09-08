# GitHub credential storage and migration

GitHub tokens live in `credentials`, with a unique `(ownerId, provider)` index.
Repositories, gists, and pull requests use their existing `owner` field to resolve
credentials. Users and resources have no credential reference fields. API login
tokens remain hashed in `users.apiTokens`.

Each credential contains `ownerId`, `provider`, `updatedAt`, and
`encryptedToken: { version, keyId, nonce, ciphertext, tag }`. AES-256-GCM uses a
fresh 12-byte nonce and a 16-byte authentication tag. Additional authenticated
data binds the ciphertext to the owner, provider, field, and format version.
Plaintext exists only in application memory and requests to GitHub or the internal
streamer. Use TLS for transport across untrusted networks.

## Configuration

Set these secrets on the API, workers, and migration process:

```dotenv
CREDENTIAL_KEYS='{"2026-09":"<base64-encoded 32-byte random key>"}'
CREDENTIAL_ACTIVE_KEY_ID=2026-09
CREDENTIAL_LEGACY_READS=false
```

Generate the key with `openssl rand -base64 32` and store it in your deployment's
secret manager or protected environment file. Keep it out of Git, MongoDB, logs,
and database backups. Keep a separately protected recovery copy. The application
validates the keyring before connecting to the database; there is no temporary or
default encryption key, including in development. The streamer consumes tokens
from the API and does not need the key unless it also accesses the database.

`CREDENTIAL_LEGACY_READS=true` temporarily permits reads from legacy user/resource
fields when a credential does not exist. All new writes are encrypted regardless
of this setting. A corrupt envelope or missing decryption key fails explicitly;
it never falls back to a plaintext token. Legacy tokens are not automatically
refreshed: migrate them or log in to create an encrypted credential first.

## Initial deployment

This release requires a maintenance window. Do not run old and new writers against
the same database during migration. The `--maintenance` flag records the operator's
acknowledgement; it does not stop processes or acquire a distributed lock.

1. Build the release and provision the keyring. Back up MongoDB and verify that
   the database and separately stored keys can be recovered. Rehearse on a
   protected copy first.
2. Stop all API instances, queue workers, scheduled tasks, and other database
   writers. Keep MongoDB and Redis running. Do not use the normal rolling deploy
   script for this initial upgrade. Run the migration as a one-off process using
   the new image, the existing service environment, and database network access.
3. Run the read-only inventory:

   ```sh
   node build/scripts/migrate-credentials.js
   ```

   From a source checkout with development dependencies, the equivalent is
   `npm run migrate:credentials -- <flags>`.
4. Resolve reported `conflicting_token`, `malformed_token`, and `missing_owner`
   records. Output contains collection names, record IDs, and counts, never token
   values. Conflicting owners retain all legacy fields and receive no new
   credential. An existing encrypted credential is never overwritten.

   If differing resource tokens are obsolete, `--prefer-owner-token` explicitly
   chooses the existing encrypted credential, or otherwise the user's token, over
   conflicting copies. This can remove access supplied by a different token, so
   review the inventory first. It never arbitrarily chooses between distinct
   resource-only tokens. Resource-only tokens migrate when they all agree and
   their owner exists. Removed accounts do not receive credentials.
5. Backfill without deleting the legacy fields:

   ```sh
   node build/scripts/migrate-credentials.js --apply --maintenance
   ```

   Add `--prefer-owner-token` only for the conflict resolution described above.
   Investigate every nonzero exit status. The cursor processes bounded batches;
   reruns rescan owners and skip existing credentials, so no checkpoint file or
   exported plaintext is needed.
6. Remove legacy copies after successful backfill:

   ```sh
   node build/scripts/migrate-credentials.js --apply --maintenance --remove-legacy
   node build/scripts/migrate-credentials.js --verify
   ```

   Use the same conflict-resolution flag if needed. Every owner's envelope is
   authenticated before their legacy fields are removed. Cleanup spans multiple
   collections and is not a transaction; keep writers stopped. An interruption is
   safe to resume with the same command. Verification must report `legacy: 0` and
   exit successfully; it also authenticates all stored credentials and checks
   their owners.
7. Enforce the storage boundary in MongoDB and purge old Redis sessions:

   ```sh
   node build/scripts/migrate-credentials.js --apply --maintenance --enforce
   node build/scripts/purge-legacy-sessions.js
   node build/scripts/purge-legacy-sessions.js --apply
   ```

   Enforcement preserves existing collection validators and rejects legacy token
   fields on users and resources. Session cleanup scans only `anoGH_session:*`,
   removes the old object-based Passport session format, and leaves queues and
   ID-only sessions intact. Rerun its dry run to confirm `found: 0`. The application
   also rejects old session objects. Existing users must log in again.
8. Start only the new release with `CREDENTIAL_LEGACY_READS=false`. Test OAuth
   login, API-token login, private repositories, gists, pull requests, downloads,
   and account removal. Confirm startup creates the unique credential index.

A database-only dump cannot decrypt the credentials. Historical dumps, replica
oplogs, Redis snapshots/AOF files, and existing logs may still contain plaintext
until their retention expires. Migration does not erase those historical copies.
If tokens were exposed previously, revoke/reissue them; encryption cannot undo an
exposure.

## Key rotation and rollback

Add a new random key to `CREDENTIAL_KEYS` on every reader before switching
`CREDENTIAL_ACTIVE_KEY_ID`. New logins and refreshes use the active key; existing
records remain readable through their `keyId`. Retain old keys until all records
using them have been replaced and any backups needing them have expired. This
migration command does not bulk re-encrypt existing credentials.

After encrypted writes begin, rollback must stay on an encryption-capable release
with the same keyring. A pre-encryption release cannot read the new collection and
will be rejected by the post-migration validators. Do not decrypt production data
as a rollback procedure. If maintenance must be aborted before cutover, keep
writers stopped and fix/retry the migration, or restore the pre-upgrade database
under the original release as a coordinated recovery.

## Verification tests

The regular suite tests cryptography, redaction, session contents, and the
credential service. Run MongoDB integration tests against a disposable instance:

```sh
TEST_MONGODB_URI=mongodb://127.0.0.1:27028 npm test
```

The tests create randomly named databases and delete only those test databases.
They cover stored ciphertext, hidden projections, concurrent credential writes,
refresh, OAuth login, resource lookup, migration conflicts/reruns, missing owners,
corruption, and MongoDB validators. Without `TEST_MONGODB_URI`, these integration
tests are skipped.

## Docker Compose command sequence

Run these blocks in a Bash session on the production host, from the existing
Compose project directory, after checking out the reviewed release. Keep the same
Compose project name and override files used by production. These commands assume
the repository's local `mongodb` service, with its existing root credentials in
`MONGO_INITDB_ROOT_USERNAME` and `MONGO_INITDB_ROOT_PASSWORD`. If `MONGODB_URI`
points elsewhere, back up that database instead. The host needs Python 3 and GPG.

1. Set the Compose command, preserve the running streamer count, and build without
   restarting production:

   ```bash
   set -euo pipefail
   set +x
   umask 077
   dc=(docker compose)
   # If production uses the replica override, use instead:
   # dc=(docker compose -f docker-compose.yml -f docker-compose.replica-primary.yml)
   streamer_replicas=$("${dc[@]}" ps -q streamer | wc -l | tr -d ' ')
   test "$streamer_replicas" -gt 0
   "${dc[@]}" build anonymous_github
   ```

2. Generate the persistent key directly into `.env`, without printing it or putting
   it in shell history. This deliberately refuses to replace any existing key
   configuration. On a resumed migration, keep the existing keys and skip this
   generation step.

   ```bash
   python3 <<'PY'
   import base64, os, re, secrets
   from pathlib import Path
   env = Path('.env')
   content = env.read_text()
   if re.search(r'^\s*(?:export\s+)?CREDENTIAL_(?:KEYS|ACTIVE_KEY_ID|LEGACY_READS)\s*=', content, re.M):
       raise SystemExit('Credential configuration already exists; preserve it and review before continuing.')
   key = base64.b64encode(secrets.token_bytes(32)).decode('ascii')
   os.chmod(env, 0o600)
   with env.open('a') as output:
       output.write('\nCREDENTIAL_KEYS=\'{"v1":"' + key + '"}\'\n')
       output.write('CREDENTIAL_ACTIVE_KEY_ID=v1\nCREDENTIAL_LEGACY_READS=false\n')
   PY
   "${dc[@]}" run --rm --no-deps -T --entrypoint node anonymous_github \
     -e 'require("./build/core/credentials").credentialCipher(); console.log("Credential keyring valid")'
   ```

   Save the keyring in your secret manager or a separately protected recovery
   location before proceeding. Do not use `docker compose config` or `cat .env`
   in a recorded terminal: those can disclose secrets.

3. Enter maintenance and stop all application writers. In this Compose file the
   API starts the queue workers and scheduler. Stop any additional instances or
   external writers too; do not leave the rolling deploy script running.

   ```bash
   "${dc[@]}" stop -t 120 anonymous_github streamer
   test -z "$("${dc[@]}" ps --status running -q anonymous_github streamer)"
   "${dc[@]}" ps mongodb redis
   ```

4. Take a fresh encrypted dump while writers are stopped. The password is read
   from the database container's environment into a temporary mode-0600 config in
   `/dev/shm`; it is never placed in command arguments. GPG prompts for a backup
   passphrase, which must be stored separately from the archive.

   ```bash
   backup_dir=$(mktemp -d /var/tmp/anonymous-gh-migration.XXXXXXXX)
   export GPG_TTY=$(tty)
   "${dc[@]}" exec -T mongodb bash -se <<'SH' | gpg --symmetric --cipher-algo AES256 --output "$backup_dir/mongo.archive.gz.gpg"
   set -euo pipefail
   umask 077
   export CREDENTIAL_DUMP_CONFIG=$(mktemp /dev/shm/credential-dump.XXXXXXXX)
   trap 'rm -f "$CREDENTIAL_DUMP_CONFIG"' EXIT
   mongosh --nodb --quiet --eval 'require("fs").writeFileSync(process.env.CREDENTIAL_DUMP_CONFIG, JSON.stringify({password: process.env.MONGO_INITDB_ROOT_PASSWORD}), {mode: 0o600})' >/dev/null
   mongodump --host 127.0.0.1 --port 27017 \
     --username "$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase admin \
     --config "$CREDENTIAL_DUMP_CONFIG" --archive --gzip
   SH
   test -s "$backup_dir/mongo.archive.gz.gpg"
   gpg --decrypt "$backup_dir/mongo.archive.gz.gpg" >/dev/null
   printf 'Encrypted backup: %s\n' "$backup_dir/mongo.archive.gz.gpg"
   ```

   The decryption check verifies the encrypted file, not MongoDB restoreability.
   Confirm your restore rehearsal succeeded on an isolated database before
   deleting legacy fields. Move this archive to your protected backup storage.

5. Inventory, backfill, then inventory again:

   ```bash
   migrate() {
     "${dc[@]}" run --rm --no-deps -T --entrypoint node anonymous_github \
       build/scripts/migrate-credentials.js "$@"
   }
   migrate
   migrate --apply --maintenance
   migrate
   ```

   Stop on any nonzero exit status or `issues` count. Do not add
   `--prefer-owner-token` automatically: review the conflict policy above first.
   After backfill, the second inventory should report `created: 0, issues: 0`.

6. After the backup/restore check and inventory pass, clean and enforce:

   ```bash
   migrate --apply --maintenance --remove-legacy
   migrate --verify
   migrate --apply --maintenance --enforce
   "${dc[@]}" run --rm --no-deps -T --entrypoint node anonymous_github \
     build/scripts/purge-legacy-sessions.js --apply
   "${dc[@]}" run --rm --no-deps -T --entrypoint node anonymous_github \
     build/scripts/purge-legacy-sessions.js
   ```

   Require `legacy: 0` from MongoDB verification and `found: 0` from the final
   session scan. Do not resume traffic on an unresolved error.

7. Recreate only the application services with the new image and environment:

   ```bash
   "${dc[@]}" up -d --no-deps --force-recreate --wait \
     --scale "streamer=$streamer_replicas" streamer anonymous_github
   "${dc[@]}" ps anonymous_github streamer
   migrate --verify
   ```

   Test login and a private repository/gist/pull-request download before ending
   maintenance. Existing sessions have been invalidated. If a command fails,
   keep the application stopped and fix/retry; do not launch the old release
   against the migrated database.

The one-off invocation follows Docker's [Compose run documentation](https://docs.docker.com/reference/cli/docker/compose/run/).
The backup password handling uses MongoDB's [mongodump configuration-file support](https://www.mongodb.com/docs/database-tools/mongodump/).

## Recover missing repository owners using GitHub

For `missing_owner` repositories that still have a valid token, the recovery script
calls GitHub's [authenticated-user endpoint](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)
and matches the returned ID against `users.externalIDs.github`. It assigns the
matching database user's `_id` to the repository's `owner`. This grants that user
management access to the repository, based on the identity of the stored token.
It does not create users or change tokens, and it never matches by username.

Build the updated image first, while keeping production writers stopped:

```bash
docker compose build anonymous_github
```

Preview matches for one document from the migration report:

```bash
docker compose run --rm --no-deps -T --entrypoint node anonymous_github \
  build/scripts/recover-repository-owners.js --id=6136d362bf270d7f1688cd59
```

Omit `--id` to preview all repositories. Apply automatic matches with:

```bash
docker compose run --rm --no-deps -T --entrypoint node anonymous_github \
  build/scripts/recover-repository-owners.js --apply --maintenance
```

The script skips existing owners, handles dangling owner references, and requires
exactly one matching, non-disabled database user. Duplicate user matches, revoked
tokens, and missing users remain unresolved. If the two legacy token locations
identify different accounts, it leaves the repository untouched. Conditional
updates avoid overwriting a repository whose owner or tokens changed after it was
read. Keep application writers stopped for apply runs.

Processing uses five workers by default. Set `--concurrency=1..32` to adjust
the bound. GitHub requests share a global pacing gate of at most four new requests
per second, with a 15-second timeout. In-flight work may finish after a rate limit
is detected, but no new work is scheduled.
Repeated tokens share a bounded in-memory lookup cache. HTTP 403/429 responses,
other unexpected HTTP errors, and network failures stop the scan; fix the issue or
wait for GitHub's limit to reset, then rerun. Existing assignments are skipped on
reruns. Reports contain record IDs, matched GitHub/user IDs, actions, and issue
codes, never tokens or raw GitHub responses. A nonzero exit status means unresolved
records remain or the scan halted; successful assignments are retained.

After recovery, rerun the credential migration with `--prefer-owner-token`.
Recovery leaves legacy tokens in place so the migration can still encrypt them.


## Archive all ownerless repositories

A token may belong to a shared administrator account rather than the original
repository creator. To avoid assigning those repositories to the administrator,
use `--archive-all-ownerless`. This mode makes no GitHub calls and never assigns
owners. It processes missing owners and references to deleted users, while
preserving every repository with an existing database owner.

Keep API instances, workers, streamers, and other writers stopped. Build the new
image and preview the archive actions:

```bash
docker compose build anonymous_github
docker compose run --rm --no-deps -T --entrypoint node anonymous_github \
  build/scripts/recover-repository-owners.js \
  --archive-all-ownerless --concurrency=10
```

Apply the same operation:

```bash
docker compose run --rm --no-deps -T --entrypoint node anonymous_github \
  build/scripts/recover-repository-owners.js \
  --archive-all-ownerless --concurrency=10 --apply --maintenance
```

Each archive sets `status=archived`, records the reason/date, disables source
updates, and removes both plaintext token fields. It deletes cached file content
from the configured filesystem or S3 storage. MongoDB repository records and file
metadata remain. Archived URLs return HTTP 410, and download workers do not
reactivate them. Existing owner assignments from earlier apply runs are not
undone. Review those separately if owner recovery was previously applied.

File deletion is intentional. The status change happens first, with
`archiveCachePending=true`. Successful deletion clears the marker. Failed or
interrupted cleanup is retried by the same apply command without GitHub access.
Migration verification also refuses to finish while any archive cleanup remains
pending. A clean rerun reports no issues and only already-archived records for
previously completed work. Review `unsafe_or_missing_repo_id` failures manually;
the script will not construct a storage deletion path from an unsafe ID.

For the narrower policy of archiving only missing or entirely revoked tokens,
use `--archive-unrecoverable` instead. Valid-token owner recovery still runs in
that mode. Mixed valid/invalid tokens, unexpected GitHub errors, and ambiguous
identities never trigger automatic archiving.

Once archival completes, rerun credential migration with `--prefer-owner-token`,
then follow the verification/enforcement steps above. Start only a release that
understands the archived status.
