#!/usr/bin/env node
'use strict';
// Offline import of one deployment's shared TypeScript telemetry database.
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { mongo: { MongoClient } } = require('mongoose');
const { lstatSync } = require('node:fs');

const names = new Set([
 'decision_hit', 'decision_miss', 'decision_bypass', 'rewrite_changed', 'rewrite_unchanged',
 'rewrite_binary', 'rewrite_changed_cached', 'rewrite_unchanged_cached', 'compress', 'decompress',
 'legacy_source_hit', 'legacy_source_miss',
 'legacy_result_hit', 'legacy_result_miss', 'source_legacy_promotion',
 'inspected_changed', 'inspected_unchanged', 'inspected_passthrough', 'inspected_binary',
 ...['source','result'].flatMap(prefix => ['hit','miss','fill','stored','fill_wait','bypass','error',
  'deduplicated','corrupt','refetch','known_miss','first_seen_miss','reuse_1h','reuse_1d','reuse_7d','eviction'].map(event => `${prefix}_${event}`)),
]);
const traffic = new Set(['file','website','zip','monitor','background']);
const fields = ['count','bytes','ms','b0','b1','b2','b3','b4','b5','b6'];
const manifestID = 'node-cache-telemetry-v1';
const refuse = code => { throw Object.assign(new Error(code), {safeCode:code}); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function integer(value) {
 if (!Number.isSafeInteger(value) || value < 0) refuse('invalid_telemetry_counter');
 return value;
}
function timestamp(value) {
 integer(value);
 if (value > 253402300799000) refuse('invalid_telemetry_timestamp');
 return value;
}
function metric(row) {
 if (![60000,3600000].includes(row.period) || timestamp(row.bucket) % row.period !== 0) refuse('invalid_telemetry_bucket');
 if (!names.has(row.name) || !traffic.has(row.traffic)) refuse('unknown_telemetry_label');
 for (const field of fields) {
  if (field === 'ms') {
   if (!Number.isFinite(row.ms) || row.ms < 0) refuse('invalid_telemetry_duration');
  } else integer(row[field]);
 }
 const retention = row.period === 60000 ? 48*3600000 : 30*86400000;
 return {_id:'node-cache:'+hash([row.period,row.bucket,row.name,row.traffic]), ...row, expires:new Date(row.bucket+retention)};
}
function health(row) {
 if (typeof row.id !== 'string' || !row.id || row.id.length > 1024) refuse('invalid_telemetry_health');
 timestamp(row.updated); integer(row.dropped);
 // Do not copy Node hostnames or PIDs to MongoDB or command output.
 return {_id:'node-cache-health:'+hash(row.id), period:0, dropped:row.dropped, expires:new Date(row.updated+30*86400000)};
}

async function migrate({db, file, apply=false, writersStopped=false, afterBatch}) {
 if (apply && !writersStopped) refuse('stop_node_writers_before_import');
 if (!lstatSync(file).isFile()) refuse('telemetry_source_must_be_regular_file');
 const source = new DatabaseSync(file, {readOnly:true});
 try {
  source.exec('PRAGMA busy_timeout=50; BEGIN');
  const metrics = source.prepare('SELECT period,bucket,name,traffic,count,bytes,ms,b0,b1,b2,b3,b4,b5,b6 FROM metrics ORDER BY period,bucket,name,traffic');
  const checks = source.prepare('SELECT id,updated,dropped FROM health ORDER BY id');
  const digest = createHash('sha256');
  let rows = 0, healthRows = 0;
  // Validate the entire consistent snapshot before making any destination writes.
  // Iterators keep memory bounded even with thirty days of history.
  for (const [statement, normalize] of [[metrics,metric],[checks,health]]) {
   for (const row of statement.iterate()) {
    const document = normalize(row);
    if (++rows > 2000000) refuse('telemetry_snapshot_too_large');
    if (document.period === 0) healthRows++;
    digest.update(JSON.stringify(document)+'\n');
   }
  }
  const fingerprint = digest.digest('hex');
  const imports = db.collection('gocacheimports');
  const prior = await imports.findOne({_id:manifestID});
  if (prior && prior.digest !== fingerprint) refuse('telemetry_snapshot_changed_since_import');
  const summary = {mode:apply?'apply':'dry-run', rows:rows-healthRows, healthRows, sourceDigest:fingerprint, alreadyComplete:prior?.state === 'complete'};
  if (!apply || summary.alreadyComplete) return summary;
  // Digest in the unique-key claim rejects competing importers with another snapshot.
  try {
   await imports.updateOne({_id:manifestID,digest:fingerprint}, {$setOnInsert:{state:'pending',createdAt:new Date()}}, {upsert:true});
  } catch (error) {
   if (error.code === 11000) refuse('telemetry_snapshot_changed_since_import');
   throw error;
  }
  const collection = db.collection('gocachemetrics');
  let batch = [];
  const flush = async () => {
   if (!batch.length) return;
   await collection.bulkWrite(batch, {ordered:false});
   batch = [];
   if (afterBatch) await afterBatch();
  };
  for (const [statement,normalize] of [[metrics,metric],[checks,health]]) {
   for (const row of statement.iterate()) {
    const document = normalize(row);
    batch.push({updateOne:{filter:{_id:document._id},update:{$setOnInsert:document},upsert:true}});
    if (batch.length === 500) await flush();
   }
  }
  await flush();
  await imports.updateOne({_id:manifestID,digest:fingerprint}, {$set:{state:'complete',finishedAt:new Date()}});
  return {...summary,complete:true};
 } finally {source.close();}
}

async function main() {
 const command = process.argv[2] || 'dry-run';
 if (!['dry-run','apply'].includes(command) || process.argv.length > 3) refuse('usage: node backend/scripts/migrate-cache-telemetry.cjs [dry-run|apply]');
 const {MONGODB_URI, MONGODB_DATABASE, CACHE_TELEMETRY_FILE} = process.env;
 if (!MONGODB_URI || !MONGODB_DATABASE || !CACHE_TELEMETRY_FILE) refuse('MONGODB_URI_MONGODB_DATABASE_CACHE_TELEMETRY_FILE_required');
 const client = new MongoClient(MONGODB_URI,{serverSelectionTimeoutMS:10000,socketTimeoutMS:15000});
 try {
  await client.connect();
  console.log(JSON.stringify(await migrate({db:client.db(MONGODB_DATABASE),file:CACHE_TELEMETRY_FILE,apply:command==='apply',writersStopped:process.env.NODE_CACHE_WRITERS_STOPPED === '1'})));
 } finally {await client.close();}
}
module.exports = {migrate,metric,health};
if (require.main === module) main().catch(error => {console.error(error.safeCode || 'cache_telemetry_import_failed');process.exitCode=1;});
