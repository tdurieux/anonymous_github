'use strict';
// Read-only checks against the existing synthetic shadow-demo repository.
const assert=require('node:assert/strict'),fs=require('node:fs');
const base='https://beta.durieux.me';
const report={verifiedAt:new Date().toISOString(),hostname:'beta.durieux.me',checks:[],productionChanged:false};
(async()=>{
 for(const [query,attachment] of [['download=',false],['download[]=',true],['download[x]=',true],['download=&download=',true]]) {
  const response=await fetch(base+'/api/repo/shadow-demo/file/README.md?'+query,{method:'HEAD',redirect:'manual',signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200);assert.equal(response.headers.get('x-anonymous-deployment'),'go-shadow-beta');
  assert.equal(!!response.headers.get('content-disposition'),attachment);
  assert.equal((await response.arrayBuffer()).byteLength,0);
  report.checks.push({query,status:response.status,attachment});
 }
 for(const [query,status,found] of [['q=README',200,true],['q=%EF%BB%BFREADME%EF%BB%BF',200,true],['q=%C3%A9',200,false],['q[]=README',500,false]]) {
  const response=await fetch(base+'/api/repo/shadow-demo/files/search?'+query,{redirect:'manual',signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,status);assert.equal(response.headers.get('x-anonymous-deployment'),'go-shadow-beta');
  assert.equal(response.headers.get('cache-control'),status===200?'no-cache':'no-store');
  const body=await response.json();
  if(status===500) assert.deepEqual(body,{error:'internal_error'});
  else if(found) assert.ok(body.some(file=>file.name==='README.md'));
  else assert.deepEqual(body,[]);
  report.checks.push({query,status:response.status,found});
 }
 for(const [query,status] of [['',200],['path[]=docs',500]]) {
  const response=await fetch(base+'/api/repo/shadow-demo/files?'+query,{signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,status);assert.equal(response.headers.get('x-anonymous-deployment'),'go-shadow-beta');
  const body=await response.json();
  if(status===500) assert.deepEqual(body,{error:'internal_error'});
  else {
   const readme=body.find(file=>file.name==='README.md');assert.ok(readme);
   assert.equal(readme.sha,require('node:crypto').createHash('sha1').update('fixture-readme').digest('hex').slice(0,8));
  }
  report.checks.push({endpoint:'files',query,status});
 }
 report.result='passed';fs.writeFileSync('backend/reports/shadow-file-query-deployment.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error.message);process.exitCode=1});
