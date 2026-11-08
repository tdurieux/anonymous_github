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
async function fetchSample(address,url,agent,method='GET',token='') {
 return new Promise((resolve,reject)=>{
  const start=performance.now(),id=++requestID;
  const req=http.request({host:'127.0.0.1',port:address,path:url,method,agent,headers:{...(token?{authorization:'Bearer '+token}:{}),'accept-encoding':'identity','x-forwarded-for':`10.${(id>>>16)&255}.${(id>>>8)&255}.${id&255}`}},res=>{
   const headersMs=performance.now()-start;let firstBodyMs=null;const chunks=[];
   res.on('data',chunk=>{firstBodyMs??=performance.now()-start;chunks.push(chunk)});res.on('error',reject);
   res.on('end',()=>resolve({status:res.statusCode,ms:performance.now()-start,headersMs,firstBodyMs,body:Buffer.concat(chunks)}));
  });req.setTimeout(120000,()=>req.destroy(Error('request_timeout')));req.on('error',reject);req.end();
 });
}
function signature(sample,kind) {
 if(sample.status!==200)return {status:sample.status,error:sample.body.toString().slice(0,200)};
 if(kind==='json') {
  function stable(v){if(Array.isArray(v))return v.map(stable).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().filter(k=>k!=='_id').map(k=>[k,stable(v[k])]));return v;}
  const value=JSON.parse(sample.body);return {status:200,sha256:hash(Buffer.from(JSON.stringify(stable(value)))),entries:Array.isArray(value)?value.length:Object.keys(value).length};
 }
 if(kind==='zip'){
  const manifest=execFileSync('python3',['-c',`import sys,io,zipfile,json,hashlib
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
 assert z.testzip() is None
 print(json.dumps(sorted([[n,hashlib.sha256(z.read(n)).hexdigest()] for n in z.namelist() if not n.endswith('/')]),separators=(',',':')))
`],{input:sample.body,maxBuffer:20*1024*1024});return {status:200,sha256:hash(manifest),entries:JSON.parse(manifest).length};
 }
 return {status:200,sha256:hash(sample.body)};
}
async function run({runtime,repeat,temp,compiled,client,mongo,redis,binary,snapshot,rows,cases}) {
 if(interrupted)throw Error('benchmark_interrupted');
 const directory=await fsp.mkdtemp(path.join(temp,runtime+'-')),database='repo_bench_'+crypto.randomBytes(8).toString('hex'),db=client.db(database),owner=new ObjectId();
 if(runtime==='node')await fsp.symlink(compiled,path.join(directory,'build'),'dir');await fsp.mkdir(path.join(directory,'public'));
 const repoId='same-repository',adminToken=crypto.randomBytes(32).toString('hex');
 await db.collection('users').insertOne({_id:owner,username:'benchmark-owner',status:'active',isAdmin:true,apiTokens:[{_id:new ObjectId(),name:'isolated benchmark',tokenHash:hash(Buffer.from(adminToken)),createdAt:new Date()}]});
 await db.collection('anonymizedrepositories').insertOne({repoId,owner,status:'ready',statusDate:new Date(),anonymizeDate:new Date('2026-01-01'),settingsSavedAt:new Date('2026-01-01'),treeGeneration:'fixture',pageView:0,source:{type:'Zip',repositoryName:'tdurieux/anonymous_github',branch:'main',commit:snapshot.commit},options:{terms:['tdurieux'],expirationMode:'never',image:true,pdf:true,link:true,update:false,page:true,pageSource:{branch:'main',path:'/'}}});
 await db.collection('files').insertMany(rows.map(r=>({...r,repoId,treeGeneration:'fixture'})));
 const original=path.join(directory,'repositories',repoId,'original');await fsp.mkdir(original,{recursive:true});await fsp.cp(snapshot.path,original,{recursive:true});
 const address=await port(),[redisHost,redisPort]=redis.split(':');
 const env={PATH:process.env.PATH,NODE_PATH:path.join(root,'node_modules'),NODE_ENV:'production',TZ:'UTC',PORT:String(address),SESSION_SECRET:crypto.randomBytes(32).toString('hex'),CREDENTIAL_KEYS:JSON.stringify({benchmark:crypto.randomBytes(32).toString('base64')}),CREDENTIAL_ACTIVE_KEY_ID:'benchmark',GITHUB_OAUTH_ENABLED:'false',GITHUB_APP_ENABLED:'false',MONGODB_URI:mongo+'/'+database,MONGODB_DATABASE:database,REDIS_HOSTNAME:redisHost,REDIS_PORT:redisPort,FOLDER:path.join(directory,'repositories'),PUBLIC_DIR:path.join(directory,'public'),STORAGE:'filesystem',SHARED_CACHE_ENABLED:'true',SHARED_CACHE_PATH:path.join(directory,'shared-cache'),SHARED_CACHE_FREE_BYTES:'0',CACHE_MONITORING_ENABLED:'false',COOKIE_SECURE:'false',TRUST_PROXY:'loopback',RATE_LIMIT:'1000000',ANONYMIZATION_WORKERS:'1',ANONYMIZATION_MEMORY_MB:'512',ANONYMIZATION_MASK:'XXXX',APP_HOSTNAME:'anonymous.test',TMPDIR:directory};
 if(process.env.BENCH_PROFILE_DIR)env.BENCH_PROFILE_DIR=process.env.BENCH_PROFILE_DIR;
 const child=spawn(runtime==='node'?process.execPath:binary,runtime==='node'?[path.join(compiled,'server/index.js')]:[],{cwd:directory,env,stdio:['ignore','pipe','pipe']});children.add(child);child.once('exit',()=>children.delete(child));let logs='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{logs=(logs+b).slice(-24000)});
 const agent=new http.Agent({keepAlive:true,maxSockets:8}),results=[];
 try{
  let ready=false;for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(logs);try{await request(address,'/api/healthcheck',null,agent);ready=true;break}catch{await delay(100)}}assert(ready,'startup timeout');await delay(1000);
  for(const spec of cases){
   console.error(`Measuring ${runtime} round ${repeat+1}: ${spec.name}`);
   const url=spec.url.replaceAll('{id}',repoId),cold=await fetchSample(address,url,agent,'GET',spec.kind==='zip'?adminToken:'').catch(e=>({status:0,ms:0,firstBodyMs:null,body:Buffer.from('incomplete response: '+e.message)})),expected=signature(cold,spec.kind);
   if(interrupted)throw Error('benchmark_interrupted');
   const item={name:spec.name,cold:{ms:cold.ms,firstBodyMs:cold.firstBodyMs,status:cold.status,bytes:cold.body.length},output:expected,warm:[]};results.push(item);
   if(cold.status!==200){item.diagnostic=logs.includes('DataCloneError')?'DataCloneError in TypeScript anonymization worker':expected.error;continue;}
   for(const concurrency of spec.kind==='zip'?[1]:[1,8]){
    const count=Number(process.env.BENCH_REQUESTS)||(spec.kind==='zip'?3:32);let next=0,peak=usage(child.pid).rss;const before=usage(child.pid),start=performance.now(),samples=[];const timer=setInterval(()=>{peak=Math.max(peak,usage(child.pid).rss)},20);
    try{await Promise.all(Array.from({length:concurrency},async()=>{for(;;){if(next++>=count)return;const r=await fetchSample(address,url,agent,'GET',spec.kind==='zip'?adminToken:'');assert.equal(r.status,200);samples.push(r)}}));}finally{clearInterval(timer)}
    const elapsed=performance.now()-start,after=usage(child.pid);
    // Validate outside timed load generation so ZIP decoding does not throttle either runtime.
    for(const r of samples)assert.deepEqual(signature(r,spec.kind),expected,'output changed between repeated requests');
    item.warm.push({concurrency,requests:count,p50Ms:percentile(samples.map(x=>x.ms),.5),p95Ms:percentile(samples.map(x=>x.ms),.95),p50FirstBodyMs:percentile(samples.map(x=>x.firstBodyMs),.5),requestsPerSecond:count*1000/elapsed,cpuMs:Math.max(0,after.cpu-before.cpu),peakProcessTreeRssBytes:Math.max(peak,after.rss),bytes:samples[0].body.length});
   }
  }
  return {runtime,repeat,results};
 }catch(e){throw Error(e.message+'\n'+logs)}finally{agent.destroy();await stop(child);await db.dropDatabase();await fsp.rm(directory,{recursive:true,force:true})}
}
(async()=>{
 const {BENCH_MONGODB_URI:mongo,BENCH_REDIS_ADDR:redis,BENCH_GO_SERVER:binary}=process.env;assert.match(mongo||'',/^mongodb:\/\/127\.0\.0\.1:\d+$/);assert.match(redis||'',/^127\.0\.0\.1:\d+$/);
 const temp=await fsp.mkdtemp(path.join(os.tmpdir(),'repository-comparison-')),client=new MongoClient(mongo);let upstream;
 try{
  const compiled=path.join(temp,'compiled'),nodeSourceSHA256=await compileNode(compiled);await client.connect();
  const snapshot={path:path.join(temp,'snapshot'),commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()};await fsp.mkdir(snapshot.path);
  const archive=execFileSync('git',['archive','HEAD'],{cwd:root,maxBuffer:200*1024*1024});execFileSync('tar',['-xf','-','-C',snapshot.path],{input:archive});
  const rows=[];let originalFiles=0,originalBytes=0;
  async function walk(dir,relative=''){for(const e of await fsp.readdir(dir,{withFileTypes:true})){const name=path.posix.join(relative,e.name);if(e.isDirectory()){rows.push({path:relative,name:e.name});await walk(path.join(dir,e.name),name)}else if(e.isFile()){const body=await fsp.readFile(path.join(dir,e.name));rows.push({path:relative,name:e.name,sha:hash(body),size:body.length});originalFiles++;originalBytes+=body.length;}}}await walk(snapshot.path);
  await fsp.mkdir(path.join(snapshot.path,'benchmark-1000'));rows.push({path:'',name:'benchmark-1000'});
  const js=await fsp.readFile(path.join(snapshot.path,'gulpfile.js'));
  for(let i=0;i<1000;i++){const name=`file-${String(i).padStart(4,'0')}.js`;rows.push({path:'benchmark-1000',name,sha:hash(js),size:js.length});await fsp.writeFile(path.join(snapshot.path,'benchmark-1000',name),js);}
  if(process.env.BENCH_LOCAL_ZIP==='1') {
   const fixtureZip=path.join(temp,'fixture.zip');
   execFileSync('python3',['-c',`import os,sys,zipfile
with zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:
 for parent,dirs,files in os.walk(sys.argv[1]):
  for name in sorted(files):
   p=os.path.join(parent,name);z.write(p,'fixture/'+os.path.relpath(p,sys.argv[1]))
`,snapshot.path,fixtureZip]);
   upstream=http.createServer((req,res)=>{res.setHeader('Content-Type','application/zip');fs.createReadStream(fixtureZip).pipe(res)});
   upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
   const target=path.join(compiled,'core/zipStream.js'),source=await fsp.readFile(target,'utf8');
   assert(source.includes('https://codeload.github.com/'));
   await fsp.writeFile(target,source.replaceAll('https://codeload.github.com/',`http://127.0.0.1:${upstream.address().port}/`));
  }
  const cases=[{name:'root directory',url:'/api/repo/{id}/files',kind:'json'},{name:'src directory',url:'/api/repo/{id}/files?path=src',kind:'json'},{name:'1000-file directory',url:'/api/repo/{id}/files?path=benchmark-1000',kind:'json'},{name:'file counts',url:'/api/repo/{id}/files/counts',kind:'json'},{name:'gulpfile.js',url:'/api/repo/{id}/file/gulpfile.js',kind:'file'},{name:'src/config.ts',url:'/api/repo/{id}/file/src/config.ts',kind:'file'},{name:'website gulpfile.js',url:'/w/{id}/gulpfile.js',kind:'file'},{name:'repository ZIP',url:'/api/repo/{id}/zip',kind:'zip'}];
  const results=[];for(let repeat=0;repeat<(Number(process.env.BENCH_ROUNDS)||2);repeat++)for(const runtime of (process.env.BENCH_RUNTIMES?process.env.BENCH_RUNTIMES.split(','):repeat?['go','node']:['node','go']))results.push(await run({runtime,repeat,temp,compiled,client,mongo,redis,binary,snapshot,rows,cases:process.env.BENCH_CASE?cases.filter(x=>x.name===process.env.BENCH_CASE):process.env.BENCH_SKIP_ZIP==='1'?cases.filter(x=>x.kind!=='zip'):cases}));
  const report={recordedAt:new Date().toISOString(),node:process.version,go:process.env.BENCH_GO_VERSION,nodeSourceSHA256,goBinarySHA256:hash(await fsp.readFile(binary)),benchmarkScriptSHA256:scriptSHA256,fixture:{repository:'tdurieux/anonymous_github',commit:snapshot.commit,originalFiles,originalBytes,terms:['tdurieux'],addedFixture:'1000 copies of snapshot gulpfile.js in benchmark-1000'},method:{entrypoints:['src/server/index.ts','backend/cmd/server'],provider:'Same pre-seeded archive snapshot; no GitHub API calls or production database',localZipOrigin:process.env.BENCH_LOCAL_ZIP==='1'?'Only codeload origin in temporary compiled TS redirected to loopback serving the identical snapshot ZIP; no tracked TS sources changed':false,zipAuthorization:'Disposable admin API key to allow the TypeScript local ZIP route',sharedCache:true,encoding:'identity',cold:'First endpoint request per fresh process/storage; earlier cases may warm shared dependencies',warm:process.env.BENCH_REQUESTS?`${Number(process.env.BENCH_REQUESTS)} requests per tested concurrency`:'32 requests per concurrency 1 and 8; ZIP 3 requests at concurrency 1',rounds:Number(process.env.BENCH_ROUNDS)||2,order:process.env.BENCH_RUNTIMES||'Node then Go; Go then Node',resources:'Process tree CPU and RSS; excludes MongoDB, Redis and client; CPU may include background work',scope:'HTTP backend only; excludes browser rendering, CDN, GitHub authorization and network fetch'},results};
  await fsp.writeFile(path.join(root,process.env.BENCH_OUTPUT||'backend/reports/repository-runtime-comparison.json'),JSON.stringify(report,null,2));console.log('Saved '+(process.env.BENCH_OUTPUT||'backend/reports/repository-runtime-comparison.json'));
 }finally{if(upstream)await new Promise(r=>upstream.close(r));await client.close();await fsp.rm(temp,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
