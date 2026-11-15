const { expect } = require('chai');
require('ts-node/register/transpile-only');
const { RequestTiming, requestRoute } = require('../src/core/request-monitoring');
const { recordResponseFailure, recordUpstreamFailure, responseEvidence, expectedResponseBytes } = require('../src/core/request-evidence');
const { logRecord } = require('../src/core/log-record');
const { safeRedisLog } = require('../src/server/admin-log-investigation');

describe('request causal evidence and timing accounting', () => {
  it('integrates nested, parallel, repeated and unfinished spans without invented totals', () => {
    let now = 0;
    const timing = new RequestTiming(0, () => now);
    now = 10; const credential = timing.start('credential_resolution');
    now = 20; const db = timing.start('database');
    now = 30; const upstream = timing.start('upstream');
    now = 40; db(); db();
    now = 50; upstream(); credential();
    now = 60; timing.start('upstream');
    now = 70; const snapshot = timing.finish();
    expect(snapshot).deep.equal({stages:{credential_resolution:40,database:20,upstream:30},
      stageCounts:{credential_resolution:1,database:1,upstream:2},stageOpen:{credential_resolution:0,database:0,upstream:1},
      measuredMs:50,unattributedMs:20,overlapMs:40});
    now = 100; upstream(); timing.start('database')();
    expect(timing.finish()).deep.equal(snapshot);
  });
  it('bounds storage across repeated spans', () => {
    let now = 0; const timing = new RequestTiming(0, () => now++);
    for(let i=0;i<100000;i++) timing.start('upstream')();
    const result=timing.finish();
    expect(result.stageCounts.upstream).equal(100000);
    expect(JSON.stringify(timing).length).lessThan(500);
  });
  it('keeps disconnect origins unknown and preserves the first causal evidence', () => {
    expect(responseEvidence({})).deep.equal({cancellationOrigin:'unknown',cancellationEvidence:'response_close'});
    expect(responseEvidence({},true).cancellationOrigin).equal('unknown');
    const res={}; recordUpstreamFailure(res,Object.assign(new Error('PRIVATE'),{code:'ETIMEDOUT'}));
    recordResponseFailure(res,'api','local_abort');
    expect(responseEvidence(res)).deep.equal({cancellationOrigin:'timeout',cancellationEvidence:'timeout'});
    const upstream={};recordUpstreamFailure(upstream,new Error('PRIVATE'),'streamer');
    expect(responseEvidence(upstream)).deep.equal({cancellationOrigin:'streamer',cancellationEvidence:'upstream_error'});
    const local={};recordResponseFailure(local,'api','local_abort');expect(responseEvidence(local).cancellationOrigin).equal('api');
  });
  it('only compares body bytes with the output content length', () => {
    expect(expectedResponseBytes('GET',200,'123')).equal(123);
    expect(expectedResponseBytes('HEAD',200,'123')).equal(0);
    expect(expectedResponseBytes('GET',304,'123')).equal(0);
    for(const value of [undefined,-1,'1.2','9e5','9007199254740992',{},['123']]) expect(expectedResponseBytes('GET',200,value)).equal(undefined);
  });
  it('preserves bounded evidence and timings through the admin projection', () => {
    const row=logRecord('warn','requests',['request interrupted',{outcome:'interrupted',bytes:12,expectedBytes:50,
      cancellationOrigin:'unknown',cancellationEvidence:'response_close',endpointKind:'public',measuredMs:20,unattributedMs:10,overlapMs:5,
      stages:{database:3,upstream:17,PRIVATE:123},stageCounts:{upstream:2},stageOpen:{upstream:1}}]);
    const safe=safeRedisLog({ts:row.timestamp,level:'warn',module:'requests',raw:[row]}).raw[0];
    expect(safe).include({bytes:12,expectedBytes:50,cancellationOrigin:'unknown',cancellationEvidence:'response_close',
      endpointKind:'public',measuredMs:20,unattributedMs:10,overlapMs:5,stage_database_ms:3,stage_upstream_ms:17,stage_upstream_count:2,stage_upstream_open:1});
    expect(JSON.stringify(safe)).not.include('PRIVATE');
    const bad=logRecord('warn','requests',['request interrupted',{cancellationOrigin:'PRIVATE',cancellationEvidence:'PRIVATE',endpointKind:'PRIVATE'}]);
    expect(JSON.stringify(bad)).not.include('PRIVATE');
  });
  it('respects source handler precedence and canonical anonymous route IDs', () => {
    for(const action of ['readme','branches','tree','file']) expect(requestRoute('/api/repo/private/files/'+action,'api')).equal('/api/repo/:owner/:repo/'+action);
    expect(requestRoute('/api/repo/demo/file/readme','api')).equal('/api/repo/:repoId/file/:path');
    for(const action of ['coauthors','extend','refresh']) {
      expect(requestRoute('/api/repo/private/'+action,'api','GET')).equal('/api/repo/:owner/:repo');
      expect(requestRoute('/api/repo/demo/'+action,'api','POST')).equal('/api/repo/:repoId/'+action);
    }
    expect(logRecord('info','requests',['request',{route:'/api/repo/:id/files'}]).route).equal('/api/repo/:repoId/files');
  });
});
