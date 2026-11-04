const fs=require('node:fs');const assert=require('node:assert/strict');const http=require('node:http');const express=require('express');const etag=require('etag');
assert.match(fs.readFileSync('src/server/index.ts','utf8'),/app\.set\("etag", "strong"\)/);
const cases=[];const value={a:'<é>\u2028\u2029',z:42};
function add(overrides){cases.push({name:`json-http-${cases.length}`,method:'GET',status:200,value,...overrides})}
const current=etag(JSON.stringify(value));
for(const match of ['',current,'W/'+current,'"stale", '+current,'*','"stale"',current+', "other"','\t'+current])for(const method of ['GET','HEAD','POST','QUERY'])add({method,match});
for(const control of ['no-cache','max-age=0, no-cache','NO-CACHE','no-cache=1','max-age=0'])add({match:current,control});
for(const status of [201,204,205,304,400,401,403,500])for(const match of ['', '*'])add({status,match});
for(const since of ['Wed, 01 Jan 2025 00:00:00 GMT','Tue, 31 Dec 2024 00:00:00 GMT','invalid'])add({since,modified:'Wed, 01 Jan 2025 00:00:00 GMT'});
add({match:current,since:'invalid'});add({match:'"stale"',since:'Wed, 01 Jan 2030 00:00:00 GMT',modified:'Wed, 01 Jan 2025 00:00:00 GMT'});
for(const value of [null,[],{},'literal \\u2028 then \u2028',true,0,{value:null}])add({value});
add({preset:'"custom"',match:'W/"custom"'});
const app=express();app.set('etag','strong');app.use((req,res)=>{const c=cases[Number(req.headers['x-fixture'])];if(c.modified)res.set('Last-Modified',c.modified);if(c.preset)res.set('ETag',c.preset);res.status(c.status).json(c.value)});
(async()=>{const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));try{for(let i=0;i<cases.length;i++){const c=cases[i];const headers={'x-fixture':String(i)};if(c.match)headers['if-none-match']=c.match;if(c.control)headers['cache-control']=c.control;if(c.since)headers['if-modified-since']=c.since;
 c.expected=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/',method:c.method,headers},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,etag:res.headers.etag||'',type:res.headers['content-type']||'',length:res.headers['content-length']||'',body:Buffer.concat(chunks).toString('utf8')}));res.on('error',reject)});req.on('error',reject);req.end()});
}}finally{server.close()}
const target='backend/internal/server/testdata/json-http.json';const text=JSON.stringify(cases,null,2)+'\n';if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),text);else fs.writeFileSync(target,text);console.log(`${cases.length} Express JSON HTTP contracts ${process.argv.includes('--check')?'verified':'generated'}`);
})().catch(e=>{console.error(e);process.exitCode=1});
