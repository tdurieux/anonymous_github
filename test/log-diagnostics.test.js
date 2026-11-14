const {expect}=require('chai');
const path=require('path');
const {Response}=globalThis;
require('ts-node/register/transpile-only');
const {errorDiagnostics,safeDiagnosticFields}=require('../src/core/log-diagnostics');
const {serializeError}=require('../src/core/logger');
const {logRecord}=require('../src/core/log-record');
const {logContext}=require('../src/core/log-context');
const {requestReproduction,safeReproductionPath}=require('../src/core/log-reproduction');
const {requestRoute}=require('../src/core/request-monitoring');
const {safeRedisLog,investigateLogs,logOptions}=require('../src/server/admin-log-investigation');
const secret='PRIVATE_TOKEN_owner_filename';
const frame='at printError (src/server/routes/route-utils.ts:200:7)';
function failure(){ const error=new TypeError('https://user:'+secret+'@github.com/private/repo?token='+secret); error.stack=error.message+'\n    at printError ('+path.resolve('src/server/routes/route-utils.ts')+':200:7)\n    at '+secret+' ('+path.resolve('src/server/routes/route-utils.ts')+':201:9)\n    at secret (/home/private/'+secret+':1:2)\n    at fn (https://private/'+secret+':1:2)';return error; }
describe('safe actionable exception diagnostics',()=>{
 it('keeps bounded anonymous file request context for failures without queries or unsafe paths',()=>{
  const requestPath='/api/repo/demo-123/file/docs/reproduce%20issue.md';
  expect(requestReproduction(requestPath+'?token=SECRET')).deep.equal({requestPath,repoId:'demo-123'});
  for(const value of ['/api/repo/owner/name/readme','https://example.test'+requestPath,requestPath+'?token=SECRET','/api/repo/demo-123/file/%0aSECRET','/api/repo/demo-123/file/../secret','/api/repo/demo-123/file/%252e%252e/secret','/api/repo/demo-123/file/https%3a%2f%2fuser:token@example.test','/api/repo/demo-123/file/'+ 'x'.repeat(2048)]) expect(safeReproductionPath(value),value).equal(undefined);
  expect(logContext.run({requestPath},()=>logRecord('info','route',['request',{status:200}]))).not.have.property('requestPath');
  const record=logContext.run({requestPath},()=>logRecord('error','route',['failure',{httpStatus:500}]));
  expect(record).include({requestPath,repoId:'demo-123'});
  expect(safeRedisLog({ts:record.timestamp,level:'error',module:'route',raw:[record]}).raw[0]).include({requestPath,repoId:'demo-123'});
 });
 it('preserves dotted allowlisted source files and anonymous/named async frames',()=>{
  const error=new Error(secret);
  error.stack='Error: '+secret+'\n    at async '+path.resolve('src/server/routes/repository-public.ts')+':224:23\n    at async printError ('+path.resolve('src/server/routes/route-utils.ts')+':200:7)\n    at '+path.resolve('src/core/model/owner-alert-lifecycle.schema.ts')+':12:3\n    at async https://'+secret+':1:2';
  const record=logRecord('error','route',['',serializeError(error)]);
  expect(record.errorStack).include('at <anonymous> (src/server/routes/repository-public.ts:224:23)').and.include(frame).and.include('at <anonymous> (src/core/model/owner-alert-lifecycle.schema.ts:12:3)');
  const redis=safeRedisLog({ts:record.timestamp,level:'error',module:'route',raw:[record]});expect(redis.raw[0].errorStack).equal(record.errorStack);
  expect(safeDiagnosticFields({errorStack:'at <anonymous> (src/core/model/not-allowlisted.schema.ts:12:3)'})).deep.equal({});
  expect(JSON.stringify(record)).not.include(secret);
  error.stack='Error: '+secret+'\n    at external ('+path.resolve('node_modules/dependency/index.js')+':1:2)\n    at async '+path.resolve('src/server/routes/repository-public.ts')+':224:23';
  expect(errorDiagnostics(error).errorStack).equal('at <anonymous> (src/server/routes/repository-public.ts:224:23)');
 });
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
