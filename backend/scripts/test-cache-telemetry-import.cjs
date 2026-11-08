'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const {DatabaseSync} = require('node:sqlite');
const {mongo:{MongoClient}} = require('mongoose');
const {migrate} = require('./migrate-cache-telemetry.cjs');

(async () => {
 const uri=process.env.GO_TEST_MONGODB_URI, database=process.env.GO_TEST_MONGODB_DATABASE;
 assert.ok(uri?.startsWith('mongodb://127.0.0.1:') && database?.startsWith('cache_import_'));
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cache-telemetry-'));
 const client=new MongoClient(uri);
 try {
  await client.connect(); const db=client.db(database);
  const source=fs.readFileSync(path.resolve(__dirname,'../../src/core/cache-observability.ts'),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const fixture={exports:{}}; const now=Date.now(); let clock=now;
  class Clock extends Date {static now(){return clock;}}
  const dependencies={os:{hostname:()=> 'private-host'},'node:sqlite':{DatabaseSync},fs,path,'../config':{default:{CACHE_MONITORING_ENABLED:true,SHARED_CACHE_PATH:root}},'./request-monitoring':{cacheTraffic:()=> 'background'}};
  vm.runInNewContext(code,{exports:fixture.exports,module:fixture,require:name=>{assert.ok(dependencies[name],name);return dependencies[name]},Date:Clock,process:{pid:123},setInterval(){return {unref(){}}},clearInterval(){}});
  const api=fixture.exports;
  // Actual TS flushes create both minute and hour aggregates. Keep samples away
  // from report cutoffs so wall-clock time during the Go handoff cannot move them.
  for(let i=0;i<620;i++){
   clock=now-(i*3+3)*60000;
   if([15,60,1440].some(minutes=>Math.abs(now-clock-minutes*60000)<3*60000))continue;
   api.observeCache(['source_hit','rewrite_changed','inspected_changed','inspected_unchanged','inspected_passthrough','inspected_binary','legacy_source_hit','legacy_source_miss'][i%8],i+1,[0,0.5,5,50,500,5000,50000][i%7],['file','website','zip','monitor','background'][i%5]);
   api.flushCacheMetrics();
  }
  // Overflow pending capacity to exercise persisted dropped counters as well.
  for(let i=0;i<514;i++){
   clock=now-(i*3+3)*60000;
   if([15,60,1440].some(minutes=>Math.abs(now-clock-minutes*60000)<3*60000)) clock-=10000*60000;
   api.observeCache('source_miss',1,1,'background');
  }
  clock=now;
  const expected={};
  for(const minutes of [15,60,1440,10080]){
   const report=api.cacheMetricsReport(minutes);
   expected[minutes]={rows:report.rows,dropped:report.dropped};
  }
  api.closeCacheMetrics();
  const file=path.join(root,'telemetry.sqlite');
  const options={db,file,apply:true,writersStopped:true};
  const before=fs.readFileSync(file);
  const dry=await migrate({...options,apply:false});
  assert.ok(dry.rows>500);
  assert.equal(await db.collection('gocachemetrics').countDocuments(),0);
  assert.equal(await db.collection('gocacheimports').countDocuments(),0);
  await assert.rejects(migrate({...options,writersStopped:false}),/stop_node_writers/);
  let calls=0;
  await assert.rejects(migrate({...options,afterBatch:()=>{if(++calls===1)throw Error('interrupted');}}),/interrupted/);
  assert.equal(await db.collection('gocachemetrics').countDocuments(),500);
  assert.equal((await db.collection('gocacheimports').findOne({})).state,'pending');
  await Promise.all([migrate(options),migrate(options)]);
  assert.equal(await db.collection('gocachemetrics').countDocuments(),dry.rows+dry.healthRows);
  const applied=await migrate(options); assert.equal(applied.alreadyComplete,true);
  assert.deepEqual(fs.readFileSync(file),before);
  assert.ok(!JSON.stringify(await db.collection('gocachemetrics').find().toArray()).includes('private-host'));
  // A completed replay does not resurrect a row removed by retention.
  const retired=await db.collection('gocachemetrics').findOne({period:60000,bucket:{$lt:now-1440*60000}});
  assert.ok(retired);
  await db.collection('gocachemetrics').deleteOne({_id:retired._id});
  await migrate(options);
  assert.equal(await db.collection('gocachemetrics').findOne({_id:retired._id}),null);
  // A new or malformed snapshot cannot mutate the destination, even in dry-run.
  const sql=new DatabaseSync(file);
  sql.exec('UPDATE health SET dropped=dropped+1');
  await assert.rejects(migrate(options),/snapshot_changed/);
  sql.exec("UPDATE metrics SET name='private/path' WHERE rowid=(SELECT MIN(rowid) FROM metrics)");
  await assert.rejects(migrate({...options,apply:false}),/unknown_telemetry_label/);
  sql.close();
  console.log(JSON.stringify(expected));
 } finally {await client.close();fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
