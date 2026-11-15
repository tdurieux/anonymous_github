const {expect}=require('chai');
const {randomUUID}=require('node:crypto');
require('ts-node/register/transpile-only');
const {incidentGroups}=require('../src/server/admin-log-investigation');
describe('bounded incident evidence',()=>{
 const base={timestamp:'2026-11-15T10:00:00Z',service:'api',module:'route',event:'application_log',severity:'error',errorCode:'upstream_error',errorType:'Error',httpStatus:502,release:'abcdef1',errorStack:'at printError (src/server/routes/route-utils.ts:200:7)'};
 it('counts affected request UUIDs once without inventing identities for historical records',()=>{
  const id=randomUUID();const groups=incidentGroups([base,{...base,requestId:id},{...base,requestId:id},{...base,requestId:randomUUID(),timestamp:'2026-11-15T11:00:00Z'}]);
  expect(groups).length(1);expect(groups[0]).include({count:4,affectedRequests:2,uncorrelatedRecords:1,first:base.timestamp,last:'2026-11-15T11:00:00Z',regression:'unknown'});
 });
 it('compares stable stack functions across line shifts, retaining unknown for missing/partial baselines',()=>{
  const shifted={...base,errorStack:'at printError (src/server/routes/route-utils.ts:220:9)',release:'abcdef2'};
  expect(incidentGroups([shifted],{records:[base],partial:true})[0].regression).equal('known');
  expect(incidentGroups([shifted],{records:[],partial:false})[0].regression).equal('unknown');
  const different={...base,errorCode:'preparation_interrupted'};
  expect(incidentGroups([different],{records:[base],partial:true})[0].regression).equal('unknown');
  expect(incidentGroups([different],{records:[base],partial:false})[0].regression).equal('not_seen_in_baseline');
  expect(incidentGroups([base,different])).length(2);
 });
});
