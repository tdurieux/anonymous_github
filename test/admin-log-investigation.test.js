const { expect } = require('chai');
const { Response } = globalThis;
const { randomUUID } = require('crypto');
require('ts-node/register/transpile-only');
const { logOptions, investigateLogs, safeRedisLog } = require('../src/server/admin-log-investigation');
const { logContext } = require('../src/core/log-context');
const envKeys = ['ADMIN_LOG_URL', 'ADMIN_LOG_VECTOR_URL', 'ADMIN_LOG_GRAFANA_URL', 'LOG_REDIS_MIRROR'];

describe('bounded admin log investigation', function () {
  this.timeout(10000);
  let saved, originalFetch, calls;
  const id = randomUUID(), job = randomUUID();
  const event = extra => ({ _time: new Date().toISOString(), event: 'job_failed', severity: 'error', module: 'queue', service: 'worker', release: 'abcdef1', requestId: id, jobId: job, errorCode: 'upstream_error', ...extra });
  beforeEach(() => {
    saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]])); originalFetch = global.fetch; calls = [];
    envKeys.forEach(key => delete process.env[key]);
    global.fetch = async (url, options) => { calls.push([url, options]); return new Response(''); };
  });
  afterEach(() => { global.fetch = originalFetch; for (const key of envKeys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key]; });
  it('is disabled without any backend calls and reports mirror off independently', async () => {
    process.env.LOG_REDIS_MIRROR = 'off';
    const result = await investigateLogs(logOptions({}));
    expect(result).to.include({state:'disabled', redisCollecting:false}); expect(calls).to.have.length(0);
  });
  it('rejects arbitrary queries, URLs, arrays, excessive windows and injected opaque IDs', () => {
    for (const query of [{q:'*'}, {url:'http://127.0.0.1'}, {window:'7d'}, {window:['1h']}, {release:'abc" OR *'}, {service:'api OR *'}]) expect(() => logOptions(query)).to.throw();
    for (const query of [{id:'a" OR *',kind:'jobId'}, {id,kind:'url'}, {id:[id],kind:'requestId'}, {id,kind:'jobId',release:'abcdef1'}]) expect(() => logOptions(query,true)).to.throw();
  });
  it('bounds results, projects private fields, groups stable fingerprints and keeps admin context out', async () => {
    process.env.ADMIN_LOG_URL = 'http://logging.test:9428';
    global.fetch = async (url, options) => {
      calls.push([url,options]); const query = options.body.get('query');
      return new Response(query.includes('severity:error') ? [event({url:'private-owner/private-repo?token=secret',message:'<img onerror=evil>',body:'secret'}), event({requestId:randomUUID(),jobId:randomUUID()})].map(JSON.stringify).join('\n') : '');
    };
    const result = await logContext.run({requestId:randomUUID()}, () => investigateLogs(logOptions({service:'worker',release:'abcdef1'})));
    expect(result.state).to.equal('stale'); expect(result.groups).to.have.length(1); expect(result.groups[0].count).to.equal(2);
    expect(result.groups[0].sample.requestId).to.equal(id);
    expect(JSON.stringify(result)).not.to.match(/private-owner|secret|onerror/);
    expect(calls.every(([url,opts]) => url === 'http://logging.test:9428/select/logsql/query' && opts.redirect === 'error')).to.equal(true);
    expect(calls[0][1].body.get('limit')).to.equal('1001');
    expect(calls[0][1].body.get('query')).to.include('service:worker release:abcdef1');
  });
  it('sanitizes legacy Redis history and does not invent correlation IDs', () => {
    const row = logContext.run({requestId:id}, () => safeRedisLog({ts:new Date().toISOString(),level:'error',module:'route',message:'secret',raw:[{message:'invalid_request',url:'private',stack:'secret',cookies:'secret',status:400}]}));
    expect(row.message).to.equal('invalid_request'); expect(JSON.stringify(row)).not.to.match(/private|secret|requestId/);
  });
  it('distinguishes empty healthy coverage, stale telemetry and partial records', async () => {
    process.env.ADMIN_LOG_URL = 'http://logging.test';
    const heartbeats = [event({event:'process_heartbeat',service:'api',instance:randomUUID()}), ...Array.from({length:4},()=>event({event:'process_heartbeat',service:'streamer',instance:randomUUID()})), ...['download','cache','remove'].map(queue=>event({event:'queue_heartbeat',service:'api',queue}))];
    let malformed = false;
    global.fetch = async (_,opts) => new Response(opts.body.get('query').includes('severity:error') ? (malformed ? '{invalid}\n' : '') : heartbeats.map(JSON.stringify).join('\n'));
    expect((await investigateLogs(logOptions({}))).state).to.equal('empty');
    malformed = true; expect((await investigateLogs(logOptions({}))).state).to.equal('partial');
  });
  it('expands a job to its request and returns a bounded cross-service timeline', async () => {
    process.env.ADMIN_LOG_URL = 'http://logging.test'; process.env.ADMIN_LOG_GRAFANA_URL = 'https://grafana.test/d/anonymous-operations?token=do-not-expose';
    global.fetch = async (url, opts) => { calls.push([url,opts]); return new Response(JSON.stringify(event({service:opts.body.get('query').includes('NOT jobId:') ? 'api':'worker'}))); };
    const result = await investigateLogs(logOptions({kind:'jobId',id:job},true),true);
    expect(result.events.map(row=>row.service)).to.have.members(['worker','api']);
    expect(calls).to.have.length(2); expect(calls[1][1].body.get('query')).to.include(`requestId:"${id}"`);
    expect(result.grafanaUrl).to.include('var-job_id='); expect(result.grafanaUrl).not.to.include('token');
  });
  it('counts buffer loss but excludes intentional transform filtering', async () => {
    process.env.ADMIN_LOG_URL = 'http://logging.test'; process.env.ADMIN_LOG_VECTOR_URL = 'http://collector.test';
    global.fetch = async url => new Response(url.includes('collector') ? 'vector_buffer_max_size_bytes{stage="0"} 268435488\nvector_buffer_discarded_events_total{intentional="true"} 7\nvector_component_discarded_events_total{intentional="true"} 9\nvector_component_discarded_events_total{intentional="false"} 2\n' : '');
    expect((await investigateLogs(logOptions({}))).telemetry.collector).to.deep.equal({state:'reachable',dropped:9});
  });
  it('reports unreachable, malformed configuration and response overflow without backend details', async () => {
    process.env.ADMIN_LOG_URL = 'http://logging.test';
    global.fetch = async () => {throw Error('private token');};
    expect((await investigateLogs(logOptions({}))).state).to.equal('unreachable');
    global.fetch = async () => new Response('x'.repeat(2*1024*1024+1));
    expect((await investigateLogs(logOptions({}))).state).to.equal('unreachable');
    process.env.ADMIN_LOG_URL = 'http://secret:password@logging.test';
    expect((await investigateLogs(logOptions({}))).state).to.equal('misconfigured');
  });
  it('limits concurrent investigations and cancels hung backends within four seconds', async () => {
    process.env.ADMIN_LOG_URL = 'http://logging.test';
    global.fetch = async (_,opts) => new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('aborted'))));
    const first = investigateLogs(logOptions({})), second = investigateLogs(logOptions({}));
    expect((await investigateLogs(logOptions({}))).state).to.equal('busy');
    expect((await Promise.all([first,second])).map(value=>value.state)).to.deep.equal(['unreachable','unreachable']);
  });
  it('aborts sibling requests immediately when another backend request fails', async () => {
    process.env.ADMIN_LOG_URL = 'http://logging.test';
    const signals = [];
    global.fetch = async (_,opts) => {
      if (opts.body.get('query').includes('severity:error')) throw Error('failed');
      signals.push(opts.signal);
      return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('aborted'))));
    };
    for (let i=0;i<4;i++) expect((await investigateLogs(logOptions({}))).state).to.equal('unreachable');
    expect(signals).to.have.length(4); expect(signals.every(signal=>signal.aborted)).to.equal(true);
  });
  it('preserves repeated timeline records and submillisecond timestamps', async () => {
    process.env.ADMIN_LOG_URL = 'http://logging.test';
    const timestamp = new Date().toISOString().replace(/\.\d+Z$/, '.123456001Z');
    const records = [event({_time:timestamp}),event({_time:timestamp}),event({_time:timestamp.replace('001Z','002Z')})];
    global.fetch = async () => new Response(records.map(JSON.stringify).join('\n'));
    const result = await investigateLogs(logOptions({kind:'requestId',id},true),true);
    expect(result.state).to.equal('ready'); expect(result.events).to.have.length(3);
    expect(result.events[0].timestamp).to.equal(timestamp);
    expect(result.events[2].timestamp).to.equal(timestamp.replace('001Z','002Z'));
  });
  it('orders mixed timestamp precision and computes correct first/last occurrences', async () => {
    process.env.ADMIN_LOG_URL = 'http://logging.test';
    const base = new Date().toISOString().replace(/\.\d+Z$/, '');
    const times = [base+'.123456001Z', base+'Z', base+'.123Z'];
    global.fetch = async (_,opts) => new Response(opts.body.get('query').includes('_time:5m') ? '' : times.map(time=>JSON.stringify(event({_time:time}))).join('\n'));
    const timeline=await investigateLogs(logOptions({kind:'requestId',id},true),true);
    expect(timeline.events.map(row=>row.timestamp)).to.deep.equal([times[1],times[2],times[0]]);
    const result=await investigateLogs(logOptions({}));
    expect(result.groups[0]).to.include({first:times[1],last:times[0],count:3});
  });
  it('keeps real admin authentication and authorization ahead of log queries', async () => {
    const express = require('express');
    const utils = require('../src/server/routes/route-utils');
    const previous = utils.getUser;
    utils.getUser = async req => ({id:'fixture',model:{id:'fixture'},isAdmin:req.headers['x-admin']==='yes'});
    const app = express(); app.use((req,res,next)=>{req.isAuthenticated=()=>req.headers['x-login']==='yes';next();});
    app.use('/api/admin', require('../src/server/routes/admin').default);
    const server = app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
    const address = `http://127.0.0.1:${server.address().port}/api/admin/errors/investigation`;
    try {
      expect((await originalFetch(address)).status).to.equal(401);
      expect((await originalFetch(address,{headers:{'x-login':'yes'}})).status).to.equal(401);
      const response = await originalFetch(address,{headers:{'x-login':'yes','x-admin':'yes'}});
      expect(response.status).to.equal(200); expect((await response.json()).state).to.equal('disabled');
      expect((await originalFetch(address+'?q=*',{headers:{'x-login':'yes','x-admin':'yes'}})).status).to.equal(400);
      expect(calls).to.have.length(0);
    } finally { utils.getUser=previous; await new Promise(resolve=>server.close(resolve)); }
  });
});
