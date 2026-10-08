# Request performance monitoring

The admin overview shows API and streamer request latency, interrupted responses,
first-byte latency, work stages and process resources. It uses the existing Redis
service. `/api/admin/performance?minutes=15` returns the same data after the existing
admin authentication and authorization checks. The other supported window is 60
minutes. Responses are private and never HTTP-cached.

Request measurement starts before body parsing, authentication and rate limiting.
Each response is counted once on completion or premature close. A response that
sent HTTP 200 and then disconnected is reported as interrupted. Completion means
Node handed the response to the operating system; it does not prove client receipt.
First-byte timing measures the first response headers, including explicit header
flushes. Byte counts measure encoded response body writes and exclude HTTP headers.

## Latency and diagnosis

The latency histograms use millisecond boundaries of 10, 50, 100, 250, 500, 1000,
2500, 5000, 10000, 30000 and 60000, plus an overflow bucket. Displayed p95 and p99
values are bucket upper bounds, not exact percentiles. No samples or a percentile
above 60 seconds produces `null`; the UI distinguishes these cases using count.
Downloads include body transfer time, so compare their first-byte and total latency
before treating a long transfer as slow processing.

Slow requests produce structured warning logs above one second for ordinary API
calls and above ten seconds for file, website and streamer transfers. Interrupted
requests also produce warnings. These thresholds identify requests for diagnosis;
they do not automatically page anyone. Healthcheck timings are counted separately
and successful healthchecks do not produce access logs.

Logs contain a generated request ID, a fixed route label, method, status, terminal
outcome, duration, first-byte time, body bytes and work stages. API calls forward
the request ID to streamers. Repository IDs, source names, file paths, bodies and
query values are absent from these new request records and metric labels.

Stages include repository lookup, authorization, GitHub requests, source-cache
lookup and fill, worker admission, worker anonymization and streamer response
headers. Source and transformed-cache hits and misses are counted separately.
Stages can overlap and must not be summed to reconstruct total latency. An archive
upstream span also includes downstream backpressure; it is not pure network time.
Work outside HTTP requests, such as background download jobs, stays in the existing
queue monitoring rather than these request histograms.

## Resources, retention and overhead

Each process batches at most 512 metric groups every 15 seconds. Minute counters
expire after two hours and survive application rollouts. Read windows are restricted
to 15 or 60 minutes, with a ten-second cache and at most 32 live instances. Redis
commands have a two-second monitoring deadline and offline command queuing is
disabled. Monitoring never awaits Redis from an HTTP request handler, except the
admin report itself. Failures discard a bounded batch and show unavailable reports
or dropped-batch counters instead of silently implying healthy coverage.

Samples include process RSS, heap, external buffers, CPU usage, cgroup memory
limit, event-loop p95 and maximum delay, active requests, PID-owned sockets and
CLOSE_WAIT states, and worker activity, queue and byte reservations. Samples expire
after 90 seconds. The UI highlights samples older than 45 seconds, dropped metrics,
CLOSE_WAIT, event-loop p95 above 100 ms and RSS above 80 percent of its limit.
CPU usage is relative to one CPU and can exceed 100 percent across multiple cores.
RSS is process memory, not Docker's accounting of the entire cgroup.

A bounded runtime history keeps 240 API samples and 960 streamer samples, enough
for roughly one hour at one API and four streamers. The response includes this
history and the UI shows each live process's peak observed RSS in the selected
window. Additional replicas or rollout overlap shorten the history. Retired
processes disappear from the live table while retained request counters and
resource history remain available. Missing samples do not establish health.

Application Docker logs rotate at 25 MB with four files per container. The admin
overview's disk check runs asynchronously and caches its result for 30 seconds.
These settings avoid making monitoring itself block the Node event loop or fill
the host disk with unbounded access logs.

## Performance changes

ZIP HEAD requests check repository access and download permission, then return
headers without requesting a token, counting a view or generating an archive.
File and website HEAD requests validate metadata and content gates before ending
without content download or transformation. File validators accept weak and
multiple If-None-Match values using Express freshness handling.

Website responses use private, revalidated ETags covering content SHA, commit,
tree generation, cache revision, file path, rendering version and current options.
Validation follows repository lifecycle, page settings and content checks. Matching
validators avoid fetching and rendering content again; changed terms or content
invalidate them.
