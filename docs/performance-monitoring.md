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
Source download timing includes waiting for response headers and failures before
streaming begins.
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
Raw Markdown served after a rendering failure has a separate validator, so later
requests retry rendering when the transient failure clears.

## Production failures and restarts

Run `node scripts/check-production-logs.js 15` from a machine with Node and the
Docker CLI to summarize recent application logs and container states. For a
remote Docker host, use
`DOCKER_HOST=ssh://ubuntu@host node scripts/check-production-logs.js 15`.
The optional
window is 1–1440 minutes. The report includes completed 5xx responses, interrupted
requests, token-refresh failures, missing-file warnings, native unhandled stream
errors, and Docker restart counts. It prints counts and container metadata;
request URLs, repository IDs, file paths, credentials, and Docker environment
variables are excluded. Restart counts cover the container's lifetime, while log
counts cover the selected window. Compare restart counts with the last deployment
baseline even when every container is currently healthy.

The API and streamers log `process_fatal_error` through Node's
`uncaughtExceptionMonitor`. This records fatal errors before the default process
exit; it does not resume execution or swallow uncaught exceptions. Native stderr
may describe the same crash as well, so fatal log indicators are not a count of
unique process exits. Use Docker restart counts to confirm exits.

Legacy OAuth reset requests are coalesced by owner, credential, and OAuth app.
A failed 401/404 reset backs off for 30 minutes; transient failures back off for
one minute. A replaced credential or changed OAuth configuration gets a new key.
GitHub App and personal access tokens do not use the OAuth reset endpoint. Refresh
failure leaves the credential unchanged and continues through normal token
validation and fallback.

Confirmed GitHub content 404s back off for 30 seconds in a bounded process-local
cache. The key includes repository, path, commit, blob SHA, cache generation,
revision, and credential. Permission failures and transport errors are not cached.
This reduces repeated upstream misses without changing the file tree or treating
an unavailable file as a successful cache fill. Persistent 404s still require
checking the repository's source snapshot. Application rate limits remain in
force; 429 replies now include `rate_limited`, `resetAt`, and `Retry-After` so
clients can wait for the actual store reset.

## Shared blob cache

The optional shared filesystem cache stores immutable source content across projects.
It uses Node's built-in SQLite module and requires Node 22.15 or newer. All API and
streamer processes on one host must mount the same local cache directory. SQLite
WAL is not a distributed lock service: do not put this directory on NFS or share
it across hosts. S3 storage continues to use the existing storage implementation.

Enable the integrated implementation with `SHARED_CACHE_ENABLED=true`. The default
is false so a code deployment does not silently migrate production data. The other
settings are independent rollback controls:

- `SHARED_CACHE_PATH`: defaults to `.shared-cache-v1` inside `FOLDER`.
- `SHARED_CACHE_BYTES`: source pool budget, default 10 GiB.
- `SHARED_CACHE_RESULT_BYTES`: transformed output budget, default 512 MiB.
- `SHARED_CACHE_MAX_FILE_BYTES`: maximum source admission size, default 32 MiB.
- `SHARED_CACHE_FREE_BYTES`: free-device-space reserve, default 1 GiB.
- `SHARED_CACHE_LOW_WATER`: eviction target fraction, default 0.9.
- `SHARED_CACHE_GZIP`: store gzip when beneficial, default true.
- `SHARED_CACHE_GZIP_MIN_SAVING`: minimum fractional saving, default 0.10.
- `SHARED_CACHE_DECISIONS`: enable unchanged decisions and changed-output reuse,
  default true.
- `CACHE_MONITORING_ENABLED`: collect cache observations, default true. Monitoring
  is independent of shared storage and also records legacy cache/inspection events.

These are initial limits, not capacity recommendations from the production sample.
Restart processes together when changing pool limits. Reserve headroom for SQLite,
filesystem directories, existing caches and other application temporary files.
The budget accounts for blob allocation with a conservative 4 KiB minimum plus
in-flight reservations of three times the maximum object size and a small overhead.
Keep each pool budget larger than this reservation. Admission can bypass the cache
while other fills/readers occupy the budget. Oversized source objects are streamed
without admission, still subject to the application's file-size limit.

