# Remote MongoDB recovery replica

This guide converts the existing production MongoDB container into a replica
set named `rs0` and adds a MongoDB container on a second server. The servers
communicate over Tailscale; MongoDB is not exposed on a public interface.

Read the complete guide before changing production.

## What this creates

| Member | Role | Votes | Priority | Hidden | Default delay |
| --- | --- | ---: | ---: | --- | ---: |
| `mongo-primary` | Production primary | 1 | 1 | No | 0 |
| `mongo-secondary` | Recovery copy | 0 | 0 | Yes | 1 hour |

The secondary cannot become primary. Losing the secondary or its network
connection therefore does not stop production writes. This two-server layout
is for recovery and for taking backups from a remote copy; it is not automatic
failover.

Replication is also not a backup. Deletes and corrupt data eventually
replicate. Continue making versioned, encrypted, off-server `mongodump`
archives.

## How names and addresses are used

MongoDB replica-set members are advertised with stable hostnames:

- `mongo-primary:27017`
- `mongo-secondary:27017`

Do not advertise the Tailscale IPs directly in `rs.initiate()` or `rs.add()`.
MongoDB expects stable hostnames, and recent MongoDB versions reject
IP-only replica-set configurations.

The Compose overlays make the two hostnames deterministic:

- Inside the primary Docker network, `mongo-primary` resolves directly to the
  primary MongoDB container.
- Inside the secondary Docker network, `mongo-secondary` resolves directly to
  the secondary MongoDB container.
- Cross-server names are mapped to the other server's Tailscale IP with
  Compose `extra_hosts`.

This mapping is important. If `mongo-primary` does not map back to the primary
container, `rs.initiate()` fails with:

```text
No host described in new configuration ... maps to this node
```

## Example values

The guide uses these examples:

| Setting | Example |
| --- | --- |
| Repository path on both servers | `/home/ubuntu/git/anonymous_github` |
| Primary Tailscale machine name | `mongo-primary` |
| Primary Tailscale IPv4 | `100.64.10.20` |
| Secondary Tailscale machine name | `mongo-secondary` |
| Secondary Tailscale IPv4 | `100.64.10.30` |

Replace every example IP and repository path with the value from your server.
Never enter the literal value `100.x.x.x`.

`MONGO_BIND_ADDRESS` always contains the Tailscale IP of the server whose
`.env` file you are editing:

```text
primary .env   -> MONGO_BIND_ADDRESS=<primary Tailscale IP>
secondary .env -> MONGO_BIND_ADDRESS=<secondary Tailscale IP>
```

## Prerequisites

Before starting, confirm all of the following:

- The production standalone MongoDB is healthy.
- You have a recent, verified `mongodump` backup.
- The repository is installed at the same path on both servers.
- Both servers run the same repository revision.
- Both servers run the exact same MongoDB version.
- Tailscale is connected on both servers.
- TCP port `27017` is not publicly exposed.
- You have a maintenance window for restarting MongoDB and the application.

Do not delete or copy a live WiredTiger data directory. The existing primary
volume stays in place, and MongoDB initial-syncs the secondary after it is
added.

## 1. Record the current production state

Run on the primary:

```bash
cd /home/ubuntu/git/anonymous_github

docker compose -f docker-compose.yml ps
docker compose -f docker-compose.yml exec -T mongodb mongod --version
git rev-parse HEAD
```

Pin the current MongoDB version in `.env`. Do not leave production on
`mongo:latest` while changing the topology:

```env
MONGO_IMAGE=mongo:<exact-version-running-now>
```

Save a protected copy of the current configuration:

```bash
cp .env .env.before-replica
chmod 600 .env.before-replica
```

This file contains secrets. Do not commit or copy it to an untrusted system.

## 2. Back up the standalone database

Stop application writers for a consistent pre-conversion backup:

```bash
docker compose -f docker-compose.yml stop \
  anonymous_github streamer mongodb-backup
```

Create an archive:

```bash
mkdir -p db_backups/manual
BACKUP="db_backups/manual/production-before-replica-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"

docker compose -f docker-compose.yml exec -T mongodb sh -eu -c \
  'mongodump \
    --username="$MONGO_INITDB_ROOT_USERNAME" \
    --password="$MONGO_INITDB_ROOT_PASSWORD" \
    --authenticationDatabase=admin \
    --db=production \
    --archive \
    --gzip' > "$BACKUP"

test -s "$BACKUP"
chmod 600 "$BACKUP"
ls -lh "$BACKUP"
```

Keep the application stopped until the replica primary is working. If you
restart it temporarily, stop it again before step 9.

## 3. Connect and name both Tailscale servers

On the primary:

```bash
sudo tailscale set --hostname=mongo-primary
tailscale ip -4
tailscale status
```

