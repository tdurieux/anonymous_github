# Optional remote MongoDB replica

This deployment option converts the existing standalone MongoDB container into
a replica set named `rs0` and adds a remote, hidden, non-voting secondary.
Normal single-node deployments continue to use `docker-compose.yml` alone.

The remote member is designed as a recovery and backup source:

- It cannot become primary.
- Its availability does not affect production majority writes.
- It is hidden from application traffic.
- It is delayed by one hour by default, providing a short recovery window for
  accidental deletes or a bad migration.

Replication is not a backup. Destructive changes eventually reach every
member. Continue making encrypted, off-host `mongodump` archives from the
secondary.

## Requirements

1. Take and verify a `mongodump` backup before converting production.
2. Install this repository on both servers.
3. Connect the servers through a trusted private network such as WireGuard,
   Tailscale, a private VLAN, or a cloud private network.
4. Create stable DNS names that resolve from both servers and from the
   application container, for example:

   - `mongo-primary.internal`
   - `mongo-secondary.internal`

5. Permit TCP port `27017` only between the required private-network hosts.
   Do not expose MongoDB to the public internet.
6. Run the exact same MongoDB version on both servers. Find the current
   production version with:

   ```bash
   docker compose exec mongodb mongod --version
   ```

   Set the matching image in both servers' `.env` files:

   ```env
   MONGO_IMAGE=mongo:<exact-version>
   ```

### Find each server's bind address

`MONGO_BIND_ADDRESS` is the address of the server whose `.env` file you are
editing. It tells Docker to publish MongoDB on that server's Tailscale
interface. It is not the address of the other replica-set member.

Run this separately on each server:

```bash
tailscale ip -4
```

For example, if the commands return:

- `100.64.10.20` on `mongo-primary`
- `100.64.10.30` on `mongo-secondary`

then configure:

| Server | Its local `.env` value |
| --- | --- |
| `mongo-primary` | `MONGO_BIND_ADDRESS=100.64.10.20` |
| `mongo-secondary` | `MONGO_BIND_ADDRESS=100.64.10.30` |

The `100.x.x.x` values in this guide are examples, not values to copy. Paste
the actual output from `tailscale ip -4`; do not put a shell command in
`.env`.

## 1. Generate the shared member key

On the primary server:

```bash
./scripts/mongodb-replica.sh generate-key
```

This creates `secrets/mongo-replica-keyfile` without overwriting an existing
key. Copy that exact file securely to the same repository-relative path on the
secondary server:

```bash
scp secrets/mongo-replica-keyfile \
  secondary-server:/path/to/anonymous_github/secrets/mongo-replica-keyfile
```

Keep this key outside source control and backups that are accessible to
untrusted users. Every replica-set member must share the same key.

## 2. Configure production

Add these values to the primary server's `.env`:

```env
# Use the exact version already running in production.
MONGO_IMAGE=mongo:<exact-version>

# Output of `tailscale ip -4` when run on the primary server.
MONGO_BIND_ADDRESS=<primary-tailscale-ip>
MONGO_REPLICA_KEYFILE=./secrets/mongo-replica-keyfile

# Make the replica overlay the default for future Compose commands.
COMPOSE_FILE=docker-compose.yml:docker-compose.replica-primary.yml

# URL-encode special characters in the username and password.
MONGODB_URI=mongodb://<user>:<password>@mongo-primary.internal:27017/production?authSource=admin&replicaSet=rs0&retryWrites=true&w=majority
```

Stop application writers, leaving MongoDB available:

```bash
docker compose stop anonymous_github streamer
```

Start MongoDB with replica-set support and initialize the existing database as
the primary:

```bash
./scripts/mongodb-replica.sh primary-up \
  mongo-primary.internal:27017
```

`primary-up` is idempotent. If `rs0` is already initialized, it reports that
state instead of replacing the replica-set configuration.

## 3. Start the remote secondary

On the secondary server, create a minimal `.env`:

```env
MONGO_IMAGE=mongo:<same-exact-version-as-primary>
# Output of `tailscale ip -4` when run on the secondary server.
MONGO_BIND_ADDRESS=<secondary-tailscale-ip>
MONGO_REPLICA_KEYFILE=./secrets/mongo-replica-keyfile
```

Start its empty MongoDB data volume:

```bash
./scripts/mongodb-replica.sh secondary-up
```

Do not copy the primary's live WiredTiger volume. MongoDB performs the initial
sync after the member is added.

## 4. Add and verify the secondary

Back on the primary server, add the remote member with the default one-hour
delay:

```bash
./scripts/mongodb-replica.sh add-secondary \
  mongo-secondary.internal:27017
```

To keep the remote copy current instead, explicitly set a zero-second delay:

```bash
./scripts/mongodb-replica.sh add-secondary \
  mongo-secondary.internal:27017 0
```

Check initial-sync and replication state:

```bash
./scripts/mongodb-replica.sh status
```

Wait until the remote member reports `SECONDARY`, then restart the application:

```bash
docker compose up -d anonymous_github streamer redis
```

## Operations

Use the primary overlay for every future operation on the production stack.
Keeping `COMPOSE_FILE` in `.env` makes ordinary commands such as
`docker compose up -d` and `docker compose logs mongodb` use it automatically.

Check replica status:

```bash
./scripts/mongodb-replica.sh status
```

If a destructive production operation occurs and the secondary is delayed,
stop the secondary container immediately before the delay window elapses:

```bash
docker compose -f docker-compose.replica-secondary.yml stop mongodb-secondary
```

Then take a copy or logical dump of the delayed data before attempting
recovery.

For automatic failover, use three voting data-bearing members instead of
turning this two-server recovery topology into a two-voter replica set. Two
voters require both servers to acknowledge a majority and can make production
unwritable during a network outage.

## Troubleshooting

- All members must use the same replica-set name (`rs0`), MongoDB version, and
  shared keyfile.
- The hostnames stored in `rs.conf()` must resolve from every member.
- The application container must also resolve `mongo-primary.internal`. Use
  private DNS or a Compose `extra_hosts` entry if host DNS is not propagated
  into Docker.
- Check container logs with:

  ```bash
  docker compose logs mongodb
  docker compose -f docker-compose.replica-secondary.yml logs mongodb-secondary
  ```

- Re-run `primary-up`, `add-secondary`, or `status` safely; the management
  operations do not replace existing replica-set members.

## MongoDB references

- [Convert a standalone server to a replica set](https://www.mongodb.com/docs/manual/tutorial/convert-standalone-to-replica-set/)
- [Deploy a replica set with member authentication](https://www.mongodb.com/docs/v8.0/tutorial/deploy-replica-set-with-keyfile-access-control/)
- [Configure a delayed member](https://www.mongodb.com/docs/manual/tutorial/configure-a-delayed-replica-set-member/)
- [Hidden replica-set members](https://www.mongodb.com/docs/manual/core/replica-set-hidden-member/)
