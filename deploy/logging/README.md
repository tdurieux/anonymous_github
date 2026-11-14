# Operations logging

This is an opt-in stack for one Docker host. It does not deploy itself, change
production, or send notifications. The application writes structured JSON to
stdout. Vector tails tagged Docker json-file logs and host Nginx access JSON,
rebuilds each record from an allowlist, then spools sanitized records to disk.
VictoriaLogs stores searchable compressed records. Grafana provides investigation
panels. Prometheus monitors the logging components and vmalert evaluates LogsQL
alerts. Alertmanager groups firing and resolved state with an empty receiver.

## Deploy after approval

Review the application and infrastructure changes together. This PR is stacked
on `fix/remaining-production-findings`; do not deploy it without that base.

1. Reserve at least 20 GiB of dedicated logging storage and 2 GiB of RAM, outside
   the application and MongoDB budgets. The configured memory ceilings total
   1,856 MiB. Check real free memory before enabling this stack. Docker volumes
   survive container replacement, but not deletion of the volumes or host loss.
2. Create a strong Grafana password in an external secret file. Give UID 472 read
   access and restrict the parent directory to operators. Do not place the file
   in the repository. Export `GRAFANA_PASSWORD_FILE` as its absolute path and
   `GRAFANA_ADMIN_USER` as a non-default username. No password value belongs in
   a shell command, Compose file, issue, or PR.
3. Set `APP_RELEASE` to the deployed 7 to 40 character Git SHA. Build the app through
   the existing deployment workflow. Add the override when recreating services:
   `docker compose -f docker-compose.yml -f deploy/logging/app.compose.yml up -d`.
   This applies explicit service tags and nonblocking 10 MiB × 3 local buffers to
   the API, all four streamers, MongoDB, Redis and the backup process. BullMQ
   sandbox workers log through the API container. Existing containers need
   recreation to change their Docker log configuration.
4. Include `../nginx/anonymous-logging.conf` in the host Nginx `http` context and
   configure the relevant server with
   `access_log /var/log/nginx/anonymous.access.json anonymous_json;`.
   Test with `nginx -t`, then reload through the existing deployment workflow.
   Keep Nginx `real_ip` and proxy trust unchanged. Do not enable Mongo profiling,
   query tracing, Redis MONITOR, or request-body logging.
5. Install `nginx.logrotate` through the host configuration workflow and run it
   hourly with its own state file. Keep logs root/adm-readable only. This retains
   about six hourly files, with a 10 MiB rotation trigger checked hourly. A burst
   can exceed 10 MiB between checks; this is not a hard file quota. Use a dedicated
   filesystem quota if hard local containment is needed. Use rename/reopen, not
   copytruncate. Vector excludes compressed history and reads new files from end.
6. Set `DOCKER_LOG_DIR` if Docker's data root differs from `/var/lib/docker/containers`,
   and `NGINX_LOG_DIR` if needed. The collector mounts these directories read-only;
   it has no Docker socket, host PID namespace or ability to restart applications.
   Start with `docker compose -f deploy/logging/compose.yml up -d`.
7. Tunnel Grafana: `ssh -L 3300:127.0.0.1:3300 your-logging-host`. Open
   `http://127.0.0.1:3300`, sign in, and open **Anonymous GitHub operations**.
   Grafana is the only published port, bound to loopback. Ingest, query,
   Prometheus and Alertmanager are private container-network services. Do not
   publish their ports or put them behind the public application proxy.
8. Verify a synthetic request appears across API/streamer using its response
   `X-Request-ID`, inspect all four streamer heartbeats and three queue heartbeats,
   and inspect `ALERTS` in Grafana. Check Docker restart counts and all scrape
   targets. Observe memory and ingestion drops before increasing traffic.

Images are version-and-digest pinned in `compose.yml`. Grafana installs the
signed VictoriaLogs datasource version 0.34.0 on startup; initial installation
needs outbound HTTPS. Automatic plugin upgrades are disabled. For an offline
host, preinstall that exact signed plugin in a staged image and validate it before
removing the plugin-download network. Never enable unsigned plugins.

## Privacy and correlation

`src/core/log-schema.ts` contains reviewed literal module, event and error codes.
Unknown messages become `application_log`; arbitrary text is not retained.
`log-record.ts` permits numeric measurements, fixed diagnostic values and UUIDs.
URLs, paths, repository IDs, owner IDs, cookies, headers, request/response bodies,
OAuth query parameters and stacks are omitted. Extend the application schema and
collector allowlist together when a new diagnostic is needed. Do not turn unknown
strings into labels. Raw Node fatal stderr and dependency output can still reach
short local Docker buffers; the collector never forwards their raw text.

