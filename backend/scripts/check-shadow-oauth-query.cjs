'use strict';
// Beta-only rejection checks. State and cookies remain in memory and are not
// included in reports. Invalid parameters must stop before token exchange.
const assert=require('node:assert/strict'),fs=require('node:fs');
const base='https://beta.durieux.me';
const trace=[];
const local=process.argv.includes('--local');
const dispatcher=local?new (require('undici').Agent)({connect:{lookup:(_host,options,callback)=>options.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4)}}):undefined;
const report={verifiedAt:new Date().toISOString(),hostname:'beta.durieux.me',accessMode:local?'local TLS proxy with hostname verification':'public DNS',checks:[],productionChanged:false};
async function request(path,cookie='') {
 const response=await fetch(base+path,{dispatcher,headers:cookie?{Cookie:cookie}:{},redirect:'manual',signal:AbortSignal.timeout(45000)});
 trace.push({path:path.split('?')[0],status:response.status,deployment:response.headers.get('x-anonymous-deployment'),hasCookie:!!response.headers.get('set-cookie')});
 assert.equal(response.headers.get('x-anonymous-deployment'),'go-shadow-beta');
 return response;
}
async function begin(cookie='') {
 const response=await request('/github/app/login',cookie);assert.equal(response.status,302);
 const state=new URL(response.headers.get('location')).searchParams.get('state');assert(state);
 const nextCookie=(response.headers.get('set-cookie')||'').split(';')[0];assert(nextCookie);
 return {state,cookie:nextCookie};
}
async function reject(path,cookie,error) {
 const response=await request(path,cookie);assert.equal(response.status,400);assert.equal((await response.json()).error,error);
}
(async()=>{
 for(const [name,extra,error] of [['mixed-state','&state[]=extra','invalid_auth_state'],['mixed-code','&code[]=extra','github_app_authorization_cancelled'],['empty-array-error','&error[]=','github_app_authorization_cancelled']]) {
  const start=await request('/github/app/login');assert.equal(start.status,302);
  const state=new URL(start.headers.get('location')).searchParams.get('state');assert(state);
  const cookie=(start.headers.get('set-cookie')||'').split(';')[0];assert(cookie);
  try {
   const callback='/github/app/callback?state='+encodeURIComponent(state)+'&code=synthetic-invalid-code';
   const rejected=await request(callback+extra,cookie);assert.equal(rejected.status,400);assert.equal((await rejected.json()).error,error);
   const replay=await request(callback,cookie);assert.equal(replay.status,400);assert.equal((await replay.json()).error,'invalid_auth_state');
   report.checks.push({name,status:400,error,replayRejected:true});
  } finally {const user=await request('/api/user',cookie);assert.equal(user.status,401);}
 }
 for(const [name,query] of [['missing-state',''],['bracket-only-state','state[]='],['wrong-state','state=wrong']]) {
  const flow=await begin();
  await reject('/github/app/callback?'+query+'&code=synthetic-invalid-code',flow.cookie,'invalid_auth_state');
  await reject('/github/app/callback?state='+flow.state+'&code=synthetic-invalid-code',flow.cookie,'invalid_auth_state');
  report.checks.push({name,status:400,replayRejected:true});
 }
 const first=await begin(),second=await begin(first.cookie);
 await reject('/github/app/callback?state='+first.state+'&code=synthetic-invalid-code',second.cookie,'invalid_auth_state');
 await reject('/github/app/callback?state='+second.state+'&code=synthetic-invalid-code',second.cookie,'invalid_auth_state');
 report.checks.push({name:'superseded-attempt',status:400,replayRejected:true});
 const owner=await begin(),other=await begin();
 await reject('/github/app/callback?state='+owner.state+'&code=synthetic-invalid-code',other.cookie,'invalid_auth_state');
 await reject('/github/app/callback?state='+owner.state+'&error=cancelled',owner.cookie,'github_app_authorization_cancelled');
 report.checks.push({name:'foreign-session-cannot-consume-owner-flow',status:400});
 report.result='passed';
 fs.writeFileSync('backend/reports/shadow-oauth-query-deployment.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
})().catch(()=>{console.error('Beta OAuth query rejection check failed; credentials and state omitted.');console.error(JSON.stringify(trace));process.exitCode=1}).finally(()=>dispatcher?.close());
