#!/usr/bin/env node
// Isolated real Redis + production admin routes/client. No .env or production access.
require('ts-node/register/transpile-only');
const { fetch, AbortSignal } = globalThis;
const { setTimeout: sleep } = require('node:timers/promises');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const express = require('express');
const { createClient } = require('redis');
const name = 'admin-redis-test-' + randomUUID().slice(0,8);
const docker = (...args) => execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
process.env.LOG_REDIS_MIRROR = 'off';
(async () => {
  let seed, server;
  docker('run','-d','--name',name,'--memory','128m','--cpus','0.5','-p','127.0.0.1::6379','redis:7-alpine','redis-server','--save','','--appendonly','no');
  try {
    const port = Number(docker('port',name,'6379').split(':').at(-1));
    const config = require('../src/config').default;
    config.REDIS_HOSTNAME = '127.0.0.1'; config.REDIS_PORT = port;
    seed = createClient({url:`redis://127.0.0.1:${port}`,socket:{reconnectStrategy:false}});
    seed.on('error',()=>{}); await seed.connect();
    const utils = require('../src/server/routes/route-utils');
    utils.getUser = async () => ({id:'fixture',model:{id:'fixture'},isAdmin:true});
    const app = express(); app.use((req,res,next)=>{req.isAuthenticated=()=>true;next();});
    app.use('/api/admin',require('../src/server/routes/admin').default);
    server = app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/admin/errors`;
    const request = async (suffix='',method='GET') => {
      const response=await fetch(url+suffix,{method,signal:AbortSignal.timeout(5000)});
      return {status:response.status,data:await response.json()};
    };
    const seedHistory = async () => {
      const key = hours => 'admin:errors:hourly:' + new Date(Date.now()-hours*3600000).toISOString().slice(0,13).replace(/[-T:]/g,'');
      await seed.hSet(key(0),{total:'3','bucket:error':'2','bucket:warn':'1','cb:error:upstream_error':'2'});
      await seed.hSet(key(24),{total:'5'}); await seed.set('admin:errors:dropped','7');
      await seed.del('admin:errors');
      await seed.rPush('admin:errors',JSON.stringify({ts:new Date().toISOString(),level:'error',module:'queue',raw:[{code:'upstream_error',status:502}]}));
    };
    const checkStats = result => {
      assert.equal(result.status,200); assert.equal(result.data.available,true);
      assert.equal(result.data.last24h,3); assert.equal(result.data.prev24h,5);
      assert.deepEqual(result.data.severity,{error:2,warn:1,info:0});
      assert.equal(result.data.unique.error,1); assert.equal(result.data.buckets.length,24); assert.equal(result.data.dropped,7);
    };
    await seedHistory();
    // Four uncached stats transactions share the first connection: 204 queue slots.
    (await Promise.all(Array.from({length:4},()=>request('/stats')))).forEach(checkStats);
    for(let round=0;round<3;round++) {
      assert.equal((await request('','DELETE')).status,200); await seedHistory();
      const results=await Promise.all([request('/stats'),request('?limit=250'),request('?limit=1000'),request('/stats')]);
      checkStats(results[0]); checkStats(results[3]);
      for(const result of results.slice(1,3)) {assert.equal(result.status,200);assert.equal(result.data.total,1);assert.equal(result.data.entries.length,1);}
    }
    console.log('PASS cold/concurrent stats, recent and grouped-history reads with exact counters and intact transactions');
    await request('','DELETE'); await seedHistory();
    await seed.sendCommand(['CLIENT','PAUSE','1000','ALL']);
    const load=await Promise.all(Array.from({length:12},()=>request('/stats')));
    assert.equal(load.filter(r=>r.status===200).length,4);
    assert.equal(load.filter(r=>r.status===503 && r.data.available===false && r.data.error==='logging_busy').length,8);
    load.filter(r=>r.status===200).forEach(checkStats);
    checkStats(await request('/stats'));
    assert.equal((await request()).data.entries.length,1);
    console.log('PASS overload rejected before enqueue; same client remains usable without partial transaction corruption');
    await request('','DELETE'); // invalidate stats cache before outage
    seed.destroy(); docker('stop',name); await sleep(50);
    const start=Date.now();
    for(const result of await Promise.all([request('/stats'),request(),request('?limit=1000')])) {
      assert.equal(result.status,200); assert.equal(result.data.available,false);
    }
    assert(Date.now()-start<4000);
    console.log('PASS unavailable Redis returns bounded unavailable fallback');
    docker('start',name);
    for(let i=0;i<30;i++) { try { if(docker('exec',name,'redis-cli','ping')==='PONG') break; } catch { /* startup */ } await sleep(100); }
    config.REDIS_PORT = Number(docker('port',name,'6379').split(':').at(-1));
    seed = createClient({url:`redis://127.0.0.1:${config.REDIS_PORT}`,socket:{reconnectStrategy:false}}); seed.on('error',()=>{}); await seed.connect();
    await seedHistory(); checkStats(await request('/stats'));
    assert.equal((await request()).data.entries.length,1);
    console.log('PASS Redis restart recovers real route/client');
  } finally {
    if(seed?.isOpen) seed.destroy();
    if(server) await new Promise(resolve=>server.close(resolve));
    docker('rm','-f',name);
  }
})().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
