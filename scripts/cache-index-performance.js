/* Synthetic metadata cardinality and bounded eviction probes. No production access. */
const { strict: assert } = require('node:assert');
const { promises: fs } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const { Readable } = require('node:stream');
const { performance } = require('node:perf_hooks');
require('ts-node/register/transpile-only');
const config = require('../src/config').default;
const { BlobCache } = require('../src/core/blob-cache');
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)];
const consume=async stream=>{let size=0;for await(const chunk of stream)size+=chunk.length;return size;};
async function main(){
  const root=await fs.mkdtemp(join(tmpdir(),'cache-index-performance-'));config.CACHE_MONITORING_ENABLED=false;
  const results=[];let cache;
  try{
    for(const cardinality of [0,10000,100000]){
      cache=new BlobCache({root:join(root,'index-'+cardinality),budget:1024**3,maxObject:4096,gzip:false});
      const real=await cache.getOrFill('real',async()=>Readable.from('verified real content'));const digest=real.cachedBlob.record.digest;await consume(real);
      const now=Date.now();cache.db.exec('BEGIN');
      const blob=cache.db.prepare('INSERT INTO blobs VALUES(?,?,?,?,?,?,?)');
      const alias=cache.db.prepare('INSERT INTO aliases VALUES(?,?)');
      const decision=cache.db.prepare('INSERT INTO decisions(key,digest,changed,accessed,expires) VALUES(?,?,?,?,?)');
      const history=cache.db.prepare('INSERT INTO history VALUES(?,?,0)');
      for(let i=0;i<cardinality;i++){
        // Metadata-only dummy rows, never opened. Real lookups/fills use the separate verified content above.
        const key='sha256-'+i.toString(16).padStart(64,'0');blob.run(key,'dead.raw',4096,4096,'identity',now,4096);
        alias.run('seed-'+i,digest);alias.run('alias-'+i,digest);decision.run('rule-'+i,digest,0,now,now+86400000);history.run('history-'+i,now);
      }
      cache.db.exec('COMMIT');
      const stats=[],hits=[],fills=[],decisions=[];
      for(let i=0;i<30;i++){
        let start=performance.now();cache.stats();stats.push(performance.now()-start);
        start=performance.now();assert.equal(await consume(await cache.getOrFill(digest,async()=>{throw Error('unexpected miss');})),21);hits.push(performance.now()-start);
        start=performance.now();cache.saveDecision('measured-'+i,digest,false);decisions.push(performance.now()-start);
        start=performance.now();await consume(await cache.getOrFill('new-'+i,async()=>Readable.from('verified real content')));fills.push(performance.now()-start);
      }
      const summarize=x=>({p50Ms:percentile(x,.5),p95Ms:percentile(x,.95),maxMs:Math.max(...x)});
      results.push({seedBlobs:cardinality,seedAliases:cardinality*2,seedDecisions:cardinality,seedHistory:cardinality,
        adminStats:summarize(stats),warmSourceHit:summarize(hits),decisionWrite:summarize(decisions),smallFill:summarize(fills)});
      cache.close();cache=undefined;
    }
    cache=new BlobCache({root:join(root,'eviction'),budget:4*1024**2,maxObject:65536,gzip:false});
    const times=[];let upstream=0,peakAllocated=0;const started=performance.now();
    for(let i=0;i<300;i++){
      // 100 distinct objects, three sequential traversals: deliberately larger than the pool.
      const id=i%100,data=Buffer.alloc(65536,id);const begin=performance.now();
      await consume(await cache.getOrFill('object-'+id,async()=>{upstream++;return Readable.from(data);}));times.push(performance.now()-begin);
      const stats=cache.stats();peakAllocated=Math.max(peakAllocated,stats.allocatedBytes);assert.ok(stats.allocatedBytes+stats.reservedBytes<=stats.budgetBytes);
    }
    const report={measuredAt:new Date().toISOString(),scope:'Synthetic metadata-only scale probe. Dummy blob rows have no payload files; excludes directory scanning and disk reads for those rows. Real reads use one verified blob. Eviction probe uses real 64 KiB files.',
      node:process.version,cardinality:results,eviction:{requests:300,distinctObjects:100,upstreamFills:upstream,hitRate:1-upstream/300,
        elapsedMs:performance.now()-started,p50Ms:percentile(times,.5),p95Ms:percentile(times,.95),peakAllocated,final:cache.stats()},assertions:'passed'};
    const output = process.argv[2] || 'benchmark-results/cache/index.json';
  await fs.mkdir(dirname(output), { recursive: true });
  await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');
    process.stdout.write(JSON.stringify(report,null,2)+'\n');
  }finally{cache?.close();await fs.rm(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
