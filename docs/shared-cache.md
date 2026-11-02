# Shared blob cache

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

Logical user quotas remain based on repository file sizes. Shared-pool deduplication,
compression and eviction do not change user quota usage.

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

Transient SQLite write contention bypasses caching instead of failing file requests.
Publication installs a reader lease before releasing its transaction, including
duplicate blobs. Decisions retain sniffed text classification for consistent MIME
headers on repeat reads; binary responses omit the range-denial header.

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
mkdir -p benchmark-results/cache
node scripts/cache-workload.js benchmark-results/cache/workload.json
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

### Metadata durability and accounting

Reader leases, access history, decisions and telemetry use NORMAL WAL commits.
Reservations, publication intent and final blob publication use FULL commits;
payloads are synced before rename. Recent disposable metadata may be lost after
system failure. Recovery retains reservations until orphan files are removed or
accounted for. SIGKILL recovery is tested; physical power failure is not simulated.

Admin statistics use transactional counters and an indexed oldest-access lookup.
History and decisions are capped at 100,000 rows each, aliases at 200,000. Expired
history/decision cleanup removes at most 256 rows per pass. Access history has
30-second resolution. Stop all cache processes before upgrading an existing index
and restart them on the same version; do not mix old and new writers.

### Performance and validation

Local synthetic measurements on Node 24.14.1, dated 2026-11-02, compared the initial
FULL-commit implementation with optimized bookkeeping. Warm serial changed-text
medians fell from 44.9 to 7.3 ms at 16 KiB, 45.9 to 9.0 ms at 256 KiB, and 60.5 to
19.0 ms at 2 MiB. At 100,000 synthetic blob rows, admin stats p95 fell from 78.7 to
0.50 ms and decision-write p95 from 45.5 to 1.11 ms.

The optimized runs verified 2,500 HTTP responses. The 4 MiB eviction probe peaked
at 3,997,696 allocated bytes. Its oversized sequential working set had no hits:
a bounded LRU cache does not guarantee useful reuse. Measurements used loopback
HTTP, warm OS caches and a shared host; they exclude production traffic, TLS,
authorization overhead and multi-process throughput. They are not capacity estimates.

On the PR checkout based on main at d0b217a, the production build, scoped lint and
199 cache, HTTP, admin access, HEAD/revalidation and Vue UI tests passed. Coverage
includes process crash recovery, concurrent fills, active readers, LFS verification,
and public submodule origins without parent credentials. Admin layout was also
checked at 1280 px and 390 px during implementation.

Generate fresh reports locally; generated output is ignored by Git:

```sh
npx tsc
node scripts/cache-index-performance.js
CACHE_BENCH_COMPILED=1 node scripts/cache-performance.js
CACHE_BENCH_COMPILED=1 node scripts/cache-performance.js benchmark-results/cache/repeat.json --shared
```

Default reports go to `benchmark-results/cache/`. Scripts also accept an explicit
output path. Keep raw measurements with the evaluation that produced them rather
than committing generated reports to the documentation directory.
