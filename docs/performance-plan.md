# Anonymous GitHub performance remediation plan

Status: all fourteen fixes implemented. Local test and measurement results follow. Deployment validation remains outstanding.

The implementation removes repeated request work, coordinates shared cache fills, bounds retained resources, and moves large anonymization jobs into a worker pipeline. The phase descriptions below retain the original implementation plan. Preserve anonymization output, authorization checks, repository lifecycle rules, and existing content APIs throughout.

The fourteen IDs below cover the eight initial findings and six follow-up findings. The incidental synchronous disk-usage check is outside this fourteen-item scope.

## Implementation and local results, 7 October 2026

Baseline revision: `a7e3826`. Tests and CPU measurements used Node `v24.14.1`. Measurements are saved in [performance-results.json](performance-results.json). Unrelated working-tree files and configuration were preserved.

| Finding | Implemented behavior | Local evidence |
| --- | --- | --- |
| F01 | Search mapped names and directories once, with a 500-result cap. Store JavaScript-lowercased search fields to preserve Unicode behavior. | The 10,000-file CPU fixture fell from 22,445 ms to 0.32 ms. The 100,000-file capped fixture took 0.38 ms. Database Unicode parity is covered. |
| F02 | Spool text above 256 KiB; use a bounded worker queue, estimated byte admission, deadlines and cancellation. Cache complete transformed outputs by content and all settings. Drain ZIP output before admitting another entry. | Four 48 MiB responses finished in 10.56 s at 555 MiB peak RSS, with 11.6 ms event-loop p95. A 100 MiB input peaked at 641 MiB. The slow-client ZIP fixture retained one transformer and zero queued output MiB. Worker parity, settings edits, failure recovery and spool cleanup are tested. |
| F03 | Compile path rules once; build separate indexed mapping generations in 250-row batches. Activate mappings conditionally and invalidate after settings, tree or recovered-file changes. Exact original paths retain priority. | Compile-once matching improved 56 times on 10,000 paths. An exact MongoDB lookup examined one document. Collision, invalidation, overlapping builder and failed-refresh tests pass. |
| F04 | Destroy response upstreams and transformations on disconnect, completion and error. Shared cache producers finish independently of a subscriber. | Terminal-event regression checks and existing stream/ZIP error tests pass. |
| F05 | Release editor-specific listeners on unmount; register explorer dark-mode handling once. | Ten code navigations retained one hash listener; replacing the editor retained zero. Existing anchor and navigation tests pass. |
| F06 | Add GitHub-ID membership and generation-aware file indexes. Quota queries select owned, ready, unexpired repository metadata and cache valid zero counts. | Membership plans over 2,000 unrelated repositories avoided collection scans and examined fewer than ten documents. Replacement-tree quota tests pass. |
| F07 | Reuse bounded S3 client profiles and connection pools. Warm reads reuse one metadata check. Reject undersized uploads before publication. | The AWS SDK protocol fixture observes one HEAD and one GET on a warm hit, reused clients, and no committed short object. |
| F08 | Share current statistics and history cache misses locally and through Redis; bound history keys and handle zero, failure and UTC history rollover. | Concurrent stat/history calls make one calculation; retry and day-range tests pass. Daily snapshots retain their fresh calculation behavior. |
| F09 | Coordinate cache misses with renewable Redis leases and independent follower streams; publish verified immutable generation paths. Bound lease waits and Redis command timeouts. | Ten callers across two child processes make one producer download. Lease-expiry recovery and partial-upload rejection pass. |
| F10 | Add globally filtered and sorted dashboard summaries with cursor pagination. Exclude PR/gist bodies and reconcile private project names through a bounded backfill. | MongoDB tests combine types without duplicate pages and exclude megabyte bodies. The browser loads 50 rows, then 100, and finds project 149 with a global count of 150. |
| F11 | Request a recursive root tree first; retain bounded subdivision when GitHub truncates it. | A complete twenty-folder fixture uses one request; truncated listings retain their files. |
| F12 | Enforce expiration logically in reads; claim physical repository cleanup with renewable MongoDB leases and generation predicates. Drain the persisted backlog from nonoverlapping maintenance runs, with up to ten repository cleanups at once. | Reading 100 expired projects performs no physical cleanup. Concurrent cleanup, restoration and stale-generation tests pass. |
| F13 | Cache raw queue snapshots by the three supported queues; apply arbitrary searches after loading the snapshot. | One thousand search terms reuse the snapshot; a controlled clock confirms reload after expiration. |
| F14 | Keep at most six PDF page canvases near the viewport and at most two render tasks. Cancel and release distant or obsolete pages. | The 100-page browser fixture retained at most two canvases during the tested jumps, about 33 MiB of backing pixels. Zoom to 125 percent worked. PDF lifecycle UI tests pass. |

