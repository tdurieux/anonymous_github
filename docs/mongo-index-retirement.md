# Retire redundant file indexes

The November 11 audit found no query use of `path_1`, `path_1_repoId_1`, or
`repoIDAndPath` since the Mongo restart on November 8. Together they occupied
3.17 GiB. This observation is a retirement candidate list, not proof that every
infrequent workload is covered.

Deploy the updated application first so Mongoose no longer recreates the old
path indexes. The existing additive index migration does not drop indexes.
Then run these commands in the application environment:

```sh
node build/scripts/retire-file-indexes.js status
node build/scripts/retire-file-indexes.js hide
```

Observe at least one full traffic/maintenance cycle, including ZIP reads,
legacy snapshots, path searches, tree cleanup and refreshes. Compare slow-query
plans and latency with the pre-hide baseline. Hidden indexes still consume
storage and incur write maintenance; hiding alone does not reclaim space.

If queries regress, restore visibility immediately:

```sh
node build/scripts/retire-file-indexes.js restore
```

Only after the observation period is satisfactory, reclaim the storage:

```sh
node build/scripts/retire-file-indexes.js drop
```

The script accepts only the three audited index definitions, rejects unique,
TTL, partial, sparse or collated variants, requires the generation/path index
to be visible and ready, and refuses to drop candidates that are not hidden.
It never removes the unique or TTL indexes used by other collections. A dropped
index cannot be restored with `restore`; it must be rebuilt from its original
key definition. Keep the pre-hide baseline and observation results with the
operator's deployment record.
