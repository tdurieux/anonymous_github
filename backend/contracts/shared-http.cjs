const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const http=require('node:http'),zlib=require('node:zlib'),crypto=require('node:crypto'),stream=require('node:stream');
const express=require('express'),ts=require('typescript');
const fixture={exports:{}};
let active;
const results={decision:()=>({digest:active.record.digest,changed:false})};
const dependencies={zlib,crypto,stream,'stream/promises':require('node:stream/promises'),perf_hooks:require('node:perf_hooks'),'../config':{default:{ANONYMIZATION_MASK:'XXXX',APP_HOSTNAME:'anonymous.test',additionalExtensions:[]}},'./blob-cache':{resultBlobCache:()=>results,CacheAdmissionError:class extends Error{}},'./anonymize-utils':{},'./cache-observability':{observeCache(){}}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/core/cached-response.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:fixture,exports:fixture.exports,require:name=>{assert.ok(dependencies[name],name);return dependencies[name]}});
const cases=[];
const accepts=['','gzip','identity','br','deflate','*','identity, gzip','gzip, identity','gzip;q=.5,identity;q=1','gzip;q=1,identity;q=.5','gzip;q=0','identity;q=0','*;q=0','gzip,identity;q=0','identity;q=0,br','gzip;q=0,*;q=1','*;q=0,gzip;q=1','gzip;q=NaN','gzip;q=-1','gzip;q=2','gzip;q=Infinity','gzip;q=1junk','gzip;q= 0.5','gzip;Q=0','gzip;q =0','gzip;q=0,gzip;q=1','gzip;q=1,gzip;q=0','gzip garbage','GZIP', 'unknown;q=-1,gzip',',,,gzip','gzip,,,','gzip;q="0"','gzip;q="0.5,identity;q=0"','gzip;q="\\0"','gzip;q="0','gzip;q=','gzip;q=;q=0','gzip;q=0;q=1','gzip;Q = "0.5"','gzip;broken;q=0','gzip garbage;q=-1','gzip;level="a,b;c";q=0','identity;q=0,*;q=.5'];
for(const store of ['identity','gzip'])for(const accept of accepts)cases.push({store,size:2250,accept,method:'GET'});
for(const size of [0,17])for(const accept of ['','gzip','gzip,identity;q=0','*;q=0'])cases.push({store:'identity',size,accept,method:'GET'});
for(const vary of ['Origin','accept-encoding','*','Origin, Accept-Language'])cases.push({store:'gzip',size:2250,accept:'gzip',method:'GET',vary});
for(const store of ['identity','gzip'])for(const accept of ['','gzip','gzip,identity;q=0','*;q=0'])cases.push({store,size:2250,accept,method:'HEAD'});
const app=express();app.use(async(req,res)=>{
 try{
  res.set('Content-Type','application/octet-stream');if(active.vary)res.set('Vary',active.vary);
  const content=stream.Readable.from([active.body]);content.cachedBlob={record:active.record,store:active.store};
  assert.equal(await fixture.exports.sendSharedContent(content,res,{filePath:'file.bin'}),true);
 }catch(error){console.error(error);res.destroy(error)}
});
(async()=>{
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{for(const c of cases){
  const body=Buffer.alloc(c.size,120),wire=c.store==='gzip'?zlib.gzipSync(body):body;
  const record={digest:'sha256-'+crypto.createHash('sha256').update(body).digest('hex'),encoding:c.store,size:body.length,stored:wire.length};
  const store={open:async(_digest,encoded)=>{const output=stream.Readable.from([encoded&&record.encoding==='gzip'?wire:body]);output.cachedBlob={record,store};return output}};
  active={body,record,store,vary:c.vary};
  const response=await new Promise((resolve,reject)=>{
   const request=http.request({host:'127.0.0.1',port:server.address().port,path:'/file',method:c.method,headers:c.accept?{'accept-encoding':c.accept}:{}},res=>{
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({headers:res.headers,status:res.statusCode,wire:Buffer.concat(chunks)}));res.on('error',reject);
   });request.on('error',reject);request.end();
  });
  let decoded=response.wire;if(decoded.length&&response.headers['content-encoding']==='gzip')decoded=zlib.gunzipSync(decoded);
  c.expected={status:response.status,encoding:response.headers['content-encoding']||'',length:response.headers['content-length']||'',vary:response.headers.vary||'',ranges:response.headers['accept-ranges']||'',bodyBytes:decoded.length,sha256:crypto.createHash('sha256').update(decoded).digest('hex')};
  if(c.store==='gzip'&&c.method==='GET'&&c.expected.encoding==='gzip'&&c.expected.status===200)c.expected.wire=wire.toString('base64');
 }}finally{server.close()}
 const target='backend/internal/server/testdata/shared-http.json',data=JSON.stringify(cases,null,2)+'\n';
 if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),data);else fs.writeFileSync(target,data);
 console.log(`${cases.length} TypeScript shared HTTP contracts ${process.argv.includes('--check')?'verified':'generated'}`);
})().catch(e=>{console.error(e);process.exitCode=1});