The cleanup implementation uses MongoDB's persisted `expiring` records as its durable backlog, rather than adding a BullMQ expiration queue. The existing maintenance runner supplies bounded background execution and retries. Request reads do not depend on enqueueing Redis jobs. GitHub content lives under immutable lifecycle prefixes, and tree replacements preserve the old active tree until the new generation activates.

The worker defaults are `ANONYMIZATION_WORKERS=1` and `ANONYMIZATION_MEMORY_MB=512`. The pool estimates each admitted job as 64 MiB plus four times its input bytes, retains at most sixteen queued jobs, and terminates workers after large jobs. Spool reservations are capped at twice the configured budget. This admission budget is not a hard process RSS cap. Keep container memory monitoring enabled when tuning concurrency or replacements that expand content.

Transformed output has a one-hour TTL, a 128-entry limit and a 512 MiB disk budget; entries larger than 128 MiB bypass that cache. Temporary inputs use private directories, cleanup on cancellation, and periodic removal of hour-old crash leftovers. Redis connection and command failures fall back to bounded local work. Request authorization remains independent of cache reuse.

The isolated CPU search fixture starts with pre-anonymized rows and excludes database, anonymization and HTTP latency. It demonstrates removal of the quadratic scan and early stopping. Arbitrary substring search still scans the current repository's derived mapping; a normal MongoDB index does not accelerate those substrings. Path indexes build lazily, so first access can cost more than a warm lookup.

The PR review follow-up fixes forced conference expiration for every active repository status, persists completion for empty tree generations, preserves permanent GitHub download error statuses, suppresses duplicate initial dashboard loads, and restores commit metadata in dashboard summaries. Twelve new regression cases cover these behaviors; the existing mixed-dashboard database test also checks the returned commit.

The second review follow-up makes gist and PR expiration a single conditional write that revalidates lifecycle and expiration settings before clearing embedded content. Maintenance indexes cover repository, gist and PR expiration scans and repository inactivity scans. The dashboard distinguishes empty accounts from empty filtered pages and updates global attention totals as polling changes a loaded repository. Fifteen new regression cases cover these changes, including query plans and additive migration checks.

The third review follow-up preserves completed, verified cache fills after Redis heartbeat failures, removes all derived private path mappings during repository reset and removal, and invalidates builders from the retired metadata revision. Renaming a dashboard project reloads pagination and totals and rebinds the details panel to the refreshed row. Seven new regression cases cover Redis restart and timeout, reset and removal, overlapping path construction, and rename sorting and filtering.

The fourth review follow-up revalidates expiration settings, lifecycle and metadata before claiming repository cleanup. Settings saves reject a concurrent cleanup claim. Expiration invalidates path builders and deletes every derived mapping generation. Polled repository status changes reload dashboard summaries and discard stale appended pages. Ten new regression cases cover both directions of the settings/cleanup race, complete path deletion, overlapping expiration and indexing, and status-sorted and filtered pagination, including later polls after a repository leaves the loaded page.