On the secondary:

```bash
sudo tailscale set --hostname=mongo-secondary
tailscale ip -4
tailscale status
```

Record both IPv4 addresses. For the example topology:

```text
mongo-primary   100.64.10.20
mongo-secondary 100.64.10.30
```

Verify connectivity in both directions:

```bash
# Run on the primary.
tailscale ping mongo-secondary

# Run on the secondary.
tailscale ping mongo-primary
```

If the short names do not work, fix Tailscale/MagicDNS first. You may test with
the Tailscale IPs, but the MongoDB member names used later remain
`mongo-primary` and `mongo-secondary`.

Restrict your Tailscale policy so only the required servers can reach TCP
`27017`. Do not publish MongoDB on `0.0.0.0` or a public cloud interface.

## 4. Install the same repository revision on the secondary

On both servers:

```bash
cd /home/ubuntu/git/anonymous_github
git rev-parse HEAD
```

The commit IDs must match. The following files must exist:

```bash
test -f docker-compose.replica-primary.yml
test -f docker-compose.replica-secondary.yml
test -x scripts/mongodb-replica.sh
test -x scripts/mongodb-replica-entrypoint.sh
```

Do not start a second copy of the Anonymous GitHub application on the
secondary. Only the `mongodb-secondary` service is used there.

## 5. Generate and copy the shared MongoDB keyfile

Generate the key once on the primary:

```bash
cd /home/ubuntu/git/anonymous_github
./scripts/mongodb-replica.sh generate-key
```

If the file already exists, reuse it. Do not generate a different key on the
secondary.

Create the destination directory:

```bash
ssh ubuntu@mongo-secondary \
  'mkdir -p /home/ubuntu/git/anonymous_github/secrets &&
   chmod 700 /home/ubuntu/git/anonymous_github/secrets'
```

Copy the key over Tailscale:

```bash
scp secrets/mongo-replica-keyfile \
  ubuntu@mongo-secondary:/home/ubuntu/git/anonymous_github/secrets/mongo-replica-keyfile
```

On the secondary:

```bash
chmod 600 /home/ubuntu/git/anonymous_github/secrets/mongo-replica-keyfile
```

Verify that both servers have the exact same file:

```bash
sha256sum /home/ubuntu/git/anonymous_github/secrets/mongo-replica-keyfile
```

The hashes must match. The keyfile is ignored by Git; never commit it.

## 6. Configure the primary `.env`

On the primary, add the following values using the actual IPs:

```env
MONGO_IMAGE=mongo:<exact-version-running-now>

MONGO_PRIMARY_HOSTNAME=mongo-primary
MONGO_PRIMARY_ADDRESS=100.64.10.20
MONGO_SECONDARY_HOSTNAME=mongo-secondary
MONGO_SECONDARY_ADDRESS=100.64.10.30

# This is the primary server's own Tailscale address.
MONGO_BIND_ADDRESS=100.64.10.20
MONGO_REPLICA_KEYFILE=./secrets/mongo-replica-keyfile
```

Do not set `COMPOSE_FILE` yet. Do not switch `MONGODB_URI` to a replica-set
URI yet. Those two values are enabled only after replication is healthy.

Keep the existing `DB_USERNAME` and `DB_PASSWORD` values unchanged.

Validate the rendered primary configuration:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.replica-primary.yml \
  config -q
```

## 7. Configure and start the secondary

Create `.env` on the secondary:

```env
MONGO_IMAGE=mongo:<same-exact-version-as-primary>

MONGO_PRIMARY_HOSTNAME=mongo-primary
MONGO_PRIMARY_ADDRESS=100.64.10.20
MONGO_SECONDARY_HOSTNAME=mongo-secondary
MONGO_SECONDARY_ADDRESS=100.64.10.30

# This is the secondary server's own Tailscale address.
MONGO_BIND_ADDRESS=100.64.10.30
MONGO_REPLICA_KEYFILE=./secrets/mongo-replica-keyfile
```

Validate and start it:

```bash
cd /home/ubuntu/git/anonymous_github

docker compose -f docker-compose.replica-secondary.yml config -q
./scripts/mongodb-replica.sh secondary-up mongo-secondary:27017
```

The command verifies that `mongo-secondary` resolves to the secondary
container before continuing.

Check both mappings inside the secondary container:

```bash
docker compose -f docker-compose.replica-secondary.yml \
  exec -T mongodb-secondary getent hosts \
  mongo-primary mongo-secondary
