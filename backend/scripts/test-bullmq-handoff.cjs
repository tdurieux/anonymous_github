'use strict';
const assert = require('node:assert/strict');
const {Queue, Worker, QueueEvents} = require('bullmq');
const {mongo:{MongoClient}} = require('mongoose');
const {randomUUID} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const {definitions,migrate} = require('./migrate-bullmq.cjs');

(async()=>{
 // Read the real queue declarations so a renamed/added TypeScript queue
 // cannot silently disappear from the handoff.
 const sourcePath=path.resolve(__dirname,'../../src/queue/index.ts');
 const source=ts.createSourceFile(sourcePath,fs.readFileSync(sourcePath,'utf8'),ts.ScriptTarget.Latest,true);
 const declared=[];
 function visit(node){if(ts.isNewExpression(node)&&node.expression.getText(source)==='Queue'){
  assert.ok(ts.isStringLiteral(node.arguments[0]));declared.push(node.arguments[0].text);
 }ts.forEachChild(node,visit);}
 visit(source);assert.deepEqual(declared.sort(),definitions.map(d=>d.name).sort());
 const uri=process.env.GO_TEST_MONGODB_URI, address=process.env.GO_TEST_REDIS_ADDR, database=process.env.GO_TEST_MONGODB_DATABASE;
 assert.ok(uri?.startsWith('mongodb://127.0.0.1:')&&address?.startsWith('127.0.0.1:')&&database?.startsWith('bull_handoff_'),'disposable services required');
 const connection={host:'127.0.0.1',port:Number(address.split(':')[1]),maxRetriesPerRequest:null};
 const prefix='handoff-test-'+randomUUID();
 const queues=definitions.map(d=>new Queue(d.name,{connection,prefix}));
 const client=new MongoClient(uri);await client.connect();const db=client.db(database);
 const redis=await queues[0].client;
 const events=new QueueEvents(queues[0].name,{connection,prefix});await events.waitUntilReady();
 let worker;
 try {
  worker=new Worker(queues[0].name,async job=>{if(job.name==='failed-history')throw new Error('synthetic private failure');return 'done';},{connection,prefix});
  const failed=await queues[0].add('failed-history',{repoId:'history'},{attempts:1,removeOnFail:false});
  const completed=await queues[0].add('completed-history',{repoId:'history'},{removeOnComplete:false});
  await failed.waitUntilFinished(events,10000).catch(error=>assert.match(error.message,/synthetic private failure/));
  await completed.waitUntilFinished(events,10000);
  await worker.close();worker=null;
  const removalEvents=new QueueEvents(queues[1].name,{connection,prefix});await removalEvents.waitUntilReady();
  try {
   worker=new Worker(queues[1].name,async()=>{throw new Error('synthetic removal failure');},{connection,prefix});
   const failedRemoval=await queues[1].add('failed-removal',{repoId:'handoff-failed-remove'},{attempts:1,removeOnFail:false});
   await failedRemoval.waitUntilFinished(removalEvents,10000).catch(error=>assert.match(error.message,/synthetic removal failure/));
   await worker.close();worker=null;
  } finally {await removalEvents.close();}
  for(const queue of queues)await queue.pause();
  await assert.rejects(migrate({db,redis,queues}),/go_queues_not_paused/);
  for(const d of definitions)await redis.set('go:pause:'+d.key,'1');
  // A connected paused worker still prevents a handoff.
  worker=new Worker(queues[0].name,async()=>{}, {connection,prefix});await worker.waitUntilReady();
  await assert.rejects(migrate({db,redis,queues}),/bullmq_workers_still_connected/);
  await worker.close();worker=null;
  const resources=['handoff-ready','handoff-duplicate','handoff-delayed','handoff-remove','handoff-cache','handoff-high','handoff-low','handoff-terminal','handoff-failed-remove','handoff-retry','handoff-exhausted','history'];
  for(const repoId of resources)await db.collection('anonymizedrepositories').insertOne({repoId,status:repoId==='handoff-terminal'?'removed':repoId==='handoff-failed-remove'?'error':'ready',statusDate:new Date(1700000000000),source:{provider:'fixture',repositoryName:'team/subgroup/project',providerRepositoryId:'project:123',commit:'opaque:1'},providerAccess:{provider:'fixture',kind:'fixture-grant',revision:'grant:1'}});
  await queues[0].add('ready',{repoId:'handoff-ready',credential:'synthetic-never-copy'},{attempts:4,backoff:{type:'exponential',delay:250}});
  await queues[0].add('retry',{repoId:'handoff-retry'},{attempts:2,backoff:{type:'fixed',delay:25}});
  await queues[0].add('exhausted',{repoId:'handoff-exhausted'},{attempts:1});
  for(let i=0;i<2;i++)await queues[0].add('duplicate',{repoId:'handoff-duplicate'});
  const delayed=await queues[0].add('delayed',{repoId:'handoff-delayed'},{delay:3600000,attempts:2});
  await queues[0].add('low',{repoId:'handoff-low'},{priority:5});
  await queues[0].add('high',{repoId:'handoff-high'},{priority:1});
  await queues[0].add('terminal',{repoId:'handoff-terminal'});
  await queues[1].add('remove',{repoId:'handoff-remove'},{attempts:3,backoff:{type:'exponential',delay:1000}});
  await queues[2].add('cache',{repoId:'handoff-cache'});
  const unsupported=await queues[0].add('custom',{repoId:'handoff-ready'},{backoff:{type:'custom',delay:5}});
  await assert.rejects(migrate({db,redis,queues}),/unsupported_job_backoff/);await unsupported.remove();
  const scheduled=await queues[0].upsertJobScheduler('recurring',{every:60000},{name:'scheduled',data:{repoId:'handoff-ready'}});
  await assert.rejects(migrate({db,redis,queues}),/schedules_require_separate_migration/);await queues[0].removeJobScheduler('recurring');const remaining=await queues[0].getJob(scheduled.id);if(remaining)await remaining.remove();
  await db.collection('gojobs').insertOne({_id:'active-fixture',state:'active'});
  await assert.rejects(migrate({db,redis,queues}),/go_jobs_still_active/);await db.collection('gojobs').deleteOne({_id:'active-fixture'});
  await db.collection('gojobs').insertOne({_id:'conflict',kind:'repo',resourceId:'handoff-ready',action:'prepare',state:'waiting'});
  await assert.rejects(migrate({db,redis,queues}),/existing_go_work_conflicts_with_source/);await db.collection('gojobs').deleteOne({_id:'conflict'});
  await queues[0].resume();await assert.rejects(migrate({db,redis,queues}),/bullmq_queue_not_paused/);await queues[0].pause();
  await redis.set('go:bullmq-handoff','other-process','PX',60000);await assert.rejects(migrate({db,redis,queues,apply:true}),/handoff_already_running/);await redis.del('go:bullmq-handoff');
  const summary=await migrate({db,redis,queues});
  assert.equal(summary.jobs,14);assert.equal(summary.counts.delayed,1);assert.equal(summary.counts.failed,2);
  assert.equal(await db.collection('gojobs').countDocuments(),0);assert.equal(await db.collection('gojobimports').countDocuments(),0);
  assert.equal((await db.collection('anonymizedrepositories').findOne({repoId:'handoff-ready'})).status,'ready');
  // Crash after the resource CAS, then after the first job insert.
  await assert.rejects(migrate({db,redis,queues,apply:true,afterWrite:async()=>{throw new Error('injected resource crash');}}),/injected resource crash/);
  await assert.rejects(migrate({db,redis,queues,apply:true,afterWrite:async()=>{if(await db.collection('gojobs').countDocuments())throw new Error('injected job crash');}}),/injected job crash/);
  const applied=await migrate({db,redis,queues,apply:true});assert.equal(applied.complete,true);
  assert.equal(await db.collection('gojobs').countDocuments(),14);
  const importedDelay=await db.collection('gojobs').findOne({resourceId:'handoff-delayed'});
  assert.equal(importedDelay.state,'delayed');assert.equal(+importedDelay.availableAt,delayed.timestamp+delayed.delay);
  const prepare=await db.collection('gojobs').findOne({resourceId:'handoff-ready'});
  assert.equal(prepare.maxAttempts,4);assert.equal(prepare.backoffType,'exponential');assert.equal(prepare.backoffDelay,250);
  assert.equal(await db.collection('gojobs').countDocuments({resourceId:'handoff-duplicate'}),2);
  assert.equal((await db.collection('anonymizedrepositories').findOne({repoId:'handoff-remove'})).status,'removing');
  assert.equal((await db.collection('anonymizedrepositories').findOne({repoId:'handoff-terminal'})).status,'removed');
  const failedJob=await db.collection('gojobs').findOne({resourceId:'history',state:'failed'});
  assert.equal(failedJob.error,'job_failed');assert.equal(failedJob.attempts,1);
  const storedJobs=JSON.stringify(await db.collection('gojobs').find().toArray());
  assert.ok(!storedJobs.includes('synthetic private failure'));assert.ok(!storedJobs.includes('synthetic removal failure'));assert.ok(!storedJobs.includes('synthetic-never-copy'));
  const history=await db.collection('gojobs').findOne({resourceId:'history',state:'completed'});
  await db.collection('gojobs').deleteOne({_id:history._id});
  // Simulate a resource/job being changed after its checkpoint completed.
  await db.collection('gojobs').updateOne({_id:failedJob._id},{$set:{attempts:9}});
  const repeated=await migrate({db,redis,queues,apply:true});assert.equal(repeated.pendingJobs,0);assert.equal(repeated.alreadyImported,14);assert.equal(repeated.transitions,0);
  assert.equal(await db.collection('gojobs').countDocuments({_id:history._id}),0);
  assert.equal((await db.collection('gojobs').findOne({_id:failedJob._id})).attempts,9);
  assert.equal((await queues[0].getJob(delayed.id)).delay,3600000);
  for(const queue of queues)assert.equal(await queue.isPaused(),true);
  for(const d of definitions)assert.equal(await redis.get('go:pause:'+d.key),'1');
  const added=await queues[0].add('after-snapshot',{repoId:'handoff-ready'});
  await assert.rejects(migrate({db,redis,queues,apply:true}),/source_snapshot_changed_since_handoff/);await added.remove();
  console.log(JSON.stringify({jobs:14,complete:true}));
 }finally{
  if(worker)await worker.close(true);
  await events.close();
  for(const queue of queues)await queue.obliterate({force:true});
  for(const d of definitions)await redis.del('go:pause:'+d.key);
  await Promise.all(queues.map(q=>q.close()));await client.close();
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