The fifth review follow-up records retired file generations atomically with activation and retries their deletion through indexed, bounded maintenance. Expiration removes the full storage root and every file generation, including ZIP directories and legacy data. Recovered files retain a pending-invalidation marker until path and quota invalidation succeeds; failed invalidation propagates, and a later lookup or maintenance retries it. Nine new MongoDB regressions cover interrupted retirement, root deletion and isolation, changed cleanup claims, indexed recovery scans, failed invalidation and obsolete recoveries. The additive migration creates the sparse retirement index and partial pending-invalidation index.

The sixth review follow-up records retired content-cache prefixes with tree activation and retries storage deletion before clearing the durable work. A retirement marker prevents an older producer from leaving output behind after cleanup. The migration queues legacy stream-cache cleanup once; filesystem directory iteration and paginated S3 bulk deletion preserve managed caches, ZIP source roots and other repositories. Five new regressions cover interrupted storage cleanup, legacy directories, more than 1,000 S3 objects, and producers starting or finishing after retirement. Existing migration and query-plan tests verify the new indexes and backfill.

The seventh review follow-up activates truncation folders atomically with the new file tree, including clearing an older list when the replacement is complete. A failure during later quota computation cannot disable missing-file recovery for the active tree. Repository, gist and PR expiration reads update local state only after a successful claim; a missed claim reloads current settings, lifecycle and content. Eleven new MongoDB regressions cover interrupted activation, recovered and untruncated paths, concurrent expiration extensions, terminal and preparing states, deletion, and cleanup using the successful claim on the same instance. The existing overlapping-tree test also verifies that a later size write preserves the newer tree’s truncation folders.

The eighth review follow-up revalidates the persisted repository lifecycle and captured content generation before a cold GitHub download and after storage publication. This fence survives expiration deleting the root and its retirement markers; late publishers remove their own output. Warm hits retain one metadata lookup without an added lifecycle query. Five new regressions cover held filesystem and S3 writes across root deletion, inactive or deleted records, replacement generations, and the warm fast path.

The ninth review follow-up registers renewable staged-tree leases before inserting rows and marks staged files for indexed recovery, including inserts that finish after a lease was retired. Maintenance preserves live builders and active trees and retries interrupted completion. API and streamer startup now clean stale text spools and transformed caches, with independent, nonoverlapping scans every sixty seconds while idle. Transformed entries record their repository, content generation and cache revision; reset, removal and expiration purge local copies and fence late publishers. Connected replicas remove obsolete entries on their next scan, independently of new writes. Raw fills use the same reset revision. Streamers wait for MongoDB before serving, cap each MongoDB pool at ten connections and exit on startup failure. Nineteen new regressions cover crashes, late inserts and writes, generation retirement, cache isolation, idle cleanup across processes, startup gating and failure. The clean full run exercises compiled streamer code against disposable MongoDB. TTL and disk-budget pruning finish even when a repository lifecycle lookup fails; the scan reports the deferred failure and retries lifecycle validation later. The additive migration installs sparse staged-lease and partial staged-file indexes.

## Reproduce and deploy

Run `npm run build`, `npm run lint`, and `npm test`. On 8 October 2026, a clean committed checkout passed build, lint and the full suite: 944 passing, 51 pending, and no failures, with disposable MongoDB and Redis enabled. The streamer startup, lifecycle and idle-cleanup tests used compiled application code in separate processes. This run used temporary memory-backed database and spool storage after local disk I/O stalls caused integration connection and large-file deadline failures. Lint reports seven existing warnings. The full suite includes the dashboard UI regressions; both focused rename tests and five status-polling UI tests also passed. An earlier working-tree run included unrelated untracked runtime tests with two pre-existing missing-export failures; those files are excluded from this PR. The clean run includes the final generation guards for file counts and readiness.