Git blobs are verified against the requested Git SHA before publication. Resolved
LFS content is admitted only after verifying both the Git pointer and its SHA-256
payload digest and size. Gzip is a representation of the same uncompressed content.
Files are written privately, synced and atomically renamed before index publication.
Fills and readers have renewable leases. Eviction skips readers, and stale fills
are recovered before their reservations are released. LRU access timestamps are
coarsened to 30 seconds. Orphan reconciliation runs at most hourly across processes.
Alias and reuse-history indexes are bounded; decisions expire after seven days and
are capped at 100,000 entries.

Existing generation caches are read as a migration fallback and verified before
promotion. They are not deleted during promotion, so rollback remains possible.
The new pool budget does not include legacy copies: monitor total filesystem usage
and retire legacy data only after validating rollout. Uploaded ZIP originals and
other durable source material are untouched. Repository removal invalidates access
and project mappings, while shared blobs remain subject to global eviction.

The HTTP fast path applies to individual file responses backed by the shared source
pool, including small text files. Decisions include content identity, path, project
context, all transformation options, generation/revision, mask, hostname and engine
version. Unchanged decisions serve the original representation. Changed output has
its own bounded pool. Gzip negotiation honors quality values, uses `Vary`, and
preserves MIME type. File validators are weak when shared delivery is enabled so
identity and gzip representations can revalidate the same logical content. HEAD
continues to use metadata only. Range requests receive a complete response; this
implementation does not add random access into gzip files. Website rendering keeps
its renderer cache; ZIP scans do not admit bulk entries into the source blob pool.

The admin overview's Cache section reads `/api/admin/cache?minutes=60` behind the
existing admin authorization. Windows are 15 minutes, one hour, 24 hours and seven
days. SQLite telemetry batches at most 512 groups every five seconds and retains
minute aggregates for 48 hours and hourly aggregates for 30 days. No paths, terms,
user IDs or blob hashes appear in metric labels. The UI distinguishes unavailable
telemetry, dropped events, disabled storage and empty windows. Rows separate file,
website, ZIP, background and known-monitor traffic. Monitor classification is an
operational heuristic, not a complete bot detector.

Hit counts and byte hit rates measure source lookups; misses classify first observed
keys, known misses and eviction refetches within bounded seven-day history. Reuse
intervals are consecutive blob accesses, not distinct people or browser visits.
Eviction time measures idle age; codec and inspection timings are elapsed work time,
not CPU samples. Cached decisions are separate from actual inspections. Minute and
hour boundaries make the displayed windows approximate.

Run the reproducible acceptance workload with:

```sh
node scripts/cache-workload.js docs/cache-workload-results.json
npx mocha test/shared-blob-cache.test.js test/shared-cache-http.test.js
```

The JSON report asserts cross-project source reuse, unchanged-decision reuse,
changed-output reuse, gzip delivery and budget enforcement. Its compression ratio
comes from synthetic text and must not be presented as a production projection.
Production rollout should compare request/byte hit rates, eviction refetches, p95
latency, upstream errors and free disk over a representative week, with large files,
ZIP work and known monitors visible separately.

### Benefits and costs

| Choice | Benefit | Cost or limit |
| --- | --- | --- |
| Global content identity | Reuses identical files across paths and projects; renames do not duplicate content | Requires verified hashes and authorization on every request; uses digest-prefix directories to avoid one huge directory |
| Byte budget with approximate LRU | Predictable blob footprint and automatic reclamation | Evicted files incur upstream fetches; active readers can temporarily prevent admission |
| Selective gzip | Reduces payload storage and can serve compressed bytes directly | First-fill compression costs work; identity consumers and uncached anonymization require decoding |
| Rule-aware decisions and results | Repeated unchanged reads skip regex inspection; changed output is reusable | More metadata and a separate output budget; settings changes produce new decisions |
| SQLite coordination and telemetry | Cross-process coordination without another service; admin can measure actual reuse and rewrite work | Local-filesystem scope; short synchronous transactions; metadata/headroom are outside blob budgets |

