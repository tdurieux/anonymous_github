# Operations dashboard

The overview uses the compact summary row, paired trends, and troubleshooting separation shown by the [VictoriaLogs single-node dashboard](https://grafana.com/grafana/dashboards/22084-victorialogs-single-node/) and [VictoriaLogs Internal State dashboard](https://grafana.com/grafana/dashboards/24585-victorialogs-internal-state/). Queries are adapted to this application's emitted fields. These are observed log counts, not availability or delivery guarantees.

The default window is one hour. Heartbeat and queue summaries cover the three minutes before the selected range end. The alert table and scrape status also describe that range end. A missing row is missing telemetry. A zero count says only that no matching events were collected. Expected deployment counts are one API instance, four streamer instances, and download/cache/remove queues; adjust the expectations alongside planned scaling.

API counts include both normal and slow completed requests. Interrupted requests are separate regardless of their recorded HTTP status. Nginx and API counts are separate hops and must not be added. `firstByteMs` ends at Node's `writeHead`; `responseMs` runs from that boundary to finish/close. Neither measures client receipt. Queue values and container memory ratios are recent maxima, not current snapshots or sums. Release comparison uses only records observed in the selected window.

Statistics panels use the datasource's `stats` / `statsRange` modes. Aggregate tables use raw aggregate rows, pack their fields into `Line`, extract JSON, keep only named columns, then convert numeric fields. This deliberately removes the meaningless aggregate timestamp and log metadata. Raw logs retain real timestamps and map the sanitized `severity` field through datasource log-level rules.

## Investigation links

Use `/d/anonymous-investigation?from=<epoch-ms>&to=<epoch-ms>` with URL-encoded variables:

- `var-request_id`, `var-job_id`, `var-edge_id`: exact IDs. Empty values match nothing in correlation panels.
- `var-service`, `var-release`, `var-event`: regular expressions. Defaults are `.*`, including absent fields. Escape regex metacharacters for exact values, and use `^...$` for exact matching.

The overview preserves the old variables and correlation panels in a collapsed row, so existing operations-dashboard links still work. Its investigation link carries the selected time range and variables. Filtered events and ID correlation are separate panels; the service/release/event filters apply only to filtered events so an ID lookup can still show every correlated hop.

## Responding to alerts

Open the panel's alert-details link for rule state. Empty results are not a health guarantee: first check the telemetry scrape panel and reporting instances. The following names come from the existing alert rules; this PR does not modify those rules or silence anything.

| Alert | Meaning and next check |
| --- | --- |
| ApplicationMemoryPressure | Container memory usage exceeded 85% of its limit for the rule duration. Compare the reporting table and investigate process heartbeats. Process RSS is a different measurement. |
| ApiTelemetryMissing / StreamerTelemetryMissing / QueueTelemetryMissing | Expected heartbeat coverage is missing. Check collector ingestion and process/queue reporting before assuming the application stopped. |
| SustainedServerErrors / WebhookFailures | Repeated completed HTTP 5xx. Investigate the affected service and request IDs in the selected window. Interrupted events are separate. |
| QueueWaitingTooLong / QueueStalled | Old runnable work or stalled jobs. Inspect the named queue, job failures and job IDs. |
| ApplicationRestartBurst | Repeated process starts. Filter investigation events to process_started or process_fatal_error. |
| ApplicationLogDrops / CollectorDrops / CollectorErrors / LogIngestionRejected | Observability may be incomplete. Inspect producer drop counters, collector buffers/errors and ingestion metrics before trusting low error counts. |
| LoggingTelemetryMissing / LogAlertEvaluationFailed | Monitoring targets or alert evaluation are failing. Restore telemetry before interpreting an empty alert table. |
| LogStoragePressure | Log data approaches the 10 GiB budget or free disk approaches the reserve. Inspect both storage charts. Do not delete application data to resolve this alert. |

During read-only production inspection, the reported firing rule was `ApplicationMemoryPressure` for `streamer`; one instance's three-minute peak container ratio was about 90.9%. This was an observation at inspection time, not a current-health claim. No production configuration, dashboard, alert, auth, retention, or deployment was changed.

## Local validation

Requires Docker Compose, Python 3 and PyYAML. The fixture tool starts only its own project using the pinned images and plugin in `compose.yml`, generated credentials, loopback ports, and synthetic log files collected through the real Vector sanitizer. It overrides the private bridge only in this local test project to make published loopback ports reachable. Production networking is unchanged.

```sh
python3 scripts/grafana-fixtures.py start
GRAFANA_TEST_URL="$(cat /tmp/grafana-dashboard-fixtures/url)" \
GRAFANA_TEST_PASSWORD_FILE=/tmp/grafana-dashboard-fixtures/password \
python3 scripts/test-grafana-dashboard.py
```

Open the printed local URL, authenticate using the generated password file without printing or committing it, then open `anonymous-operations`. The fixture contains normal requests, slow 503s, interruptions, two releases, five reporting processes, and three queues. After three minutes without new fixtures, reporting/queue rows disappear. This tests missing telemetry without replacing it with zeros. The reserved `fff0001` release contains exactly two completed requests, one completed 5xx, one interruption, and a measured p95 of 1.2 seconds.

In the browser, verify readable aggregate columns, header/post-header legend labels, bytes in storage charts, named firing alerts when rules fire, an empty historical window, and correlation links. Backend frame tests cannot substitute for checking Grafana's frontend transformations. Verify both desktop and a narrow viewport. Screenshots must be labeled synthetic, not production health evidence.

```sh
python3 scripts/grafana-fixtures.py stop
```

The password and synthetic source files remain under the private temporary directory for inspection. Remove that directory before starting another fixture run. Never point the fixture or test scripts at a production tunnel.