The full run includes all 94 focused performance tests with disposable MongoDB and Redis. Run them separately with `npm run test:performance`. To include database and cross-process lease checks, set `PERFORMANCE_MONGO_URI` to a disposable MongoDB database named `perf_test_*`, and `PERFORMANCE_REDIS_PORT` to a disposable Redis port. The MongoDB suite drops its test database afterward. The S3 tests use a local HTTP protocol fixture by default; set `PERFORMANCE_S3_ENDPOINT` to test a disposable compatible service instead.

Run `npm run benchmark:performance` for CPU comparisons. Add `-- --memory-only` for four 48 MiB worker responses. Set `PERF_FILE_MIB=100 PERF_CONCURRENCY=1` for the limit-sized fixture. `node scripts/performance-browser.js` serves code, a 100-page PDF and 150 dashboard summaries on port 4175 for collaborative-browser checks.

Before deploying the readers, run `npm run migrate:performance` with the application's database environment. This adds the membership, file-generation, mapping, private-name, maintenance and cleanup-recovery indexes; it never drops indexes. It also queues legacy stream-cache cleanup once. Maintenance preserves managed content caches and ZIP source roots. Rerun it if you applied the migration before the cleanup-recovery indexes were added. The command passed twice against the disposable MongoDB fixture and retained existing indexes. Deploy the compiled worker file with the application build. Source-mode workers use ts-node and have additional startup cost.

Production rollout still needs latency percentiles under the real mixed workload, cleanup-backlog observation, and real S3 multipart/network-failure checks. The local S3 fixture exercises SDK requests and short-upload publication but does not emulate all service failure modes. No deployment or production data changes were performed.

## Baseline and implementation rules

1. Preserve the existing working-tree changes and record the exact revision and environment used for comparisons.
2. Move the useful local review probes into a reproducible benchmark script and retain their fixtures. Use medians from repeated runs on the same hardware. Run benchmarks with a deadline; do not repeat the quadratic implementation at 100,000 files.
3. Add meaningful regression tests alongside each behavior change. Use disposable MongoDB, Redis, and S3-compatible fixtures for query plans, cross-process coordination, and storage behavior. Browser memory checks require the collaborative browser.
4. Capture API p50 and p95 latency, event-loop delay, RSS, active upstream requests, cache producers, queue depth, and MongoDB documents examined. Keep credentials and original private paths out of metric labels.
5. Use the current anonymization tests as the compatibility oracle. Preserve arbitrary-regex boundaries, Unicode and encoding behavior, setting changes, ETags, GitHub access revocation, truncated trees, and failure responses. Never return partial anonymization after a timeout.
6. Performance numbers below are proposed acceptance targets for local fixtures, not production latency promises. Set deployment latency and memory budgets from a realistic baseline before rollout.

## Finding coverage

| Finding | Problem | Phase |
| --- | --- | --- |
| F01 | Remove quadratic file search | 1 |
| F02 | Bound anonymization memory and move CPU work off request threads | 6 |
| F03 | Compile path terms once and index anonymized paths | 1 |
| F04 | Cancel disconnected proxy requests | 3 |
| F05 | Dispose explorer handlers per editor | 5 |
| F06 | Index dashboard membership and narrow quota queries | 2 |
| F07 | Reuse S3 clients and metadata | 3 |
| F08 | Share statistics computations and cache misses | 4 |
| F09 | Deduplicate file cache fills across replicas | 3 |
| F10 | Return paginated dashboard summaries | 2 |
| F11 | Fetch complete GitHub trees in one request | 4 |
| F12 | Move expiration cleanup out of reads | 2 |
| F13 | Bound admin queue cache retention | 4 |
| F14 | Recycle PDF canvases and bound rendering | 5 |

## Implementation phases

### Phase 1 Fix search and path resolution

Start after baseline capture. Compile-once and linear search can ship before the derived-path migration; complete this phase after generation-safe indexed lookup is validated.

#### F01 Remove quadratic file search

Affected files: src/server/routes/repository-public.ts and src/core/Repository.ts.

Check each file name and its own ancestor path segments, then stop at the 500-result limit. Fetch only required fields through a bounded cursor. Search versioned anonymized names and paths once F03 provides the mapping; preserve substring matching rather than assuming a normal MongoDB index accelerates arbitrary substrings.