### Rollout sequence

1. Deploy with shared storage disabled and collect legacy hits, inspections and codec
   timings. Keep known-monitor traffic separate from file readers.
2. Enable the shared cache on the single-host filesystem deployment with both byte
   budgets configured. Keep legacy copies for rollback.
3. Compare a representative week of byte/request hits, rewrite decisions, eviction
   refetches, request latency, upstream errors and whole-device free space. Adjust
   admission size and budgets from those observations.
4. Retire legacy cache copies only after the rollback window. Uploaded originals
   remain durable and are never candidates for shared-pool eviction.

The implementation and acceptance workload are local changes; this work does not
enable or migrate production storage.

### Production observations used for this design

The read-only audit on 2026-11-02 found 425,312 source files across 31,522 projects,
containing 144.32 GB of payload. Deduplication within projects could remove 1.87 GB;
global deduplication could remove 2.93 GB total (about 2.03%), including another
1.06 GB across projects. One file could not be read. These are decimal GB and
payload savings, not a compression estimate or the expected new working-set size.

The preceding 24-hour access sample contained 29,980 successful file-body responses,
including 9,249 repeat responses (30.9%). URL repetitions are not the same as blob
cache hits. A separate approximately two-hour metric window recorded 2,302 source
hits out of 3,600 lookups (63.9%). This supports retaining a bounded source cache;
it does not establish the optimal byte budget.

In the uniform anonymization replay, 937 resident files were measured: 764 text,
173 binary, and 21 with changed output. Thirteen resolved files exceeded the 4 MiB
sample limit, and missing files/mappings were excluded. The sample's mean gzip-6
work was 1.46 ms per file and mean decompression was 0.24 ms; these replay timings
are not live-request latency or a forecast for large files. Continuous telemetry is
needed to replace these samples with representative workload measurements.

### Local acceptance evidence

The checked-in `cache-workload-results.json` is generated by assertions, not hand
written. Five file requests across two projects needed one upstream source fill;
unchanged and changed responses reused decisions, and changed bytes occupied one
result blob. The 64 KiB eviction workload ended at 53,248 allocated bytes with no
remaining fill reservations. Compression figures describe this synthetic fixture.

Validation also covers separate operating-system producers, failed/invalid fills,
crash publication recovery, active-reader eviction protection, LFS pointer/payload
verification, gzip negotiation, rule changes, admin authorization and HEAD/304.
The disposable MongoDB/Redis performance integration run passed 130 tests. The
admin Cache section was checked at 1280 px and 390 px, including filter layout,
scrollable tables, empty filters and unavailable telemetry.

The final complete default test run recorded 1,062 passing, 159 pending and one
failure: `test/error-codes.test.js` reports nine missing frontend translations for
the pre-existing maintenance API changes. Cache tests passed in that full run.
TypeScript compilation, the scoped lint checks (existing warnings only), the UI
build and `git diff --check` passed. Production rollout was not performed.

## Initial cache performance evaluation, 2026-11-02

The initial implementation passed functional checks, but its metadata write path regressed small-file performance. The following measurements are preserved as the before-optimization baseline; the implementation and follow-up results below supersede the recommendations in this section. These are local measurements, not production capacity estimates.

### Warm changed-text responses

Each percentile pools two batches. Serial measurements contain 32 requests; concurrency-eight measurements contain 64. The small/medium baseline reads a local raw source and repeats anonymization/gzip. The 2 MiB baseline additionally uses the existing transformed-file cache, with 99 measured cache hits out of 100 requests. Authentication and Redis coordination are outside this comparison.

