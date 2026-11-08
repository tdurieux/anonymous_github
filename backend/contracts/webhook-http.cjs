const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const express = require('express');
const ts = require('typescript');
const source = fs.readFileSync('src/server/routes/github-app.ts', 'utf8');
const code = ts.transpileModule(source.slice(source.indexOf('export function validWebhookSignature')).replaceAll('export ', ''), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const secret = 'synthetic-webhook-contract';
const config = {GITHUB_APP_ENABLED:true,GITHUB_APP_WEBHOOK_SECRET:secret,GITHUB_APP_ID:'123'};
const unavailable = () => {throw new Error('contract must not access database or upstream')};
const router = new Function('express','config','createHmac','timingSafeEqual','UserModel','InstallationModel','reconcileAppGrant','reconcileInstallation','clearAppTokenCache','randomUUID',code+'\nreturn githubAppWebhook;')(express,config,crypto.createHmac,crypto.timingSafeEqual,{find:unavailable},{updateOne:unavailable},unavailable,unavailable,unavailable,crypto.randomUUID);
const cases = [];
for(const event of ['ping','installation','installation_repositories','github_app_authorization']) {
 for(const body of ['{}','null','[]','true','42','"hello"','{','', '{"action":"revoked"}', '{"action":"revoked","sender":null}']) cases.push({name:`${event}-${cases.length}`,event,body,contentType:'application/json'});
}
for(const contentType of ['', 'text/plain','application/vnd.github+json','application/json; charset=utf-8','Application/JSON']) cases.push({name:`content-type-${cases.length}`,event:'ping',body:'{}',contentType});
cases.push({name:'invalid-signature',event:'ping',body:'{}',contentType:'application/json',tampered:true});
cases.push({name:'disabled-app',event:'ping',body:'{}',contentType:'application/json',disabled:true});
for(const size of [1024*1024+1,2*1024*1024,2*1024*1024+1]) cases.push({name:`body-size-${size}`,event:'ping',size,contentType:'application/json'});
const compressors={gzip:zlib.gzipSync,deflate:zlib.deflateSync,br:zlib.brotliCompressSync,zstd:zlib.zstdCompressSync};
for(const encoding of ['gzip','deflate','br','zstd']) {
 for(const mode of ['valid','truncated','corrupt','wire-signature','boundary','oversized']) cases.push({name:`${encoding}-${mode}`,event:'ping',body:'{}',contentType:'application/json',encoding,mode,...(mode==='boundary'?{size:2*1024*1024}:mode==='oversized'?{size:2*1024*1024+1}:{})});
}
for(const encoding of ['identity','GZIP','unknown','gzip, deflate']) cases.push({name:`encoding-${encoding}`,event:'ping',body:'{}',contentType:'application/json',encoding,mode:'valid'});
const app = express(); app.use('/webhook',router);
// Record parser status without depending on Express's environment-specific HTML error page.
app.use((err,req,res,next)=>res.status(err.status||500).end());
(async()=>{
 const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
 try {
  for(const item of cases){
   config.GITHUB_APP_ENABLED=!item.disabled;
   const body=item.size ? '{"padding":"'+'x'.repeat(item.size-14)+'"}' : item.body;
   let wire=Buffer.from(body);
   if(item.encoding && compressors[item.encoding.toLowerCase()])wire=compressors[item.encoding.toLowerCase()](wire);
   if(item.mode==='truncated')wire=wire.subarray(0,wire.length-2);
   if(item.mode==='corrupt')wire=Buffer.from('not a compressed stream');
   if(item.encoding)item.wire=wire.toString('base64');
   const signature='sha256='+crypto.createHmac('sha256',secret).update(item.mode==='wire-signature'?wire:body).digest('hex');
   const headers={'x-github-event':item.event,'x-hub-signature-256':item.tampered?'sha256='+'0'.repeat(64):signature};
   if(item.contentType)headers['content-type']=item.contentType;
   if(item.encoding)headers['content-encoding']=item.encoding;
   // A Buffer prevents fetch from adding a text/plain content type.
   const res=await fetch(`http://127.0.0.1:${server.address().port}/webhook`,{method:'POST',headers,body:wire});
   item.status=res.status;
   const text=await res.text();
   if(text && res.headers.get('content-type')?.includes('application/json')) item.error=JSON.parse(text).error;
  }
 } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
 const path='backend/internal/server/testdata/webhook-http.json', output=JSON.stringify(cases,null,2)+'\n';
 if(process.argv.includes('--check'))assert.equal(fs.readFileSync(path,'utf8'),output);else fs.writeFileSync(path,output);
 console.log(`${cases.length} TypeScript webhook HTTP contracts verified`);
})().catch(error=>{console.error(error);process.exitCode=1});
