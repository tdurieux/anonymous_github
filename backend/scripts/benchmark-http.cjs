'use strict';
// Runs the actual Node and Go entrypoints. No production credentials, database,
// storage, providers or application methods are replaced by benchmark stubs.
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os');
const http=require('node:http'),net=require('node:net'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process'),{once}=require('node:events');
const {performance}=require('node:perf_hooks'),{setTimeout:delay}=require('node:timers/promises');
const assert=require('node:assert/strict'),ts=require('typescript');
const {mongo:{MongoClient,ObjectId}}=require('mongoose');
const root=path.resolve(__dirname,'../..');
const children=new Set();let interrupted=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{interrupted=true;for(const child of children)child.kill('SIGTERM')});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const scriptSHA256=hash(fs.readFileSync(__filename));
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
const ticks=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}));
const page=Number(execFileSync('getconf',['PAGESIZE'],{encoding:'utf8'}));
function usage(pid,seen=new Set()) {
 if(seen.has(pid))return {rss:0,cpu:0};seen.add(pid);
 try {
  const text=fs.readFileSync(`/proc/${pid}/stat`,'utf8');const fields=text.slice(text.lastIndexOf(')')+2).split(' ');
  let rss=Number(fields[21])*page,cpu=[11,12,13,14].reduce((sum,i)=>sum+Number(fields[i]),0)*1000/ticks;
  // Go may fork workers from any OS thread, not just the main thread.
  const descendants=new Set();
  for(const tid of fs.readdirSync(`/proc/${pid}/task`)){
   try{for(const child of fs.readFileSync(`/proc/${pid}/task/${tid}/children`,'utf8').trim().split(' '))if(child)descendants.add(Number(child));}
   catch(error){if(error.code!=='ENOENT'&&error.code!=='ESRCH')throw error;}
  }
  for(const child of descendants){const value=usage(child,seen);rss+=value.rss;cpu+=value.cpu;}
  return {rss,cpu};
 }catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return {rss:0,cpu:0};throw error;}
}
async function compileNode(destination) {
 const digest=crypto.createHash('sha256');
 async function walk(directory,relative=''){
  for(const entry of (await fsp.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   const rel=path.join(relative,entry.name),source=path.join(directory,entry.name);
   if(entry.isDirectory()){await walk(source,rel);continue;}
   if(!entry.name.endsWith('.ts')||entry.name.endsWith('.d.ts'))continue;
   const content=await fsp.readFile(source,'utf8');digest.update(rel+'\0'+content+'\0');
   const target=path.join(destination,rel.replace(/\.ts$/,'.js'));await fsp.mkdir(path.dirname(target),{recursive:true});
   await fsp.writeFile(target,ts.transpileModule(content,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,preserveConstEnums:true,removeComments:true}}).outputText);
  }
 }
 await walk(path.join(root,'src'));
 const emoji=await fsp.readFile(path.join(root,'public/script/external/github-emojis.js'));
 const asset=path.join(destination,'../public/script/external/github-emojis.js');
 await fsp.mkdir(path.dirname(asset),{recursive:true});await fsp.writeFile(asset,emoji);digest.update(emoji);
 return digest.digest('hex');
}
async function port(){const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const value=server.address().port;await new Promise(r=>server.close(r));return value;}
let requestID=0;
function request(address,url,expected,agent,method='GET') {
 return new Promise((resolve,reject)=>{
  const start=performance.now(),id=++requestID;
  const req=http.request({host:'127.0.0.1',port:address,path:url,method,agent,headers:{'accept-encoding':'identity','x-forwarded-for':`10.${(id>>>16)&255}.${(id>>>8)&255}.${id&255}`}},res=>{
   const firstByte=performance.now()-start,digest=crypto.createHash('sha256');let bytes=0;
   res.on('data',chunk=>{bytes+=chunk.length;digest.update(chunk)});res.on('error',reject);
   res.on('end',()=>{try{
    assert.equal(res.statusCode,200,`${method} ${url} returned ${res.statusCode}`);
    assert.equal(res.headers['content-encoding'],undefined,'unexpected compression');
    const actual=digest.digest('hex');if(expected)assert.equal(actual,expected,`${url} output changed`);
    resolve({ms:performance.now()-start,ttfbMs:firstByte,bytes,sha256:actual});
   }catch(error){reject(error)}});
  });
  req.setTimeout(60000,()=>req.destroy(Error('request_timeout')));req.on('error',reject);req.end();
 });
}
async function stop(child){
 if(child.exitCode!==null||child.signalCode!==null)return;
 const ended=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),35000);
 try{await ended;}finally{clearTimeout(timer);}
}
async function runRuntime({runtime,spec,repeat,temp,compiled,client,mongo,redis,binary,quick}) {
 const directory=await fsp.mkdtemp(path.join(temp,`${runtime}-`)),database='http_bench_'+crypto.randomBytes(8).toString('hex');
 const db=client.db(database),owner=new ObjectId(),body=spec.body,expected=hash(spec.output);
 if(runtime==='node')await fsp.symlink(compiled,path.join(directory,'build'),'dir');
 await fsp.mkdir(path.join(directory,'public'));
 await db.collection('users').insertOne({_id:owner,username:'benchmark-owner',status:'active',isAdmin:false});
 const coldCount=quick?2:7,repoIDs=Array.from({length:coldCount},(_,i)=>`benchmark-${i}`);
 for(const repoId of repoIDs){
  await db.collection('anonymizedrepositories').insertOne({repoId,owner,status:'ready',statusDate:new Date(),anonymizeDate:new Date('2026-01-01'),settingsSavedAt:new Date('2026-01-01'),treeGeneration:'benchmark-generation',pageView:0,source:{type:'Zip',repositoryName:'team/project',branch:'main',commit:'fixture-revision'},options:{terms:spec.terms,expirationMode:'never',image:true,pdf:true,link:true,update:false}});
  await db.collection('files').insertOne({repoId,path:'',name:spec.filename,sha:hash(body),size:body.length,treeGeneration:'benchmark-generation'});
  const original=path.join(directory,'repositories',repoId,'original');await fsp.mkdir(original,{recursive:true});await fsp.writeFile(path.join(original,spec.filename),body);
 }
 const address=await port();const [redisHost,redisPort]=redis.split(':');
 // Deliberately construct the environment: never inherit a local credential or .env.
 const env={PATH:process.env.PATH,NODE_PATH:path.join(root,'node_modules'),NODE_ENV:'production',TZ:'UTC',PORT:String(address),SESSION_SECRET:crypto.randomBytes(32).toString('hex'),CREDENTIAL_KEYS:JSON.stringify({benchmark:crypto.randomBytes(32).toString('base64')}),CREDENTIAL_ACTIVE_KEY_ID:'benchmark',GITHUB_OAUTH_ENABLED:'false',GITHUB_APP_ENABLED:'false',MONGODB_URI:mongo+'/'+database,MONGODB_DATABASE:database,REDIS_HOSTNAME:redisHost,REDIS_PORT:redisPort,FOLDER:path.join(directory,'repositories'),PUBLIC_DIR:path.join(directory,'public'),STORAGE:'filesystem',SHARED_CACHE_ENABLED:'false',CACHE_MONITORING_ENABLED:'false',COOKIE_SECURE:'false',TRUST_PROXY:'loopback',RATE_LIMIT:'1000000',ANONYMIZATION_WORKERS:'1',ANONYMIZATION_MEMORY_MB:'512',ANONYMIZATION_MASK:'XXXX',APP_HOSTNAME:'anonymous.test',TMPDIR:directory};
 const args=runtime==='node'?[path.join(compiled,'server/index.js')]:[];
 const child=spawn(runtime==='node'?process.execPath:binary,args,{cwd:directory,env,stdio:['ignore','pipe','pipe']});
 children.add(child);child.once('exit',()=>children.delete(child));
 let spawnError;child.on('error',error=>{spawnError=error;children.delete(child)});
 let logs='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{logs=(logs+b.toString()).slice(-16000)});
 const agent=new http.Agent({keepAlive:true,maxSockets:8});
 try{
  let ready=false;for(let attempt=0;attempt<200;attempt++){
   if(spawnError)throw spawnError;
   if(interrupted || child.exitCode!==null||child.signalCode!==null)throw Error(`${runtime} exited: ${logs}`);
   try{await request(address,'/api/healthcheck',null,agent);ready=true;break;}catch{await delay(100);}
  }
  if(!ready)throw Error(`${runtime} startup timeout: ${logs}`);
  // Startup jobs and index creation settle before measurement.
  await delay(1000);
  let delivered=0;
  const fileURL=id=>`/api/repo/${id}/file/${encodeURIComponent(spec.filename.replaceAll('Alice','XXXX-1'))}`;
  const drain=async()=>{for(let i=0;i<200;i++){
   const rows=await db.collection('anonymizedrepositories').aggregate([{$group:{_id:null,count:{$sum:'$pageView'}}}]).toArray();
   if(rows[0]?.count===delivered)return;await delay(10);
  }throw Error('page_view_writes_did_not_drain');};
  const measure=async(count,concurrency,getID)=>{
   let next=0,peak=usage(child.pid).rss;const before=usage(child.pid);const timer=setInterval(()=>{peak=Math.max(peak,usage(child.pid).rss)},10);
   const started=performance.now(),samples=[];
   try{
    await Promise.all(Array.from({length:concurrency},async()=>{for(;;){const n=next++;if(n>=count)return;samples.push(await request(address,fileURL(getID(n)),expected,agent));delivered++;}}));
    const elapsedMs=performance.now()-started;await drain();const after=usage(child.pid);peak=Math.max(peak,after.rss);
    return {requests:count,concurrency,elapsedMs,requestsPerSecond:count*1000/elapsedMs,p50Ms:percentile(samples.map(x=>x.ms),.5),p95Ms:percentile(samples.map(x=>x.ms),.95),maxMs:Math.max(...samples.map(x=>x.ms)),p95TTFBMs:percentile(samples.map(x=>x.ttfbMs),.95),cpuMs:Math.max(0,after.cpu-before.cpu),peakProcessTreeRssBytes:peak,samplesMs:samples.map(x=>x.ms)};
   }finally{clearInterval(timer)}
  };
  const cold=await measure(coldCount,1,n=>repoIDs[n]);
  for(let i=0;i<3;i++){await request(address,fileURL(repoIDs[0]),expected,agent);delivered++;}await drain();
  const warm=[];for(const concurrency of [1,8])warm.push(await measure(quick?16:100,concurrency,()=>repoIDs[0]));
  return {runtime,repeat,fixture:spec.name,inputBytes:body.length,outputBytes:spec.output.length,outputSHA256:expected,cold,warm};
 }catch(error){
  await delay(25);
  if(runtime==='node' && error.actual===500 && logs.includes('DataCloneError')) {
   return {runtime,repeat,fixture:spec.name,inputBytes:body.length,expectedOutputSHA256:expected,status:'failed',httpStatus:500,failure:'DataCloneError: persisted term array cannot be cloned into the anonymization worker'};
  }
  throw Error(`${runtime}/${spec.name}: ${error.message}\n${logs}`);
 }finally{agent.destroy();if(!spawnError)await stop(child);await db.dropDatabase();await fsp.rm(directory,{recursive:true,force:true});}
}
(async()=>{
 assert.equal(process.platform,'linux','process accounting requires Linux');
 const {BENCH_MONGODB_URI:mongo,BENCH_REDIS_ADDR:redis,BENCH_GO_SERVER:binary}=process.env;
 assert.match(mongo||'',/^mongodb:\/\/127\.0\.0\.1:\d+$/);assert.match(redis||'',/^127\.0\.0\.1:\d+$/);assert.ok(path.isAbsolute(binary||''));
 const quick=process.argv.includes('--quick');const output=process.argv.find(a=>a.startsWith('--output='))?.slice(9);
 const temp=await fsp.mkdtemp(path.join(os.tmpdir(),'anonymous-http-bench-'));const client=new MongoClient(mongo);
 try{
  const compiled=path.join(temp,'compiled'),sourceSHA256=await compileNode(compiled);await client.connect();
  const fixtures=[
   {name:'64 KiB changed text',filename:'Alice.txt',terms:['Alice'],body:Buffer.from('Alice hello world\n'.repeat(3641))},
   {name:'2 MiB absent terms',filename:'data.txt',terms:['Alice'],body:Buffer.from('0123456789abcdef\n'.repeat(123362))},
   {name:'128 KiB JS boundary regex',filename:'data.txt',terms:['\\bAlice\\b'],body:Buffer.from('éAliceé Alice\n'.repeat(8192))},
   {name:'2 MiB binary',filename:'image.png',terms:['Alice'],body:Buffer.alloc(2*1024*1024,0)},
  ];
  for(const spec of fixtures)spec.output=spec.name.endsWith('binary')?spec.body:Buffer.from(spec.body.toString().replaceAll('Alice','XXXX-1'));
  const results=[];for(let repeat=0;repeat<(quick?1:3);repeat++)for(const spec of fixtures)for(const runtime of repeat%2?['go','node']:['node','go']){
   if(interrupted)throw Error('benchmark_interrupted');
   console.error(`Measuring ${runtime}: ${spec.name}, repeat ${repeat+1}`);
   results.push(await runRuntime({runtime,spec,repeat,temp,compiled,client,mongo,redis,binary,quick}));
  }
  const cgroup={};for(const key of ['cpu.max','memory.max']){try{cgroup[key]=await fsp.readFile('/sys/fs/cgroup/'+key,'utf8')}catch{}}
  const report={benchmarkScriptSHA256:scriptSHA256,recordedAt:new Date().toISOString(),node:process.version,typescript:ts.version,go:process.env.BENCH_GO_VERSION,nodeSourceSHA256:sourceSHA256,goBinarySHA256:hash(await fsp.readFile(binary)),packageLockSHA256:hash(await fsp.readFile(path.join(root,'package-lock.json'))),hardware:{kernel:os.release(),cgroup,loadAverage:os.loadavg(),platform:os.platform(),arch:os.arch(),cpu:os.cpus()[0].model,logicalCPUs:os.cpus().length,availableParallelism:os.availableParallelism(),memoryBytes:os.totalmem()},method:{entrypoints:['src/server/index.ts','backend/cmd/server'],source:'pre-seeded archive originals; no external provider calls',storage:'filesystem; shared cache disabled; process-local transformed cache enabled',encoding:'identity',client:'loopback keep-alive, distinct forwarded IPv4 per request to avoid per-client throttling; both servers trust loopback',cold:'unique repository per request, same process; filesystem page cache is warm',warm:'three warmup requests then fixed-count batches at concurrency 1 and 8',cpu:'Linux process tree user+system, including waited-for children and post-response page-view writes',memory:'process-tree RSS sampled every 10 ms; excludes MongoDB, Redis and load generator',nodeCompilation:'transpileModule ES2022/CommonJS; no ts-node in measured process',quick},results};
  const data=JSON.stringify(report,null,2)+'\n';if(output){await fsp.mkdir(path.dirname(path.resolve(output)),{recursive:true});await fsp.writeFile(output,data);}else process.stdout.write(data);
 }finally{await client.close();await fsp.rm(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1});