| File | Baseline median, ms | Current median, ms | Experimental NORMAL median, ms | Baseline p95 at 8 clients, ms | Current p95 at 8 clients, ms | NORMAL p95 at 8 clients, ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 16 KiB | 8.3 | 44.9 | 6.9 | 71.8 | 462.1 | 46.8 |
| 256 KiB | 36.5 | 45.9 | 11.7 | 250.8 | 444.1 | 89.6 |
| 2 MiB | 236.2 | 60.5 | 26.0 | 929.2 | 528.2 | 324.8 |

### Findings

- The cache hit path performs synchronous SQLite writes for reader leases, reuse history and release. The temporary-database A/B changes only pool connections to `PRAGMA synchronous=NORMAL`; the measured reduction supports commit latency as a major bottleneck. This is a diagnostic experiment, not an implemented fix.
- NORMAL in WAL mode can lose recent committed transactions following power loss or a system crash. Validate recovery/accounting before changing the durability of disposable cache indexes. See [SQLite synchronous documentation](https://www.sqlite.org/pragma.html#pragma_synchronous).
- For changed 2 MiB content at eight clients, current shared caching reduced combined client/server CPU from 253.2 to 55.6 ms per request. Peak sampled RSS was 308.0 versus 296.7 MiB. These are whole-process values, including runtime, HTTP client and worker threads.
- Synthetic text transferred about 62.2% fewer bytes with gzip. Incompressible 256 KiB binary data was stored and served as identity, avoiding ineffective gzip storage. These compression ratios are not production projections.
- Cold responses include first-use initialization. For 16 KiB changed text they took 145.9 ms in the baseline, 709.8 ms currently, and 212.0 ms in the NORMAL experiment. Do not use this single cold sample as steady-state miss latency.
- At 100,000 synthetic blob rows, a single pool stats query took 78.7 ms p95 synchronously; saving a decision took 45.5 ms p95. Cache/materialize admin aggregates and reduce retention scans on request paths. Dummy blob rows have no files, so this measures metadata scaling, not full directory reconciliation.
- A 4 MiB pool cycling sequentially over 100 distinct 64 KiB objects stayed below budget, but all 300 reads fetched again. Its working set was larger than the pool. Reuse, request order and admission policy must inform the budget; LRU alone cannot guarantee hits.

### Reproduce and limitations

Node v24.14.1, Linux, Intel Xeon E312xx (Sandy Bridge, IBRS update), 12 logical CPUs. This is a shared host with background load, warm OS page cache, loopback HTTP and a synthetic 20 ms upstream wait. It excludes real upstream bandwidth, TLS, reverse proxies, database authorization, multi-process throughput and production request distributions. Small samples and fixed scenario order mean p95 and speedup ratios are descriptive. An initial ts-node exploration was superseded by the compiled results below. The metadata probe does no worker execution, and excludes TypeScript loading from its timed samples.

```sh
npx tsc --incremental false
CACHE_BENCH_COMPILED=1 node scripts/cache-performance.js
CACHE_BENCH_COMPILED=1 node scripts/cache-performance.js docs/cache-performance-normal-results.json --normal
CACHE_BENCH_COMPILED=1 node scripts/cache-performance.js docs/cache-performance-legacy-results.json --legacy
node scripts/cache-index-performance.js
```

All 2,700 HTTP responses were checked against expected bytes or a validated wire digest. Eviction assertions passed. Raw latency samples, CPU, RSS, event-loop delay, storage and metric counters are in `cache-performance-results.json`, `cache-performance-normal-results.json`, `cache-performance-legacy-results.json` and `cache-index-performance-results.json`. `cache-performance-summary.json` contains pooled comparisons.

Before rollout: reduce per-read durable commits without weakening active-reader eviction protection; consider NORMAL only for rebuildable indexes with crash/recovery tests; replace full admin stats scans with cached aggregates; then replay a representative mixed workload with several server processes. Application defaults and production were not changed by this evaluation.


## Optimized implementation, 2026-11-02

The pool now uses NORMAL WAL commits for reader leases, coarsened access history,
anonymization decisions and telemetry. Admission reservations, publication intent
before rename, and final blob/alias publication still use FULL commits. Payload
fsync remains in place. Reader leases still become visible immediately to other
processes and protect active streams from eviction. This saves hit-path disk
flushes without making payload accounting depend on disposable history.

Recent disposable metadata and telemetry can be lost after system failure.
Reservation and publication recovery conservatively retain accounting until files
are indexed or removed; missing payload files are invalidated and fetched again.
The SIGKILL test stops an actual producer after rename and before index publication,
then verifies reservation retention, orphan cleanup and successful refill. This
tests process failure, not a physical power cut.

Admin pool statistics now read transactional counters and an indexed oldest-access
lookup. Counters are initialized once for an existing index and maintained by
SQLite triggers in the same transactions as row changes. Decision/history/alias
retention deletes only excess rows through indexes. Expired decision/history
cleanup is limited to 256 rows each per admission or maintenance pass. Access
history persists at most once per key per 30 seconds, so reuse-window boundaries
have that resolution. Metadata remains capped at 100,000 decisions/history rows
and 200,000 aliases per pool.

Stop all cache-using processes together before upgrading an existing index, then
restart them on the same version. Do not mix old and new writers during migration.
The admin API response shape is unchanged. Shared caching remains opt-in with
`SHARED_CACHE_ENABLED=true`; production configuration was not changed.

The tradeoff is intentional: cache hits avoid durable flushes, while cold fills
still pay for durable publication and compression. Trigger updates add a small
amount of write work in exchange for constant-time aggregate reads. Approximate
LRU and fixed budgets can still thrash when the working set exceeds the pool.


### Follow-up measurements and validation

All 2,200 responses in the complete optimized HTTP run and all 300 in the focused
repeat matched expected output. The repeat ran after this task's other tests and
benchmarks ended. The early scenarios in the complete run overlapped the metadata
probe, so both results are retained rather than treating the faster run as a
universal estimate. These remain small synthetic samples on a shared host.

- 16 KiB changed text: warm serial median 44.9 → 7.3 ms; eight-client p95 462.1 → 114.9 ms.
- 256 KiB changed text: warm serial median 45.9 → 9.0 ms; eight-client p95 444.1 → 107.6 ms.
- 2048 KiB changed text: warm serial median 60.5 → 19.0 ms; eight-client p95 528.2 → 216.2 ms.

At 100,000 synthetic blob rows, admin stats p95 fell from 78.70 to 0.50 ms,
decision-write p95 from 45.47 to 1.11 ms, and warm-source-hit p95 from 82.99 to
6.37 ms. The 4 MiB eviction probe peaked at 3,997,696 allocated bytes; all budget
assertions passed. Its oversized sequential working set still produced no hits.

The final full suite recorded 1,065 passing, 159 pending and the existing single
error-code translation failure (nine maintenance API codes). New counter,
durability-mode and SIGKILL recovery tests passed, as did HTTP and admin UI
regressions. TypeScript, scoped lint and diff whitespace checks passed.
Production rollout and representative multi-process throughput testing remain
outside this local evaluation.

Reproduce the follow-up without overwriting the original baselines:

```sh
npx tsc
CACHE_BENCH_COMPILED=1 node scripts/cache-performance.js docs/cache-performance-optimized-results.json
node scripts/cache-index-performance.js docs/cache-index-performance-optimized-results.json
CACHE_BENCH_COMPILED=1 node scripts/cache-performance.js docs/cache-performance-optimized-repeat-results.json --shared
```

Raw results and the pooled comparison are in the corresponding
`cache-*-optimized-*.json` files.

### PR integration validation

Reapplied the cache changes onto main at `d0b217a` in an isolated checkout.
The production build and scoped ESLint passed, and 199 cache, HTTP, admin access,
HEAD/revalidation and Vue UI tests passed. Integration also covers public
submodule origin selection and withholding parent credentials. The historical
full-workspace and benchmark measurements above were not rerun as part of this
PR preparation.
