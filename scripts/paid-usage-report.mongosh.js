/* global db, print */
// Read-only: run with mongosh connected to the application database.
// Only aggregate counts leave this process. No file-content collection is read.
const now = new Date();
const users = new Map(), github = new Map(), usernames = new Map();
db.users.find({}, { _id: 1, externalIDs: 1, username: 1 }).maxTimeMS(60000).forEach(u => {
  const id = String(u._id);
  users.set(id, true);
  if (u.externalIDs?.github) github.set(String(u.externalIDs.github), id);
  if (u.username) usernames.set(u.username, id);
});
const states = {};
const active = new Map(), reserved = new Map();
function add(map, r) {
  const id = String(r.owner);
  if (!map.has(id)) map.set(id, { count: 0, bytes: 0, measured: 0, collaborators: new Set() });
  const a = map.get(id);
  a.count++;
  a.bytes += r.size?.storage || 0;
  if (r.sizeComputedAt) a.measured++;
  for (const c of r.coauthors || []) {
    const user = c.githubId ? github.get(String(c.githubId)) : usernames.get(c.username);
    if (user && user !== id) a.collaborators.add(user);
  }
}
let shared = 0;
db.anonymizedrepositories.find({}, { owner: 1, status: 1, options: 1, size: 1, sizeComputedAt: 1, coauthors: 1 }).maxTimeMS(60000).forEach(r => {
  states[r.status] = (states[r.status] || 0) + 1;
  if (!["removed", "expired"].includes(r.status)) add(reserved, r);
  if (r.status === "ready" && (r.options?.expirationMode === "never" || !r.options?.expirationDate || r.options.expirationDate > now)) {
    add(active, r);
    if (r.coauthors?.length) shared++;
  }
});
function summarize(map) {
  const entries = [...map.values()], counts = entries.map(x => x.count).sort((a,b) => a-b);
  const percentile = p => counts[Math.max(0, Math.ceil(counts.length*p)-1)] || 0;
  return {
    owners: map.size, registeredOwners: [...map.keys()].filter(id => users.has(id)).length,
    repositories: counts.reduce((a,b) => a+b, 0),
    withSizeComputedAt: entries.reduce((a,b) => a+b.measured, 0),
    buckets: [1,2,3,5,10,20,Infinity].map((max,i,ends) => ({max: Number.isFinite(max) ? max : "above20", owners: counts.filter(n => n > (ends[i-1] || 0) && n <= max).length})),
    percentiles: {p50:percentile(.5),p90:percentile(.9),p95:percentile(.95),p99:percentile(.99),max:counts.at(-1)},
    countLimits: [3,5,10,20].map(limit => ({limit, atOrAbove:entries.filter(x=>x.count>=limit).length, above:entries.filter(x=>x.count>limit).length,
      coauthorsOfOwnersAbove:new Set(entries.filter(x=>x.count>limit).flatMap(x=>[...x.collaborators])).size})),
    storageLimits: [.5,1,2,5].map(gib => ({gib, above:entries.filter(x=>x.bytes>gib*1024**3).length})),
    aboveTenOrTwoGiB: entries.filter(x=>x.count>10 || x.bytes>2*1024**3).length,
    coauthorsOfOwnersAboveTenOrTwoGiB: new Set(entries.filter(x=>x.count>10 || x.bytes>2*1024**3).flatMap(x=>[...x.collaborators])).size,
    coauthorsOfOwnersAtTen: new Set(entries.filter(x=>x.count>=10).flatMap(x=>[...x.collaborators])).size,
    distinctCoauthors:new Set(entries.flatMap(x=>[...x.collaborators])).size
  };
}
print(JSON.stringify({asOf:now, registeredAccounts:users.size, statuses:states, activeSharedRepositories:shared, active:summarize(active), initialReservations:summarize(reserved)}, null, 2));
