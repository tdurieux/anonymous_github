'use strict';
// Read-only measurement of one existing beta ZIP download. No credentials.
const fs=require('node:fs'),fsp=fs.promises,os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const assert=require('node:assert/strict');
const container='anonymous-go-shadow-app-1';
const pid=Number(execFileSync('docker',['inspect','--format','{{.State.Pid}}',container],{encoding:'utf8'}).trim());
const image=execFileSync('docker',['inspect','--format','{{.Image}}',container],{encoding:'utf8'}).trim();
const page=Number(execFileSync('getconf',['PAGESIZE'],{encoding:'utf8'}));
function rss(pid,seen=new Set()) {
 if(seen.has(pid))return 0;seen.add(pid);
 try {
  const raw=fs.readFileSync(`/proc/${pid}/stat`,'utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).split(' ');
  let bytes=Number(fields[21])*page;
  const children=new Set();
  for(const tid of fs.readdirSync(`/proc/${pid}/task`)) {
   try {for(const child of fs.readFileSync(`/proc/${pid}/task/${tid}/children`,'utf8').trim().split(' '))if(child)children.add(Number(child));}catch(e){if(!['ENOENT','ESRCH'].includes(e.code))throw e;}
  }
  for(const child of children)bytes+=rss(child,seen);
  return bytes;
 }catch(e){if(['ENOENT','ESRCH'].includes(e.code))return 0;throw e;}
}
const cgroup=fs.readFileSync(`/proc/${pid}/cgroup`,'utf8').trim().split('\n').find(x=>x.startsWith('0::'))?.slice(3);
function memory() {
 const result={processTreeRssBytes:rss(pid)};
 if(cgroup) {
  const root=path.join('/sys/fs/cgroup',cgroup);
  const stats=Object.fromEntries(fs.readFileSync(path.join(root,'memory.stat'),'utf8').trim().split('\n').map(s=>{const [k,v]=s.split(' ');return [k,Number(v)]}));
  result.cgroupMemoryBytes=Number(fs.readFileSync(path.join(root,'memory.current'),'utf8'));
  result.cgroupAnonymousBytes=stats.anon;
  result.cgroupFileCacheBytes=stats.file;
 }
 return result;
}
(async()=>{
 const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'zip-stream-memory-'));
 const zip=path.join(directory,'download.zip');
 const before=memory(),peak={...before};let samples=0,firstBodyMs=null,bytes=0;
 const start=performance.now();
 const timer=setInterval(()=>{const m=memory();samples++;for(const key of Object.keys(m))peak[key]=Math.max(peak[key],m[key]);},20);
 let report;
 try {
  const url='https://beta.durieux.me/api/repo/anonymous_github-72DE/zip';
  const response=await fetch(url,{headers:{'Accept-Encoding':'identity'},signal:AbortSignal.timeout(300000)});
  assert.equal(response.status,200);assert.equal(response.headers.get('x-anonymous-deployment'),'go-shadow-beta');
  const headersMs=performance.now()-start;
  const input=Readable.fromWeb(response.body);
  input.on('data',b=>{firstBodyMs??=performance.now()-start;bytes+=b.length});
  await pipeline(input,fs.createWriteStream(zip));
  const totalMs=performance.now()-start;
  clearInterval(timer);
  const after=memory();for(const key of Object.keys(after))peak[key]=Math.max(peak[key],after[key]);
  const verification=JSON.parse(execFileSync('python3',['-c',`import sys,zipfile,json,hashlib
with zipfile.ZipFile(sys.argv[1]) as z:
 manifest=[];size=0
 for e in z.infolist():
  if e.is_dir(): continue
  h=hashlib.sha256()
  with z.open(e) as f:
   for chunk in iter(lambda:f.read(65536),b''): h.update(chunk);size+=len(chunk)
  manifest.append([e.filename,h.hexdigest()])
 print(json.dumps({'files':len(manifest),'uncompressedBytes':size,'manifestSHA256':hashlib.sha256(json.dumps(sorted(manifest),separators=(',',':')).encode()).hexdigest(),'crcVerified':True}))
`,zip],{encoding:'utf8',timeout:60000}));
  report={recordedAt:new Date().toISOString(),image,url,requestID:response.headers.get('x-request-id'),method:'One public ZIP request against the existing beta repository. Existing warmed server; no restart or cache clearing. RSS includes server and worker descendants, sampled every 20 ms. Cgroup readings separately include filesystem page cache. MongoDB, Redis and client excluded. Validation runs after sampling.',samples,before,peak,after,download:{headersMs,firstBodyMs,totalMs,bytes,...verification}};
  await fsp.writeFile(path.join(__dirname,'../reports/zip-streaming-live-memory.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
 }finally{clearInterval(timer);await fsp.rm(directory,{recursive:true,force:true});}
})().catch(e=>{console.error(e.message);process.exitCode=1});
