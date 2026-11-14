#!/usr/bin/env node
// Synthetic, isolated local VictoriaLogs. Never reads application .env or production data.
require('ts-node/register/transpile-only');
const { fetch } = globalThis;
const { setTimeout } = require('node:timers');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { investigateLogs, logOptions } = require('../src/server/admin-log-investigation');
const name = 'admin-logs-test-' + randomUUID().slice(0,8);
const image = fs.readFileSync('deploy/logging/compose.yml','utf8').match(/image: (victoriametrics\/victoria-logs:[^\s]+)/)[1];
const docker = (...args) => execFileSync('docker', args, {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
(async () => {
  docker('run','--rm','-d','--name',name,'--memory','256m','--cpus','0.5','-p','127.0.0.1::9428',image);
  try {
    process.env.ADMIN_LOG_URL = 'http://' + docker('port',name,'9428');
    delete process.env.ADMIN_LOG_VECTOR_URL;
    let ready = false;
    for (let n=0;n<30;n++) { try { if ((await fetch(process.env.ADMIN_LOG_URL+'/health')).ok) {ready=true;break;} } catch { /* Backend startup may take a moment. */ } await sleep(500); }
    assert(ready);
    const requestId=randomUUID(),jobId=randomUUID();
    const records=['api','streamer','worker'].map((service,i)=>({timestamp:new Date(Date.now()-10000+i).toISOString(),event:i===2?'job_failed':'request_completed',severity:'error',service,module:'queue',status:502,errorCode:'upstream_error',release:'abcdef1',requestId,...(i===2?{jobId}:{}),url:'private-owner/private-repository?token=secret',body:'<script>secret</script>'}));
    records.push({...records[0],requestId:randomUUID(),timestamp:new Date(Date.now()-5000).toISOString()});
    const ingest = await fetch(process.env.ADMIN_LOG_URL+'/insert/jsonline?_time_field=timestamp', {method:'POST',body:records.map(JSON.stringify).join('\n'),headers:{'Content-Type':'application/stream+json'}});
    assert(ingest.ok); await sleep(2000);
    const errors=await investigateLogs(logOptions({service:'api',release:'abcdef1'}));
    assert.equal(errors.state,'stale'); assert.equal(errors.groups.length,1); assert.equal(errors.groups[0].count,2);
    assert(!JSON.stringify(errors).includes('private-owner')); assert(!JSON.stringify(errors).includes('secret'));
    const timeline=await investigateLogs(logOptions({kind:'jobId',id:jobId},true),true);
    assert.equal(timeline.state,'ready'); assert.deepEqual([...new Set(timeline.events.map(row=>row.service))].sort(),['api','streamer','worker']);
    console.log('PASS real filtered grouping, privacy projection and job→request cross-service correlation');
    docker('stop',name);
    const unavailable=await investigateLogs(logOptions({})); assert.equal(unavailable.state,'unreachable');
    delete process.env.ADMIN_LOG_URL;
    const disabled=await investigateLogs(logOptions({})); assert.equal(disabled.state,'disabled');
    console.log('PASS optional backend stopped/disabled: bounded responses, no app dependency');
  } finally { try { docker('rm','-f',name); } catch { /* --rm already removed a stopped container. */ } }
})().catch(error=>{console.error(error);process.exitCode=1;});
