const {Readable}=require('node:stream');
const path=require('node:path');
process.env.SESSION_SECRET='synthetic-shared-http';
require('ts-node/register/transpile-only');
const config=require('../../src/config').default;config.CACHE_MONITORING_ENABLED=false;
const {BlobCache}=require('../../src/core/blob-cache');
(async()=>{
 for(const mode of ['identity','gzip']){
  const cache=new BlobCache({root:path.join(process.argv[2],mode),budget:65536,maxObject:4096,gzip:mode==='gzip'});
  try{for(const size of mode==='gzip'?[2250]:[0,17,2250]){
   const result=await cache.getOrFill(`payload-${size}`,async()=>Readable.from([Buffer.alloc(size,120)]));
   for await(const chunk of result){};await new Promise(r=>setImmediate(r));
  }}finally{cache.close()}
 }
})().catch(e=>{console.error(e);process.exitCode=1});
