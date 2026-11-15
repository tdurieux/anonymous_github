const {expect}=require('chai');
const express=require('express');
const http=require('node:http');
const {Readable}=require('node:stream');
require('ts-node/register/transpile-only');
const {monitorRequests,RequestMetrics}=require('../src/core/request-monitoring');
const GitHubStream=require('../src/core/source/GitHubStream').default;
const {AnonymizeTransformer}=require('../src/core/anonymize-utils');
const streamer=require('../src/streamer/route').default;
const config=require('../src/config').default;
describe('streamer failure provenance',()=>{
 for(const mode of ['cache','transform']) it(`records ${mode} failures before teardown without inventing upstream provenance`,async()=>{
  const originalCache=GitHubStream.prototype.getFileContentCache,originalTransform=AnonymizeTransformer.prototype._transform,shared=config.SHARED_CACHE_ENABLED;
  const logs=[];let server;
  try{
   config.SHARED_CACHE_ENABLED=false;
   GitHubStream.prototype.getFileContentCache=async()=>{
    const input=new Readable({read(){}});
    setTimeout(()=>input.push(Buffer.from('partial')),10);
    if(mode==='cache')setTimeout(()=>input.destroy(Object.assign(new Error('PRIVATE cache path'),{code:'EIO'})),30);
    else setTimeout(()=>input.push(Buffer.from('fail')),30);
    return input;
   };
   AnonymizeTransformer.prototype._transform=function(chunk,_encoding,done){
    if(mode==='transform'&&chunk.toString()==='fail')done(new Error('PRIVATE output spool'));
    else {this.push(chunk);done();}
   };
   const app=express();app.use(monitorRequests('streamer',new RequestMetrics(),{info:(_,r)=>logs.push(r),warn:(_,r)=>logs.push(r)}));app.use(express.json());app.use('/api',streamer);
   server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
   await new Promise(resolve=>{
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/api',method:'POST',headers:{'content-type':'application/json'}},res=>{res.resume();res.on('close',resolve);});
    req.on('error',resolve);req.end(JSON.stringify({token:'',repoFullName:'PRIVATE/repo',repoId:'demo',filePath:'file.txt',anonymizerOptions:{terms:[],filePath:'file.txt'}}));
   });
   await new Promise(resolve=>setTimeout(resolve,20));
   expect(logs).length(1);expect(logs[0]).include({status:200,outcome:'interrupted',cancellationOrigin:mode==='transform'?'streamer':'unknown',cancellationEvidence:'local_abort',bytes:7});
  }finally{GitHubStream.prototype.getFileContentCache=originalCache;AnonymizeTransformer.prototype._transform=originalTransform;config.SHARED_CACHE_ENABLED=shared;if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
 });
});