Acceptance: Compare results against the existing behavior for names, ancestor folders, custom masks, Unicode, and the result cap. Benchmark 1,000, 5,000, and 10,000 files with many matching folders. Target at least a 50-fold reduction in isolated CPU time at 10,000 files; check the new implementation at 100,000 files with a time limit.

#### F03 Compile path terms once and index anonymized paths

Affected files: src/core/AnonymizedFile.ts, src/core/anonymize-utils.ts, file models and preparation workers.

First reuse one compiled term set per lookup and project only candidate fields. Add a separate derived mapping keyed by repository, tree generation, and ordered-term hash plus matcher version. Index exact anonymized path lookup. Build new generations separately, activate them atomically, and invalidate on settings changes and refreshes. Define collision behavior explicitly and retain a bounded fallback during backfill.

Acceptance: Require identical original-file resolution for default masks, custom replacements, Unicode, missing files, and truncated-tree recovery. Test colliding paths and concurrent settings edits. Target at least a 10-fold improvement in the 10,000-candidate probe before indexing; indexed lookup must avoid loading the repository's complete file list.

### Phase 2 Make dashboard reads small and predictable

Independent of phase 1. Deploy indexes and durable cleanup support before switching the dashboard summary endpoint and frontend pagination.

#### F06 Index dashboard membership and narrow quota queries

Affected files: src/core/User.ts, anonymized repository schema and src/server/routes/user.ts.

Inspect deployed indexes and execution plans. Add the missing coauthors.githubId index through an explicit migration while keeping owner and legacy username membership queries covered. Query only owned repositories and quota fields for quota calculation, rather than loading coauthored repositories and filtering afterward.

Acceptance: Use a disposable MongoDB fixture with many unrelated repositories. Verify owner, GitHub-ID coauthor, legacy coauthor, and quota results. Confirm selective membership queries avoid collection scans and inspect examined-document counts. Do not drop existing indexes without workload evidence.

#### F10 Return paginated dashboard summaries

Affected files: src/server/routes/user.ts, src/core/User.ts, public/script/app.js and dashboard templates.

Introduce a dashboard summary contract with explicit MongoDB projections and lean results. Return only row metadata; exclude PR diffs, comment bodies, and gist file contents. Support server filtering, stable sorting, and cursor pagination across resource types. Keep counts and quota over the complete authorized set. Switch the dashboard to this contract while retaining content and editor API contracts.

Acceptance: Make summary payload size independent of embedded artifact size. Test large PR and gist bodies, mixed resource types, project names, actions, global counts, and page boundaries without duplicates or missing rows. Validate saved filters and frontend interactions.

#### F12 Move expiration cleanup out of reads

Affected files: src/core/User.ts, src/core/Conference.ts, route checks, src/server/schedule.ts and queue processes.

Separate the logical expiration decision from physical deletion. Enforce expired access immediately, claim cleanup durably, and enqueue one idempotent cleanup job per repository generation. Let workers perform database and storage deletion with bounded concurrency. Make dashboard and conference reads return without waiting for deletion. Recover interrupted jobs and prevent old cleanup jobs deleting a restored generation.

Acceptance: The 100-expired-repository read probe must perform no inline physical cleanup. Test concurrent reads, worker retries, queue failure, restart recovery, restore-versus-cleanup races, and access denial throughout cleanup. Extend existing lifecycle and refresh tests.

### Phase 3 Coordinate downloads and release resources

The cancellation fix can ship first. Agree on generation and publication ownership before shared fills; S3 reuse can ship separately.

#### F04 Cancel disconnected proxy requests

Affected files: src/core/AnonymizedFile.ts, src/server/routes/repository-public.ts and src/streamer/route.ts.

