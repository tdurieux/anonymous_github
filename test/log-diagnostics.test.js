const {expect}=require('chai');
const path=require('path');
const {Response}=globalThis;
require('ts-node/register/transpile-only');
const {errorDiagnostics,safeDiagnosticFields}=require('../src/core/log-diagnostics');
const {serializeError}=require('../src/core/logger');
const {logRecord}=require('../src/core/log-record');
const {logContext}=require('../src/core/log-context');
const {requestRoute}=require('../src/core/request-monitoring');
const {safeRedisLog,investigateLogs,logOptions}=require('../src/server/admin-log-investigation');
const secret='PRIVATE_TOKEN_owner_filename';
const frame='at printError (src/server/routes/route-utils.ts:200:7)';
function failure(){ const error=new TypeError('https://user:'+secret+'@github.com/private/repo?token='+secret); error.stack=error.message+'\n    at printError ('+path.resolve('src/server/routes/route-utils.ts')+':200:7)\n    at '+secret+' ('+path.resolve('src/server/routes/route-utils.ts')+':201:9)\n    at secret (/home/private/'+secret+':1:2)\n    at fn (https://private/'+secret+':1:2)';return error; }
describe('safe actionable exception diagnostics',()=>{
 it('retains only recognized source frames and types, never messages, URLs or roots',()=>{
  const result=errorDiagnostics(failure());
  expect(result.errorType).equal('TypeError'); expect(result.errorStack).include(frame).and.include('at <anonymous>');
  expect(JSON.stringify(result)).not.include(secret).and.not.include(process.cwd()).and.not.include('https:');
  const payload=serializeError(failure()); expect(logRecord('error','route',['failure',payload]).errorStack).include(frame);
 });
 it('bounds nested causes and frames, tolerates cycles/getters and rejects forged diagnostics',()=>{
  const error=failure();error.cause=failure();error.cause.cause=error;
  const result=errorDiagnostics(error);expect(result.causeType).equal('TypeError');expect(result.causeStack).include(frame);
  error.cause.cause={name:secret,cause:error};
  expect(errorDiagnostics(error)).include({causeType:'UnknownError'}).and.not.have.property('causeStack');
  error.stack='Error\n'+Array(40).fill(' at printError ('+path.resolve('src/server/routes/route-utils.ts')+':200:7)').join('\n');
  expect(errorDiagnostics(error).errorStack.split('\n')).length(8);
  const hostile={};Object.defineProperty(hostile,'stack',{get(){throw Error('must not run')}});
  expect(errorDiagnostics(hostile)).deep.equal({errorType:'UnknownError'});
  expect(safeDiagnosticFields({errorType:secret,errorStack:frame+'\n'+secret+'\r\n at unknown (src/private.ts:1:2)',causeStack:'x'.repeat(5000)})).deep.equal({errorStack:frame});
 });
 it('carries normalized method/route through route errors and safe Redis projection',()=>{
  const route=requestRoute('/api/repo/'+secret+'/file/private.txt?token='+secret,'api');
  expect(route).equal('/api/repo/:repoId/file/:path');
  const record=logContext.run({method:'GET',route},()=>logRecord('error','route',['failure',{...serializeError(failure()),httpStatus:500}]));
  expect(record).include({route,method:'GET',httpStatus:500,errorType:'TypeError'});
  const row=safeRedisLog({ts:new Date().toISOString(),level:'error',module:'route',raw:[record]});
  expect(row.raw[0]).include({route,method:'GET',httpStatus:500,errorType:'TypeError',errorStack:record.errorStack});
  expect(JSON.stringify(row)).not.include(secret);
  expect(logRecord('error','route',['',{route:'/private/'+secret,method:'GET\n'+secret}])).not.have.property('route');
 });
 it('preserves the same diagnostics in correlated central events and rejects unsafe fields',async()=>{
  const oldFetch=global.fetch, oldUrl=process.env.ADMIN_LOG_URL;
  try{
   process.env.ADMIN_LOG_URL='http://logs.test:9428';
   global.fetch=async()=>new Response(JSON.stringify({_time:new Date().toISOString(),service:'api',event:'application_log',module:'route',severity:'error',route:'/api/repo/:repoId',method:'GET',errorType:'TypeError',errorStack:frame,causeType:secret,stack:secret,url:secret,httpStatus:500}));
   const result=await investigateLogs(logOptions({kind:'requestId',id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},true),true);
   expect(result.events[0]).include({route:'/api/repo/:repoId',method:'GET',errorType:'TypeError',errorStack:frame,httpStatus:500});
   expect(JSON.stringify(result)).not.include(secret);
  }finally{global.fetch=oldFetch;if(oldUrl===undefined)delete process.env.ADMIN_LOG_URL;else process.env.ADMIN_LOG_URL=oldUrl;}
 });
});
