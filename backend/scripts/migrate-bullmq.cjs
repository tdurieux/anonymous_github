#!/usr/bin/env node
'use strict';
// Offline cutover only. Uses BullMQ's public API; no private Redis key decoding.
const { Queue } = require('bullmq');
const { mongo: { MongoClient } } = require('mongoose');
const { createHash, randomUUID } = require('node:crypto');

const definitions = [
 {name: 'repository download', key: 'download', action: 'prepare'},
 {name: 'repository removal', key: 'remove', action: 'remove'},
 {name: 'cache removal', key: 'cache', action: 'cache'},
];
const states = ['waiting', 'paused', 'delayed', 'prioritized', 'waiting-children', 'active', 'failed', 'completed'];
const live = new Set(['waiting', 'paused', 'delayed', 'prioritized']);
const terminal = new Set(['archived', 'removing', 'removed', 'expiring', 'expired']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refuse = code => { throw Object.assign(new Error(code), {safeCode: code}); };
function integer(value, code, min = 0, max = Number.MAX_SAFE_INTEGER) {
 if (!Number.isSafeInteger(value) || value < min || value > max) refuse(code);
 return value;
}
function date(value, code) { return new Date(integer(value, code, 0, 253402300799000)); }
function normalize(job, state, definition, queueOrder = 0) {
 const id = job.data?.repoId;
 if (typeof job.id !== 'string' || !job.id || job.id.length > 2048) refuse('invalid_source_job_id');
 if (typeof id !== 'string' || !id || id.length > 512) refuse('invalid_repository_job_payload');
 if (state === 'active' || state === 'waiting-children' || !states.includes(state)) refuse('unsupported_or_active_job_state');
 const opts = job.opts || {};
 if (opts.repeat || job.repeatJobKey || opts.parent || opts.lifo || opts.failParentOnFailure || opts.continueParentOnFailure || opts.removeDependencyOnFailure) refuse('unsupported_job_dependency_or_schedule');
 let backoff = opts.backoff ?? {type: 'fixed', delay: 0};
 if (typeof backoff === 'number') backoff = {type: 'fixed', delay: backoff};
 if (!['fixed', 'exponential'].includes(backoff.type) || (backoff.jitter ?? 0) !== 0) refuse('unsupported_job_backoff');
 const timestamp = integer(job.timestamp, 'invalid_job_timestamp', 0, 253402300799000);
 const delay = integer(job.delay ?? 0, 'invalid_job_delay', 0, 253402300799000 - timestamp);
 const item = {
  sourceQueue: definition.name, sourceId: String(job.id), timestamp,
  resourceId: id, action: definition.action, state, queueOrder,
  availableAt: state === 'delayed' ? timestamp + delay : 0,
  priority: integer(opts.priority ?? 0, 'invalid_job_priority', 0, 2097152),
  attempts: integer(job.attemptsMade ?? 0, 'invalid_job_attempts'),
  maxAttempts: Math.max(1, integer(opts.attempts ?? 1, 'invalid_job_attempt_limit')),
  backoffType: backoff.type,
  backoffDelay: integer(backoff.delay ?? 0, 'invalid_job_backoff', 0, 9223372036854),
  finishedAt: job.finishedOn == null ? null : integer(job.finishedOn, 'invalid_job_finished_at', 0, 253402300799000),
 };
 item.id = 'bull:' + hash([item.sourceQueue, item.sourceId, timestamp]);
 item.fingerprint = hash(item);
 return item;
}

async function snapshot(queues, guard = async () => {}) {
 const jobs = [];
 for (let i = 0; i < queues.length; i++) {
  const queue = queues[i];
  await guard();
  if (!(await queue.isPaused())) refuse('bullmq_queue_not_paused');
  if ((await queue.getWorkers()).length) refuse('bullmq_workers_still_connected');
  if ((await queue.getRepeatableJobs(0, 0)).length || (await queue.getJobSchedulers(0, 0)).length) refuse('bullmq_schedules_require_separate_migration');
  const seen = new Set();
  for (const state of states) {
   for (let offset = 0; ; offset += 500) {
    await guard();
    const page = await queue.getJobs([state], offset, offset + 499, true);
    for (const job of page) {
     if (!job) refuse('bullmq_snapshot_changed');
     if (seen.has(String(job.id))) continue;
     seen.add(String(job.id));
     if (seen.size % 32 === 0) await guard();
     jobs.push(normalize(job, await job.getState(), definitions[i], seen.size - 1));
    }
    if (page.length < 500) break;
   }
  }
 }
 jobs.sort((a,b) => a.id.localeCompare(b.id));
 return {jobs, digest: hash(jobs)};
}

function revision(resource) {
 const filter = {_id: resource._id, status: resource.status === undefined ? {$exists:false} : resource.status};
 for (const field of ['statusDate', 'settingsSavedAt', 'treeGeneration']) filter[field] = resource[field] === undefined ? {$exists: false} : resource[field];
 for (const field of ['githubAccess', 'providerAccess']) filter[field + '.revision'] = resource[field]?.revision === undefined ? {$exists: false} : resource[field].revision;
 return filter;
}

async function plan(db, input, guard = async () => {}) {
 const resources = new Map();
 const plans = [];
 for (const item of input.jobs) {
  await guard();
  const imported = await db.collection('gojobimports').findOne({_id: item.id});
  if (imported && imported.fingerprint !== item.fingerprint) refuse('import_checkpoint_conflict');
  const existing = await db.collection('gojobs').findOne({_id: item.id});
  if (existing && existing.migration?.fingerprint !== item.fingerprint) refuse('target_job_conflict');
  let resource = await db.collection('anonymizedrepositories').findOne({repoId: item.resourceId}, {collation: {locale:'en', strength:2}, projection:{_id:1,repoId:1,status:1,statusDate:1,settingsSavedAt:1,treeGeneration:1,'githubAccess.revision':1,'providerAccess.revision':1}});
  if (resource) {
   const conflict = await db.collection('gojobs').findOne({kind:'repo',resourceId:resource.repoId,action:item.action,state:{$in:['active','waiting','delayed']},migration:{$exists:false}});
   if (conflict) refuse('existing_go_work_conflicts_with_source');
   const canonical = resource._id.toString();
   if (!resources.has(canonical)) resources.set(canonical, {resource, actions: new Set()});
   if (live.has(item.state)) resources.get(canonical).actions.add(item.action);
  }
  let state = item.state === 'delayed' ? 'delayed' : live.has(item.state) ? 'waiting' : item.state;
  let error;
  if (!resource && live.has(item.state)) {state = 'failed'; error = 'repository_not_found';}
  if (resource && live.has(item.state) && ((item.action === 'prepare' && terminal.has(resource.status)) || (item.action === 'remove' && resource.status === 'removed'))) state = 'completed';
  plans.push({item, imported:imported?.state === 'complete', job: {
   _id:item.id, kind:'repo', resourceId:resource?.repoId || item.resourceId, action:item.action,
   state, attempts:item.attempts, maxAttempts:item.maxAttempts, priority:item.priority, queueOrder:item.queueOrder,
   backoffType:item.backoffType, backoffDelay:item.backoffDelay,
   availableAt:date(item.availableAt,'invalid_job_date'), createdAt:date(item.timestamp,'invalid_job_date'),
   ...(state === 'failed' ? {error:error || 'job_failed'} : {}),
   ...(['failed','completed'].includes(state) ? {finishedAt:date(item.finishedAt ?? item.timestamp,'invalid_job_date')} : {}),
   migration:{version:1, sourceQueue:item.sourceQueue, sourceId:item.sourceId, fingerprint:item.fingerprint},
  }});
 }
 const transitions = [];
 for (const {resource, actions} of resources.values()) {
  let target;
  if (actions.has('remove') && resource.status !== 'removed') target = 'removing';
  else if (actions.has('prepare') && !terminal.has(resource.status)) target = 'preparing';
  const id = 'resource:' + resource._id.toString();
  const checkpoint = await db.collection('gojobimports').findOne({_id:id});
  if (checkpoint) {transitions.push(checkpoint); continue;}
  if (!target || resource.status === target) continue;
  transitions.push({_id:id, resourceId:resource._id, original:revision(resource), target, targetDate:new Date(), state:'pending'});
 }
 return {plans, transitions};
}

async function quiescent(db, redis) {
 for (const definition of definitions) if (!(await redis.exists('go:pause:' + definition.key))) refuse('go_queues_not_paused');
 if (await db.collection('gojobs').countDocuments({state:'active'}, {limit:1})) refuse('go_jobs_still_active');
}

async function migrate({db, redis, queues, apply = false, afterWrite}) {
 const token = randomUUID();
 const lock = 'go:bullmq-handoff';
 let locked = false;
 const guard = async () => {
  if (!apply) return;
  const held = await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],60000) else return 0 end",1,lock,token);
  if (held !== 1) refuse('handoff_lock_lost');
 };
 try {
  if (apply) {
   locked = (await redis.set(lock,token,'PX',60000,'NX')) === 'OK';
   if (!locked) refuse('handoff_already_running');
  }
  await quiescent(db,redis);
  const input = await snapshot(queues,guard);
  const head = await db.collection('gojobimports').findOne({_id:'bullmq-v1'});
  if (head && head.digest !== input.digest) refuse('source_snapshot_changed_since_handoff');
  const prepared = await plan(db,input,guard);
  const again = await snapshot(queues,guard);
  if (again.digest !== input.digest) refuse('bullmq_snapshot_changed');
  const pending=prepared.plans.filter(entry=>!entry.imported);
  const summary = {mode:apply?'apply':'dry-run', jobs:input.jobs.length, alreadyImported:input.jobs.length-pending.length, pendingJobs:pending.length, transitions:prepared.transitions.filter(entry=>entry.state!=='complete').length, counts:{}, sourceDigest:input.digest};
  for (const {job} of pending) summary.counts[job.state] = (summary.counts[job.state] || 0) + 1;
  if (!apply) return summary;
  await quiescent(db,redis);
  await guard();
  await db.collection('gojobimports').updateOne({_id:'bullmq-v1'}, {$setOnInsert:{digest:input.digest,createdAt:new Date(),state:'pending'}}, {upsert:true});
  const writeDone = async () => { if (afterWrite) await afterWrite(); };
  for (const transition of prepared.transitions) {
   await guard();
   await db.collection('gojobimports').updateOne({_id:transition._id}, {$setOnInsert:transition}, {upsert:true});
   if (transition.state === 'complete') continue;
   const result = await db.collection('anonymizedrepositories').updateOne(transition.original, {$set:{status:transition.target,statusDate:transition.targetDate},$unset:{statusMessage:''}});
   if (!result.matchedCount) {
    const already = await db.collection('anonymizedrepositories').findOne({_id:transition.resourceId,status:transition.target,statusDate:transition.targetDate});
    if (!already) refuse('resource_changed_during_handoff');
   }
   await writeDone();
   await db.collection('gojobimports').updateOne({_id:transition._id}, {$set:{state:'complete'}});
  }
  for (const {item,job} of prepared.plans) {
   await guard();
   const checkpoint = await db.collection('gojobimports').findOne({_id:item.id});
   if (checkpoint?.state === 'complete') continue;
   await db.collection('gojobimports').updateOne({_id:item.id}, {$setOnInsert:{fingerprint:item.fingerprint,state:'pending'}}, {upsert:true});
   await db.collection('gojobs').updateOne({_id:item.id}, {$setOnInsert:job}, {upsert:true});
   await writeDone();
   await db.collection('gojobimports').updateOne({_id:item.id}, {$set:{state:'complete'}});
  }
  if ((await snapshot(queues,guard)).digest !== input.digest) refuse('source_changed_during_handoff');
  await quiescent(db,redis);
  await db.collection('gojobimports').updateOne({_id:'bullmq-v1'}, {$set:{state:'complete',finishedAt:new Date()}});
  return {...summary, complete:true};
 } finally {
  if (locked) await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",1,lock,token).catch(()=>{});
 }
}