Tie upstream requests, transformations, and response listeners to request completion and cancellation. Destroy the proxy's upstream request on premature client disconnect and remove listeners on every terminal path. Cover file and archive proxies. Distinguish subscriber cancellation from an intentional shared cache fill managed by F09.

Acceptance: Reproduce a client closing before headers, during a body, and during an upstream error. Require released sockets and streams, no late writes, no unhandled errors, and normal completion for another subscriber to a shared fill.

#### F09 Deduplicate file cache fills across replicas

Affected files: src/core/source/GitHubStream.ts, storage adapters and Redis coordination.

Use a lease keyed by repository, content generation, commit, and original path. One producer downloads and atomically publishes a verified cache entry; followers wait for publication and open independent readable streams. Use lease renewal and ownership checks, bounded waits, and crash recovery. Keep current access checks for every caller. Make refresh, revocation, and deletion invalidate old publication rights.

Acceptance: Ten simultaneous misses must cause one producer download and one successful publication, including across two streamer instances. Test producer crashes, failed and partial downloads, lease expiry, follower disconnect, refresh races, and both filesystem and S3 storage. Never share one Readable directly between responses.

#### F07 Reuse S3 clients and metadata

Affected files: src/core/storage/S3.ts and src/core/source/GitHubStream.ts.

Reuse a bounded set of S3 clients and HTTP connection pools instead of constructing a client per operation. Preserve operation-specific timeouts and cancellation. Return existence and size from one metadata lookup and reuse it for cache validation. Keep multipart uploads and incomplete-write protection intact.

Acceptance: A sized warm-cache hit must use one HEAD and one GET with reused clients. Verify missing objects, directories, undersized cache entries, LFS size differences, timeouts, disconnects, and multipart failures through an S3-compatible integration fixture.

### Phase 4 Reduce repeated metadata work

Independent of the dashboard changes. Keep statistics, tree traversal, and admin caching as separate reviewable changes.

#### F08 Share statistics computations and cache misses

Affected files: src/server/index.ts and src/server/dailyStatsSnapshot.ts.

Use one statistics provider for current totals, history, and snapshots. Coalesce in-flight calculations within a process and use Redis coordination for replicas. Preserve the current freshness policy, treat zero counts as valid, and bound cache entries for history ranges. Include the UTC date in history validity. Clear failed in-flight computations so later requests can retry.

Acceptance: Concurrent stat and history requests must trigger one shared calculation per cache generation. Test zero repositories, different day ranges, UTC rollover, Redis failure, calculation failure, retry, and expiry. Confirm history and snapshot totals remain consistent.

#### F11 Fetch complete GitHub trees in one request

Affected files: src/core/source/GitHubStream.ts.

Try a recursive root tree request first. When complete, convert and persist it directly. If truncated, use the existing shallow-tree subdivision with bounded GitHub concurrency, progress reporting, and truncated-folder recovery. Preserve authentication renewal and rate-limit handling.

Acceptance: The complete twenty-folder fixture must require one tree call. Compare file listings and metadata for complete and truncated roots, nested truncation, empty repositories, missing commits, and rate-limit delays. The fallback must neither lose nor duplicate entries.

#### F13 Bound admin queue cache retention

Affected files: src/server/routes/admin.ts.

Cache bounded queue snapshots by queue and supported state parameters, then apply search filtering to the snapshot. Remove arbitrary search text from persistent cache keys. Add maximum entries and explicit expiry eviction to any remaining query cache, and coalesce snapshot loads.

Acceptance: Run thousands of distinct searches with a controlled clock. Retained entries and memory must remain bounded, expired snapshots must be released, and fresh results must match existing filtering and ordering. Test snapshot fetch failures and retries.

### Phase 5 Bound browser resource use

Independent of backend phases. Validate listeners and PDF resource recycling separately.

#### F05 Dispose explorer handlers per editor

Affected files: public/script/app.js, public/script/state.js and public/script/components.js.

Register dark-mode handling once per explorer page. Give each editor its own listener cleanup and invoke it when the editor is replaced or unmounted. Release hash-change callbacks that capture old editors. Keep page disposal idempotent.

