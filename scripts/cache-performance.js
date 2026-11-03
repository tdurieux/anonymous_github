/* Local HTTP benchmark. Uses temporary files and deterministic synthetic content, never production. */
const { strict: assert } = require('node:assert');
const { promises: fs, createReadStream } = require('node:fs');
const { tmpdir, cpus, totalmem, loadavg } = require('node:os');
const { join, dirname } = require('node:path');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createGzip, gunzipSync } = require('node:zlib');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { setInterval, clearInterval } = require('node:timers');
const { fork } = require('node:child_process');
const http = require('node:http');
const percentile = (values, p) => [...values].sort((a,b) => a-b)[Math.min(values.length-1, Math.ceil(values.length*p)-1)];
function fixture(size, binary) {
  const chunks = []; let length = 0;
  for (let i=0; length<size; i++) {
    const digest = createHash('sha256').update('cache-evaluation-' + i).digest();
    const chunk = binary ? digest : Buffer.from(`${i}: ResearcherAlice record ${digest.toString('hex')} module/path/${i % 137}.ts\n`);
    chunks.push(chunk); length += chunk.length;
  }
  return Buffer.concat(chunks).subarray(0,size);
}
async function worker(spec) {
  let privateTmp;
  if(spec.mode==='legacy-transform'){privateTmp=await fs.mkdtemp(join(tmpdir(),'cache-legacy-bench-'));process.env.TMPDIR=privateTmp;}
  if(process.env.CACHE_BENCH_COMPILED !== '1') require('ts-node/register/transpile-only');
  const code=process.env.CACHE_BENCH_COMPILED === '1' ? '../build' : '../src';
  const express = require('express');
  const config = require(code+'/config').default;
  const { sharedBlobCache, resultBlobCache, closeBlobCaches } = require(code+'/core/blob-cache');
  const { sendSharedContent } = require(code+'/core/cached-response');
  const { AnonymizeTransformer } = require(code+'/core/anonymize-utils');
  const { closeCacheMetrics, cacheMetricsReport } = require(code+'/core/cache-observability');
  const root = await fs.mkdtemp(join(tmpdir(), 'cache-performance-'));
  const body = fixture(spec.size, spec.binary);
  const expected = spec.changed ? Buffer.from(body.toString().replaceAll('ResearcherAlice', 'ResearcherHidden')) : body;
  const digest = 'git-' + createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
  const raw = join(root, 'source.raw'); let sourceReady = false, upstreamFills = 0, server;
  Object.assign(config, { FOLDER:root, SHARED_CACHE_PATH:join(root,'pool'), SHARED_CACHE_ENABLED:spec.mode==='shared',
    SHARED_CACHE_BYTES:64*1024**2, SHARED_CACHE_RESULT_BYTES:32*1024**2, SHARED_CACHE_MAX_FILE_BYTES:4*1024**2,
    SHARED_CACHE_FREE_BYTES:0, CACHE_MONITORING_ENABLED:true, REDIS_HOSTNAME:'127.0.0.1', REDIS_PORT:1 });
  if (spec.sqliteNormal) { sharedBlobCache().db.exec('PRAGMA synchronous=NORMAL'); resultBlobCache().db.exec('PRAGMA synchronous=NORMAL'); }
  const options = { filePath:spec.binary?'fixture.bin':'fixture.txt', repoId:'performance-project',
    terms:spec.changed?['ResearcherAlice=>ResearcherHidden']:['AbsentResearcher'], decisionManaged:spec.mode!=='legacy-transform' };
  const obtain = async () => {
    if (spec.mode === 'uncached') { upstreamFills++; await delay(20); return Readable.from(body); }
    if (spec.mode === 'raw-source' || spec.mode === 'legacy-transform') {
      if (!sourceReady) { upstreamFills++; await delay(20); await fs.writeFile(raw,body); sourceReady=true; }
      return createReadStream(raw);
    }
    return sharedBlobCache().getOrFill(digest, async()=>{upstreamFills++;await delay(20);return Readable.from(body);},
      async proof=>{assert.equal('git-'+proof.gitSha,digest);return digest;},body.length);
  };
  const app=express(); app.get('/file',async(_req,res)=>{
    res.type(spec.binary?'application/octet-stream':'text/plain');
    try {
      const source=await obtain();
      if (spec.mode==='shared' && await sendSharedContent(source,res,options)) return;
      const stages=[source,new AnonymizeTransformer(options)];
      if(spec.encoding==='gzip'){res.setHeader('Content-Encoding','gzip');stages.push(createGzip({level:6}));}
      await pipeline(...stages,res);
    }catch(error){res.destroy(error);}
  });
  const agent=new http.Agent({keepAlive:true,maxSockets:8});
  let wireHash;
  try {
    await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});
    const request=()=>new Promise((resolve,reject)=>{
      const start=performance.now();
      http.get({host:'127.0.0.1',port:server.address().port,path:'/file',agent,headers:{'accept-encoding':spec.encoding}},res=>{
        const ttfb=performance.now()-start, chunks=[]; let bytes=0;const sha=createHash('sha256');
        res.on('data',b=>{bytes+=b.length;sha.update(b);if(!wireHash)chunks.push(b);});
        res.on('error',reject);res.on('end',()=>{
          try {
            assert.equal(res.statusCode,200); const digest=sha.digest('hex');
            const elapsed=performance.now()-start;
            if(!wireHash){const data=Buffer.concat(chunks);assert.deepEqual(res.headers['content-encoding']==='gzip'?gunzipSync(data):data,expected);wireHash=digest;}
            else assert.equal(digest,wireHash);
            resolve({ms:elapsed,ttfb,bytes});
          }catch(error){reject(error);}
        });
      }).on('error',reject);
    });
    const coldCpu=process.cpuUsage(),coldStart=performance.now();const cold=await request();
    const coldResources={...cold,wallMs:performance.now()-coldStart,cpuMs:Object.values(process.cpuUsage(coldCpu)).reduce((a,b)=>a+b,0)/1000};
    // JIT and worker warmup is excluded from warm samples.
    for(let i=0;i<3;i++) await request();
    const batches=[];
    for(const concurrency of [1,8]) for(let repeat=0;repeat<2;repeat++) {
      const count=concurrency===1?16:32;let next=0;const rows=[];
      let peakRss=process.memoryUsage().rss;
      const timer=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);},5);
      const eventLoop=monitorEventLoopDelay({resolution:10});eventLoop.enable();await delay(20);
      const cpu=process.cpuUsage(), start=performance.now();
      await Promise.all(Array.from({length:concurrency},async()=>{for(;;){const i=next++;if(i>=count)return;rows.push(await request());}}));
      const elapsed=performance.now()-start,cpuUsed=process.cpuUsage(cpu);eventLoop.disable();clearInterval(timer);
      batches.push({concurrency,repeat,requests:count,elapsedMs:elapsed,requestsPerSecond:count*1000/elapsed,
        p50Ms:percentile(rows.map(r=>r.ms),.5),p95Ms:percentile(rows.map(r=>r.ms),.95),maxMs:Math.max(...rows.map(r=>r.ms)),
        ttfbP95Ms:percentile(rows.map(r=>r.ttfb),.95),cpuMs:(cpuUsed.user+cpuUsed.system)/1000,
        cpuMsPerRequest:(cpuUsed.user+cpuUsed.system)/1000/count,peakRssMiB:Math.max(peakRss,process.memoryUsage().rss)/1048576,
        eventLoopP95Ms:eventLoop.count?eventLoop.percentile(95)/1e6:null,wireBytes:rows.reduce((n,r)=>n+r.bytes,0),latenciesMs:rows.map(r=>r.ms)});
    }
    const metrics=cacheMetricsReport(60);
    const report={...spec,cold:coldResources,batches,upstreamFills,source:sharedBlobCache()?.stats()||null,results:resultBlobCache()?.stats()||null,
      metrics:metrics.rows,wireBytesPerResponse:cold.bytes,uncompressedBytes:expected.length,verifiedResponses:100};
    process.send({report});
  } finally {agent.destroy();if(server)await new Promise(resolve=>server.close(resolve));closeBlobCaches();closeCacheMetrics();await fs.rm(root,{recursive:true,force:true});if(privateTmp)await fs.rm(privateTmp,{recursive:true,force:true});}
}
async function main() {
  let scenarios=[];
  for(const size of [16384,262144,2097152])for(const changed of [false,true])for(const mode of ['uncached','raw-source','shared'])scenarios.push({size,changed,mode,encoding:'gzip',binary:false});
  for(const size of [262144,2097152])scenarios.push({size,changed:true,mode:'shared',encoding:'identity',binary:false});
  for(const mode of ['raw-source','shared'])scenarios.push({size:262144,changed:false,mode,encoding:'gzip',binary:true});
  if (process.argv.includes('--shared')) scenarios=scenarios.filter(s=>s.mode==='shared' && s.changed && s.encoding==='gzip');
  if (process.argv.includes('--normal')) scenarios=[16384,262144,2097152].map(size=>({size,changed:true,mode:'shared',encoding:'gzip',binary:false,sqliteNormal:true}));
  if (process.argv.includes('--legacy')) scenarios=[false,true].map(changed=>({size:2097152,changed,mode:'legacy-transform',encoding:'gzip',binary:false}));
  const report={measuredAt:new Date().toISOString(),environment:{execution:process.env.CACHE_BENCH_COMPILED === '1' ? 'compiled JavaScript' : 'ts-node',node:process.version,platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryGiB:totalmem()/1024**3,loadAverage:loadavg()},
    methodology:{scope:'Local loopback HTTP, deterministic synthetic content, isolated process per scenario; no production traffic',
      upstreamDelayMs:20,rawSourceBaseline:'Raw local file; anonymization and gzip repeated every request; no transformed-result cache. Not a complete legacy deployment comparison.',
      measurements:'Cold request then 3 warmups, 2 batches each at concurrency 1 (16 requests) and 8 (32 requests). CPU and RSS include server, loopback client, hashing and Node runtime; worker-thread CPU included. First cold request also includes worker startup when applicable.',
      limitations:'Warm OS page cache; no TLS, proxy, GitHub bandwidth, database auth or real-world RTT. Small sample p95 is descriptive, not a capacity SLA. Fresh metadata indexes; not a full-size index test.'},scenarios:[]};
  for(const spec of scenarios){
    process.stderr.write(`Measuring ${JSON.stringify(spec)}\n`);
    report.scenarios.push(await new Promise((resolve,reject)=>{
      const child=fork(__filename,['--worker',JSON.stringify(spec)],{env:{...process.env,NODE_ENV:'test'},stdio:['ignore','ignore','pipe','ipc']});
      let result,stderr='';const timeout=setInterval(()=>{child.kill();reject(Error('Scenario exceeded 120 seconds'));},120000);
      child.stderr.on('data',b=>{stderr=(stderr+b).slice(-4000);});child.on('message',m=>{result=m.report;});child.on('error',reject);
      child.on('exit',code=>{clearInterval(timeout);if(code===0&&result)resolve(result);else reject(Error(`Scenario failed ${code}: ${stderr}`));});
    }));
  }
  report.completedAt=new Date().toISOString();report.assertions=`All ${scenarios.length*100} response bodies verified against expected output or the validated wire digest`;
  if (process.argv.includes('--normal')) report.methodology.experimentalOverride='PRAGMA synchronous=NORMAL in both temporary pool connections only. Application defaults are unchanged. WAL commits may be lost after power failure.';
  if (process.argv.includes('--legacy')) report.methodology.legacyComparison='Existing large-file transformedFile cache enabled, isolated TMPDIR, local source file, no Redis coordination or database authorization.';
  const output = process.argv[2] || 'benchmark-results/cache/http.json';
  await fs.mkdir(dirname(output), { recursive: true });
  await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify({scenarios:report.scenarios.length,assertions:report.assertions})+'\n');
}
if(process.argv[2]==='--worker')worker(JSON.parse(process.argv[3])).then(()=>process.exit(0),e=>{console.error(e);process.exit(1);});
else main().catch(e=>{console.error(e);process.exitCode=1;});