```

Expected:

- `mongo-primary` resolves to the primary Tailscale IP (`100.64.10.20` in the
  example).
- `mongo-secondary` resolves to a Docker/container address, normally
  `172.x.x.x`.

If either mapping is wrong, stop here and fix `.env`.

## 8. Verify the secondary network

On the primary, verify that the Tailscale peer is reachable:

```bash
tailscale ping mongo-secondary
```

On the secondary, inspect the published port:

```bash
docker compose -f docker-compose.replica-secondary.yml ps
```

The port display must use the secondary's Tailscale IP, for example
`100.64.10.30:27017->27017/tcp`. It must not use `0.0.0.0`.

## 9. Convert the production MongoDB to a replica primary

On the primary, make sure application writers are stopped:

```bash
cd /home/ubuntu/git/anonymous_github

docker compose -f docker-compose.yml stop \
  anonymous_github streamer mongodb-backup
```

Start MongoDB through the replica overlay and initialize `rs0`:

```bash
./scripts/mongodb-replica.sh primary-up mongo-primary:27017
```

This command:

1. Recreates only the primary MongoDB container with `--replSet rs0`.
2. Enables member authentication with the shared keyfile.
3. Waits for MongoDB to answer.
4. Verifies `mongo-primary` from inside the container.
5. Runs `rs.initiate()` only if the replica set is not already initialized.
6. Waits until `rs0` has elected a writable primary.

Verify both mappings inside the primary container:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.replica-primary.yml \
  exec -T mongodb getent hosts \
  mongo-primary mongo-secondary
```

Expected:

- `mongo-primary` resolves to a Docker/container address, normally
  `172.x.x.x`.
- `mongo-secondary` resolves to the secondary Tailscale IP
  (`100.64.10.30` in the example).

Confirm the primary state:

```bash
./scripts/mongodb-replica.sh status
```

The only member should initially report `PRIMARY`.

## 10. Add the remote secondary

Use the default one-hour delay:

```bash
./scripts/mongodb-replica.sh add-secondary \
  mongo-secondary:27017
```

For a current, non-delayed recovery copy, explicitly pass `0`:

```bash
./scripts/mongodb-replica.sh add-secondary \
  mongo-secondary:27017 0
```

The command first checks that the primary container can resolve and reach
`mongo-secondary`. It then adds the member as:

```text
priority: 0
votes: 0
hidden: true
secondaryDelaySecs: 3600
```

Watch the initial sync:

```bash
./scripts/mongodb-replica.sh status
```

`STARTUP2` or `RECOVERING` can appear during initial sync. Continue only when:

```text
mongo-primary:27017   PRIMARY
mongo-secondary:27017 SECONDARY
```

Large databases can take a long time to initial-sync.

## 11. Switch the application to the replica-set URI

Only after both members are healthy, add these values to the primary `.env`:

```env
COMPOSE_FILE=docker-compose.yml:docker-compose.replica-primary.yml

MONGODB_URI="mongodb://<url-encoded-user>:<url-encoded-password>@mongo-primary:27017/production?authSource=admin&replicaSet=rs0&retryWrites=true&w=majority"
```

MongoDB usernames and passwords must be URL-encoded if they contain characters
such as `@`, `:`, `/`, `?`, `#`, or `%`.

`COMPOSE_FILE` makes future ordinary `docker compose` commands include the
primary replica overlay. Without it, a later `docker compose up -d` could
recreate MongoDB without `--replSet`.

Restart and verify the application:

```bash
docker compose up -d redis streamer anonymous_github
docker compose ps
docker compose logs --tail=100 anonymous_github
```

Verify replica status again:

```bash
./scripts/mongodb-replica.sh status
```

## Routine operations

Check status from the primary:

```bash
./scripts/mongodb-replica.sh status
```

Check logs:

```bash
# Primary
docker compose logs --tail=100 mongodb

# Secondary
docker compose -f docker-compose.replica-secondary.yml \
  logs --tail=100 mongodb-secondary
```

If an accidental delete occurs and the secondary is delayed, stop the
secondary before the one-hour window expires:

```bash
docker compose -f docker-compose.replica-secondary.yml \
  stop mongodb-secondary
```

Take a logical dump or snapshot of the stopped recovery copy before attempting
repair.

Do not turn the secondary into a second voting member. A two-voter set requires
both servers for a majority and can make production unwritable during a
network outage. Automatic failover requires three voting, data-bearing
members.

## Complete rollback to standalone MongoDB

Use this procedure if conversion fails or you decide not to use replication.
It keeps the existing primary data volume.

On the primary, remove or comment out:

```env
COMPOSE_FILE=docker-compose.yml:docker-compose.replica-primary.yml
MONGODB_URI="mongodb://...replicaSet=rs0..."
MONGO_REPLICA_KEYFILE=./secrets/mongo-replica-keyfile
```

Set:

```env
MONGODB_URI=
DB_HOSTNAME=mongodb
MONGO_BIND_ADDRESS=127.0.0.1
```

Keep the pinned `MONGO_IMAGE` and the real `DB_USERNAME`/`DB_PASSWORD`.