Acceptance: Opening ten code files must retain at most one handler of each relevant kind for the active editor or page. Require zero handlers after disposal. Verify line anchors, gutter selection, dark-mode changes, and navigation into non-code viewers.

#### F14 Recycle PDF canvases and bound rendering

Affected files: public/script/pdf-viewer.js.

Retain canvases only in a bounded window around the visible pages. Replace distant canvases with placeholders of the measured dimensions, cancel obsolete render tasks, and limit simultaneous page rendering. Release PDF page resources when safe and retain document-level teardown.

Acceptance: Scroll a long PDF end to end and back; live canvases must stay within the configured window and graphics memory must stabilize. Test high-DPI screens, zoom, page jumps, resize, late render completion, and document replacement. Use a real browser for layout and memory checks.

### Phase 6 Rework large text and archive processing

Use phase 3 cancellation and publication rules. Validate the worker and memory design before enabling it, then introduce derived-output caching.

#### F02 Bound anonymization memory and move CPU work off request threads

Affected files: src/core/anonymize-utils.ts, src/core/zipStream.ts, streamer processes, configuration and Compose limits.

Retain complete-text semantics for arbitrary regular expressions and Unicode. Spool large text input to bounded temporary storage, admit jobs through a byte-budgeted worker pool, and publish complete verified output atomically before serving it through backpressure-aware streams. Reuse derived output keyed by content generation and the complete options hash plus matcher version. Keep access validation independent of cache reuse. Bound pending ZIP entries and transformed bytes, retain existing file limits and execution deadlines, and clean temporary files on cancellation or crash.

Acceptance: Require byte-for-byte parity with existing anonymization fixtures, including cross-chunk matches, Unicode, URLs, binary passthrough, custom replacements, and fail-closed timeout behavior. Repeat four 48 MiB responses, near-limit inputs, match-heavy files, and slow-client archives under streamer container limits. Reserved and active work must stay within the configured memory budget; large transformations must not synchronously occupy the HTTP event loop.

## Dependencies and delivery

- Agree on repository content and settings generations before implementing F03, F09, F12, and F02. Use the existing lifecycle and access revisions where possible, and specify which events invalidate derived data.
- Build derived indexes and caches additively. Backfill in bounded batches, activate a generation only when complete, and keep an authorized fallback for legacy records. Define collision handling before adding a uniqueness constraint.
- Split database migrations, new endpoint contracts, backend work, and frontend switches into reviewable changes. Each pull request must identify the finding IDs it closes, show relevant tests, and include before/after measurements when performance is its purpose.
- Phases 1 through 5 contain independently deliverable changes. Phase 6 follows shared-stream cancellation and publication work. Do not delay the search, payload, or listener fixes until the anonymization redesign is complete.

## Validation and rollout

For each change, run the relevant existing and new tests, TypeScript checks, and lint. Build the frontend and run the UI regression suite when scripts or templates change. Run the complete suite at integration milestones, not after every documentation or isolated adjustment.

Deploy additive indexes and worker support before switching readers. Introduce flags for the dashboard contract, derived-path lookup, shared fills, and worker anonymization where rollback requires choosing an older implementation. Canary backend behavior and watch latency, RSS, producer counts, error rates, and cleanup backlog.

Exercise concurrent settings edits, refreshes, removal, restoration, and access revocation during the canary. A request or worker from an older generation must not publish over a replacement generation. Queue and Redis failures must remain retryable without unlimited duplicate work or silent partial output.

Rollback must preserve schema compatibility and repository lifecycle safety. Retire the older direct anonymization path after byte-parity, cancellation, and memory validation; do not automatically bypass a required memory budget when a worker fails.

The plan is complete when all fourteen acceptance checks pass, the mixed-workload run stays within agreed memory and latency budgets, and the deployment records no regressions in anonymization or access behavior. Close each finding only after its implementation and validation are complete.
