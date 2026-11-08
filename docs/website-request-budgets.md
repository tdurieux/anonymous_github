# Website requests and folder counts

Website assets under `/w/` have a separate Redis-backed request budget. The
default `WEBSITE_RATE_LIMIT=2000` allows 2,000 requests per visitor in 15 minutes,
including signed-out visitors. Requests across repositories share this budget.
They do not consume the `/api` or `/github` allowance. Website slowdown, access
checks, file-size limits and streaming protections still apply. Rejections
include `Retry-After` and the existing JSON `rate_limited` response.

Visitor identity uses the existing trusted-proxy address resolver. Do not trust
arbitrary forwarding headers or change `TRUST_PROXY` without verifying the
actual proxy chain. API and maintenance-token rate policies are unchanged.

The explorer requests `/api/repo/:repoId/files/counts?path=…` after loading each
directory, once per directory per viewer initialization. The path is the same
anonymized path used for browsing. A response contains recursive file counts for
that directory and its immediate children, rather than a repository-wide map.
Counts use the captured active tree generation and sum anonymized child-name
collisions. Entering a colliding directory resolves the same original directory
as browsing it. No original paths are returned.

The aggregation has a two-second database deadline, allows disk spill, and
returns at most 10,000 child groups plus the parent total. It still scans files
in the requested subtree; root counts can scan the whole active tree. No
cross-request cache bypasses authorization or retains counts from old snapshots.
The legacy endpoint without `path` retains its existing bounded response.

Counts are optional. If a count request fails, the explorer continues browsing
without unavailable badges and stops issuing further count requests until the
viewer is reinitialized. It does not label the number of loaded tree entries as
the repository's total file count. File listing guards remain in place.