async function main() {
 const command = process.argv[2] || 'dry-run';
 if (!['pause','dry-run','apply'].includes(command) || process.argv.length > 3) refuse('usage: node backend/scripts/migrate-bullmq.cjs [pause|dry-run|apply]');
 if (!process.env.MONGODB_URI || !process.env.MONGODB_DATABASE) refuse('MONGODB_URI_and_MONGODB_DATABASE_required');
 const port = Number(process.env.REDIS_PORT || 6379);
 integer(port,'invalid_redis_port',1,65535);
 const connection = {host:process.env.REDIS_HOSTNAME || '127.0.0.1',port,maxRetriesPerRequest:1,connectTimeout:5000,commandTimeout:15000};
 const queues = definitions.map(d=>new Queue(d.name,{connection,skipMetasUpdate:true}));
 for (const queue of queues) queue.on('error',()=>{});
 const mongo = new MongoClient(process.env.MONGODB_URI,{serverSelectionTimeoutMS:10000,socketTimeoutMS:15000});
 try {
  await mongo.connect();
  const redis = await queues[0].client;
  if (command === 'pause') {
   for (let i=0;i<queues.length;i++) {await queues[i].pause(); await redis.set('go:pause:'+definitions[i].key,'1');}
   console.log(JSON.stringify({paused:true,next:'Stop Node and Go producers/workers, then run dry-run.'}));
  } else console.log(JSON.stringify(await migrate({db:mongo.db(process.env.MONGODB_DATABASE),redis,queues,apply:command==='apply'})));
 } finally {await Promise.allSettled(queues.map(q=>q.close()));await mongo.close();}
}
module.exports = {definitions,normalize,snapshot,migrate};
if (require.main === module) main().catch(error=>{console.error(error.safeCode || 'queue_handoff_failed');process.exitCode=1;});
