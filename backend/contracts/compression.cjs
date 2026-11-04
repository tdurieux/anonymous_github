const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const http=require('node:http');
const zlib=require('node:zlib');
const crypto=require('node:crypto');
const express=require('express');
const compression=require('compression');
const ts=require('typescript');
const tree=ts.createSourceFile('index.ts',fs.readFileSync('src/server/index.ts','utf8'),ts.ScriptTarget.Latest,true);
let argument;
function visit(node){if(ts.isCallExpression(node)&&node.expression.getText(tree)==='compression')argument=node.arguments[0].getText(tree);ts.forEachChild(node,visit)}
visit(tree);assert.ok(argument);
const options=vm.runInNewContext(ts.transpileModule(`(${argument})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{compression});
const cases=[];
function add(overrides){cases.push({name:`compression-${cases.length}`,path:'/api/example',method:'GET',type:'application/json',size:2048,accept:'gzip',...overrides})}
for(const accept of ['', 'gzip','br','deflate','identity','*','gzip, br','deflate, gzip','identity, gzip','GZIP','gzip;q=0','*;q=0','gzip;q=0,*','gzip;q=0.5,identity;q=1','gzip;q=1,br;q=.5','deflate;q=.5,gzip;q=.5','deflate;q=1,identity;q=1','unknown','gzip;q=NaN','gzip;q=1junk','gzip;q=-1','gzip;q=2','gzip;Q=0','gzip;q =0','gzip;q=0,gzip;q=1','gzip;q=1,gzip;q=0','br;q=0,*;q=.5','gzip;q=Infinity','gzip;q=0.1; q=1'])add({accept});
for(const type of ['','text/plain','Text/HTML; charset=UTF-8','application/json','application/problem+json','application/javascript','application/octet-stream','application/pdf','image/png','image/svg+xml','font/woff2','text/event-stream','application/unknown','application/example+xml','text/x-unknown'])for(const size of [0,10,1023,1024])add({type,size});
for(const control of ['no-transform','public, no-transform','NO-TRANSFORM','no-transform=1','x-no-transform','public, no-transform , max-age=60'])add({control});
for(const path of ['/api/repo/x/file/a','/api/repo/x/y/file/a','/api/repo/x/files','/api/repo/x/file','/w/x/index.html'])add({path});
for(const stream of [true,false])for(const size of [0,10,2048])add({stream,size});
for(const vary of ['Origin','accept-encoding','*','Origin, Accept-Language'])add({vary});
for(const preset of ['identity','custom','gzip'])add({preset});
for(const method of ['HEAD'])for(const size of [10,2048])add({method,size});
for(const status of [204,304])add({status});
const app=express();app.use(compression(options));
let active;
app.use((req,res)=>{const c=active;res.statusCode=c.status||200;if(c.type)res.setHeader('Content-Type',c.type);if(c.control)res.setHeader('Cache-Control',c.control);if(c.vary)res.setHeader('Vary',c.vary);if(c.preset)res.setHeader('Content-Encoding',c.preset);const body=Buffer.alloc(c.size,120);if(!c.stream)res.setHeader('Content-Length',body.length);if(c.stream){res.write(body);res.end()}else res.end(body)});
(async()=>{const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));try{
 for(const c of cases){active=c;const result=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:c.path,method:c.method,headers:c.accept?{'accept-encoding':c.accept}:{}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({headers:res.headers,status:res.statusCode,wire:Buffer.concat(chunks)}));res.on('error',reject)});req.on('error',reject);req.end()});
 let body=result.wire;const encoding=result.headers['content-encoding']||'';
 if(body.length&&(!c.preset||c.preset==='identity')){if(encoding==='gzip')body=zlib.gunzipSync(body);if(encoding==='deflate')body=zlib.inflateSync(body);if(encoding==='br')body=zlib.brotliDecompressSync(body)}
 c.expected={status:result.status,encoding,vary:result.headers.vary||'',length:result.headers['content-length']||'',bodyBytes:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')};
 }
}finally{server.close()}
const files={'backend/internal/server/testdata/compression.json':cases,'backend/internal/filetype/compressible.json':Object.fromEntries(Object.entries(require('mime-db')).filter(([,v])=>v.compressible!==undefined).map(([k,v])=>[k,v.compressible]).sort(([a],[b])=>a<b?-1:a>b?1:0))};
for(const [target,value]of Object.entries(files)){const serialized=JSON.stringify(value,null,2)+'\n';if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),serialized);else fs.writeFileSync(target,serialized)}
console.log(`${cases.length} TypeScript compression HTTP contracts ${process.argv.includes('--check')?'verified':'generated'}`)
})().catch(e=>{console.error(e);process.exitCode=1});
