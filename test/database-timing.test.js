const {expect}=require('chai');
require('ts-node/register/transpile-only');
const mongoose=require('mongoose');
const {installDatabaseTiming}=require('../src/core/database-timing');
const {monitorRequests,RequestMetrics}=require('../src/core/request-monitoring');
const express=require('express');
const http=require('node:http');
describe('database execution timing',()=>{
 it('preserves query receiver, result and failure while measuring execution once',async()=>{
  const Model=mongoose.model("TimingFixture",new mongoose.Schema({}));
  const logs=[];const app=express();let server;
  try{
   installDatabaseTiming();const wrapped=mongoose.Query.prototype.exec;installDatabaseTiming();expect(mongoose.Query.prototype.exec).equal(wrapped);
   app.use(monitorRequests('api',new RequestMetrics(),{info:(_,row)=>logs.push(row),warn:(_,row)=>logs.push(row)}));
   app.get('/',async(_req,res)=>{
    const query=Model.find();query._find=async function(){expect(this).equal(query);await new Promise(r=>setTimeout(r,20));return ['ok'];};
    expect(await query.exec()).deep.equal(['ok']);
    const failed=Model.find();const error=new Error('PRIVATE query');failed._find=async()=>{throw error;};
    try{await failed.exec();throw Error('expected failure');}catch(e){expect(e).equal(error);}
    res.end('ok');
   });
   server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
   await new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:server.address().port},res=>{res.resume();res.on('end',resolve);}).on('error',reject));
   expect(logs[0].stageCounts.database).equal(2);expect(logs[0].stages.database).greaterThan(15);expect(logs[0].stageOpen.database).equal(0);
   expect(JSON.stringify(logs)).not.include('PRIVATE');
  }finally{mongoose.deleteModel("TimingFixture");if(server)await new Promise(resolve=>server.close(resolve));}
 });
});