Recreate MongoDB from only the base Compose file:

```bash
docker compose -f docker-compose.yml stop \
  anonymous_github streamer mongodb

docker compose -f docker-compose.yml \
  up -d --force-recreate mongodb
```

Verify the running command does not contain `--replSet`:

```bash
docker compose -f docker-compose.yml \
  exec -T mongodb sh -c \
  'tr "\000" " " < /proc/1/cmdline; echo'
```

Verify database access:

```bash
docker compose -f docker-compose.yml exec -T mongodb sh -eu -c \
  'mongosh --quiet \
    --username="$MONGO_INITDB_ROOT_USERNAME" \
    --password="$MONGO_INITDB_ROOT_PASSWORD" \
    --authenticationDatabase=admin \
    --eval "db.adminCommand({ ping: 1 })"'
```

Restart the standalone application:

```bash
docker compose -f docker-compose.yml \
  up -d redis streamer anonymous_github
```

Stop the remote secondary:

```bash
docker compose -f docker-compose.replica-secondary.yml \
  stop mongodb-secondary
```

Do not delete either MongoDB volume, the `local` database, or the shared
keyfile during rollback.

## Troubleshooting

### `Replica keyfile not found`

On the primary:

```bash
./scripts/mongodb-replica.sh generate-key
```

Copy that same file to:

```text
/home/ubuntu/git/anonymous_github/secrets/mongo-replica-keyfile
```

on the secondary. Do not generate two independent keys. Compare both files
with `sha256sum`.

### `MongoServerError: not running with --replSet`

The primary is still using the base Compose configuration. Run:

```bash
./scripts/mongodb-replica.sh primary-up mongo-primary:27017
```

Do not run `add-secondary` before `primary-up` succeeds.

Inspect the primary process:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.replica-primary.yml \
  exec -T mongodb sh -c \
  'tr "\000" " " < /proc/1/cmdline; echo'
```

It must contain `--replSet rs0`.

### `No host described ... maps to this node`

`mongo-primary` does not resolve back to the primary MongoDB container.
Confirm that the current Compose overlays include `hostname`, `networks`
aliases, and `extra_hosts`, then run:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.replica-primary.yml \
  config

docker compose \
  -f docker-compose.yml \
  -f docker-compose.replica-primary.yml \
  exec -T mongodb getent hosts mongo-primary
```

The result must be the primary container address, normally `172.x.x.x`, not
the host's `100.x.x.x` Tailscale address.

After correcting `.env`, recreate the primary container and retry:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.replica-primary.yml \
  up -d --force-recreate mongodb

./scripts/mongodb-replica.sh primary-up mongo-primary:27017
```

If a bad replica configuration was already accepted rather than rejected, use
the standalone rollback procedure before attempting any forced
`rs.reconfig()`. Forced replica reconfiguration can cause rollback or data
loss.

### The primary cannot reach the secondary

Check the host network:

```bash
tailscale ping mongo-secondary
tailscale status
```

Check the mapping from the primary container:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.replica-primary.yml \
  exec -T mongodb getent hosts mongo-secondary
```

It must return the secondary's Tailscale IP.

Check the secondary:

```bash
docker compose -f docker-compose.replica-secondary.yml ps
docker compose -f docker-compose.replica-secondary.yml \
  logs --tail=100 mongodb-secondary
```

Confirm the Tailscale ACL and host firewall allow TCP `27017` from the primary
to the secondary.

### The application cannot connect after conversion

Check:

1. `MONGODB_URI` uses `mongo-primary:27017`.
2. It includes `replicaSet=rs0` and `authSource=admin`.
3. Credentials are URL-encoded.
4. `COMPOSE_FILE` includes the primary overlay.
5. The application container resolves the alias:

   ```bash
   docker compose exec -T anonymous_github getent hosts mongo-primary
   ```

6. `./scripts/mongodb-replica.sh status` reports a `PRIMARY`.

## References

- [MongoDB: convert a standalone server to a replica set](https://www.mongodb.com/docs/manual/tutorial/convert-standalone-to-replica-set/)
- [MongoDB: deploy a replica set with keyfile authentication](https://www.mongodb.com/docs/v8.0/tutorial/deploy-replica-set-with-keyfile-access-control/)
- [MongoDB: use resolvable hostnames for replica members](https://www.mongodb.com/docs/manual/tutorial/change-hostnames-in-a-replica-set/)
- [MongoDB: configure a delayed member](https://www.mongodb.com/docs/manual/tutorial/configure-a-delayed-replica-set-member/)
- [MongoDB: hidden replica-set members](https://www.mongodb.com/docs/manual/core/replica-set-hidden-member/)
- [Tailscale: MagicDNS](https://tailscale.com/docs/features/magicdns)