Requests get server-created IDs at the API boundary. Existing API-to-streamer
header propagation is unchanged, including its validation. IDs are diagnostics,
not authentication or proof of origin. New download, removal and cache jobs carry the
request UUID and a random job UUID. Sandbox execution adds attempt and worker
service context. Older jobs get a new opaque job UUID
when executed. Their historical enqueue request cannot be reconstructed.

Only `service,severity` identify VictoriaLogs streams. Request, job, instance,
release and edge IDs are searchable fields, not stream or metric labels.
Nginx edge IDs link to application IDs; Cloudflare ray IDs are accepted only in a
fixed format. MongoDB contributes numeric event ID and severity, never `msg`,
`attr`, command or query text. Redis and backup output contributes presence only.
Malformed tagged records become a metadata event. Oversized lines are discarded
with collector error counters. There is no sampling of accepted records.

Central records omit IP addresses entirely, including unsalted IP hashes.
Restricted host Nginx buffers preserve IP evidence for a short incident window.
Do not attach those files to issues or PRs. Inspect them locally as an authorized
operator. Extending IP retention or exporting IPs needs a separate reviewed change.

## Budgets and failure behavior

VictoriaLogs has seven-day retention, a 10 GiB retention target and a 5 GiB free
space reserve. It deletes old daily partitions, so the target is not a hard quota:
current-day data, merges and indexes can exceed it. Put `/storage` on a dedicated
filesystem or apply a host filesystem quota for hard isolation. Reserve 20 GiB
for this stack and alert at 8 GiB used or under 8 GiB free. Keep application data
on a different filesystem for protection from a logging flood. At the free-space
reserve, ingest stops and Vector queues sanitized records.

Vector's persistent disk buffer is 256 MiB, followed by a 1,000-event memory
overflow buffer with `drop_newest`. The memory stage makes full-buffer losses
observable in Vector 0.61.0; its disk-only drop path omits fullness-loss counters.
The overflow stage is volatile and can deliver records out of order. Disk files and
checkpoints survive collector restarts. Allocation and metadata add overhead;
budget 512 MiB on disk. Outages cause retries with one in-flight request. Once
the buffer fills, new records are lost; applications do not wait. Vector syncs
the buffer periodically, so sudden power loss can lose the latest records.
Collector reads are not a transaction with Docker rotation: downtime beyond the
local buffers loses events. Delivery can duplicate records after a retry. There
is no exactly-once or host-failure durability claim.

The application drops stdout writes above 256 KiB pending, counts losses in its
heartbeat and handles a broken pipe without crashing. A broken stdout switches to bounded
stderr output so later worker heartbeats can still report drops. If both pipes
fail, that process cannot report its own telemetry. Docker's nonblocking
1 MiB per-container buffer can also drop independently, without an application
counter. Compare edge traffic against request completions during overload.
Each application container retains at most roughly 30 MiB of Docker files,
excluding an oversized single record and filesystem overhead. Logging-stack
containers use 5 MiB × 2 files each. Prometheus retains seven days or 512 MB of
blocks; WAL/head space needs additional headroom. Alertmanager/Grafana volumes
also need space. No compression ratio is promised for production data.

Admin error pages keep their existing Redis ring and counters by default. Their
payloads now contain safe structured diagnostics, so private URLs and stacks are
no longer available there. The mirror has no offline queue and a bounded command
queue. Once operators use Grafana, `LOG_REDIS_MIRROR=off` removes per-warning
Redis writes and ring duplication. This deliberately stops new admin error
history; existing history remains until normal expiry/overwrite or an approved
cleanup. Leave it on if that admin feature is required. Request/performance
metrics and queue admin functions are unchanged.

## Investigation

Dashboard panels separate first-byte delay, transfer time and named stages;
show client cancellations separately; compare 5xx and latency by release; and
show queue waiting age, job failures, memory and process starts. Paste a response
UUID into Request UUID, or a job UUID into Job UUID. Use the edge panel to find
the application ID for an edge request, then paste that ID into Request UUID.

Useful LogsQL queries, with the Grafana time picker limiting scope:

```text
requestId:="REQUEST_UUID"
jobId:="JOB_UUID"
event:process_fatal_error OR event:process_started
errorCode:github_rate_limit_exceeded OR errorCode:github_app_reconnect_required
service:nginx status:429 | stats by (route, limit_req_status) count() as requests
service:api outcome:completed | stats by (release) quantile(0.95, firstByteMs) as p95_ms
module:github-app-webhook | stats by (phase, upstreamStatus) count() as failures
```

The alert rules distinguish completed server failures from cancellations and
expected 4xx. 5xx require both a minimum count and a ratio sustained for five
minutes. Rate-limited traffic stays visible without paging. Queue age ignores
intentional delayed jobs. Telemetry alerts expect one API, four streamers and
three queues; update the streamer threshold during planned scaling. Memory
pressure uses cgroup usage including workers/page cache, with process RSS retained
for diagnosis. Missing telemetry is necessary because dead processes cannot emit
a final error. A logging-host outage also defeats same-host alerts; independent
external monitoring must be configured separately. No receiver is enabled here.

## Separate logging host and rollback

For host-failure durability, run VictoriaLogs, Grafana, Prometheus, vmalert and
Alertmanager on a separate host with encrypted backups of their persistent volumes.
Keep Vector and its local spool on the application host. Change the Vector sink
endpoint to a TLS-authenticated private reverse proxy or a restricted VPN address;
permit only collector ingress, never public ingestion. Use certificate files or
Docker secrets for credentials, not committed values. Scrape Vector over that
same private network. This repository's same-host Compose does not claim to set
up that network, certificates, backup policy or authentication proxy for you.
Test the remote arrangement with synthetic records and a network outage before
cutover. Backups must preserve the same access restrictions as live logs.

Rollback the application image and remove `app.compose.yml` from the deployment
command, then recreate application containers using the prior logging settings.
Stop the logging stack with `docker compose -f deploy/logging/compose.yml down`
without `-v`; that preserves logs, spool, dashboards and alert state. Restore the
prior Nginx logging configuration through the host workflow and test before
reloading. Keep any retained data private until its approved deletion date.
Re-enable `LOG_REDIS_MIRROR=on` if it was disabled. None of these steps requires
changing MongoDB data or application queues. Do not delete volumes as rollback.

## Local validation and references

Run `npm ci`, `npx tsc --noEmit`, and
`LOG_REDIS_MIRROR=off npx mocha test/structured-logging.test.js test/request-monitoring.test.js`.
Run `python3 scripts/test-logging.py --stress` with Docker Compose and PyYAML installed.
It creates a random project and synthetic files, opens temporary loopback test
ports, and removes only its own containers/volumes. It tests actual ingestion,
privacy, correlation, query syntax, rotation, restart, backend outage and recovery,
retention rejection and fixture storage size. It never reads production logs or
uses the application `.env`. The optional `--stress` writes 500,000 synthetic records while the backend is
stopped, checks the buffer bound and collector liveness, and waits for the real
CollectorDrops alert to fire. Allow 1 GiB temporary disk and up to 15 minutes with the 0.5 CPU collector limit.
These fixtures do not establish sustained production throughput.

Local results on 2026-11-14: application build, TypeScript and lint passed. The full
suite had 1,656 passing, 441 skipped and five failures also reproduced on base
`b456ab8`: one missing `cache_miss` translation, three activity-date mocks missing
`hint()`, and one existing Vue split-preview expectation. A focused logging and
job-reconnection run passed 34 tests. Skipped database tests were not executed.
The synthetic 10,000-record batch contained 2,070,000 raw JSON bytes; the entire
VictoriaLogs fixture store occupied about 357–358 KB of data and indexes,
including earlier records. This is a fixture measurement, not a production ratio.
The backend-outage stress run submitted 500,000 records, observed 136,532,570
buffered bytes without collector restart/OOM, and verified that `CollectorDrops`
reached firing after its sustained two-minute threshold. The overflow stage
reported its losses. A separate real query verified terminal worker drop counts
in the dashboard.

Official references checked 2026-11-14:

- [VictoriaLogs retention and resource flags](https://docs.victoriametrics.com/victorialogs/)
- [Vector ingestion setup](https://docs.victoriametrics.com/victorialogs/data-ingestion/vector/)
- [Vector buffering guarantees and loss behavior](https://vector.dev/docs/architecture/buffering-model/)
- [VictoriaLogs metrics](https://docs.victoriametrics.com/victorialogs/metrics/)
- [vmalert LogsQL integration](https://docs.victoriametrics.com/victorialogs/vmalert/)
- [Grafana plugin provisioning](https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/)

- [Pinned Vector buffer sender accounting](https://github.com/vectordotdev/vector/blob/v0.61.0/lib/vector-buffers/src/topology/channel/sender.rs)
