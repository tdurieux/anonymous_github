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
    // Run the deployed collector program in its pinned Vector image, then ingest
    // its real output alongside historical absent/explicit-unknown releases.
    const vectorImage = fs.readFileSync('deploy/logging/compose.yml','utf8').match(/image: (timberio\/vector:[^\s]+)/)[1];
    const app = {timestamp:new Date().toISOString(),severity:'error',service:'api',event:'application_log',module:'queue',errorCode:'upstream_error'};
    const edgeIds = [200,429,502,504].map(()=>randomUUID());
    const source = [undefined,'unknown','abcdef1'].map(release=>({file:'/host/docker/fixture/log.json',message:JSON.stringify({attrs:{tag:'api'},log:JSON.stringify({...app,release})})}));
    source.push(...[200,429,502,504].map((status,i)=>({file:'/host/nginx/anonymous.access.json',message:JSON.stringify({time:new Date().toISOString(),status,app_request_id:edgeIds[i],request_time:0.1,upstream_header_time:0.01})})));
    const collected = execFileSync('docker',['run','--rm','-i','--network','none','--memory','256m',vectorImage,'vrl','-i','/dev/stdin',fs.readFileSync('deploy/logging/sanitize.vrl','utf8')+'\nencode_json(.)'],{encoding:'utf8',input:source.map(JSON.stringify).join('\n')+'\n'}).trim().split('\n').map(line=>JSON.parse(JSON.parse(line)));
    assert.equal(collected.length,7);
    assert(!Object.hasOwn(collected[0],'release')); assert(!Object.hasOwn(collected[1],'release'));
    assert.equal(collected[2].release,'abcdef1');
    assert(collected.slice(3).every(row=>row.severity==='info' && row.event==='edge_request'));
    const fixtures=[...collected,{...app},{...app,release:'unknown'}];
    const insert=await fetch(process.env.ADMIN_LOG_URL+'/insert/jsonline?_time_field=timestamp',{method:'POST',body:fixtures.map(JSON.stringify).join('\n'),headers:{'Content-Type':'application/stream+json'}});
    assert(insert.ok); await sleep(2000);
    const unknown=await investigateLogs(logOptions({service:'api',release:'unknown'}));
    assert.equal(unknown.captured,4); assert(unknown.groups.every(group=>group.sample.release==='unknown'));
    assert.equal((await investigateLogs(logOptions({service:'api',release:'abcdef1'}))).captured,3);
    const edge=await investigateLogs(logOptions({service:'nginx',release:'unknown'}));
    assert.equal(edge.captured,2); assert.deepEqual(edge.groups.map(group=>group.sample.status).sort(),[502,504]);
    assert(edge.groups.every(group=>group.sample.severity==='info'));
    const all=await investigateLogs(logOptions({}));
    assert.equal(all.groups.filter(group=>group.sample.service==='nginx').reduce((n,group)=>n+group.count,0),2);
    // Successful and rate-limited edge records remain searchable in timelines,
    // but are not added to the server-failure investigation results.
    for(let i=0;i<4;i++) {
      const trace=await investigateLogs(logOptions({kind:'requestId',id:edgeIds[i]},true),true);
      assert.equal(trace.events.length,1); assert.equal(trace.events[0].status,[200,429,502,504][i]);
    }
    console.log('PASS actual collector output: missing/unknown release compatibility, edge-only 502/504, excluded 200/429 with retained timelines');
    docker('stop',name);
    const unavailable=await investigateLogs(logOptions({})); assert.equal(unavailable.state,'unreachable');
    delete process.env.ADMIN_LOG_URL;
    const disabled=await investigateLogs(logOptions({})); assert.equal(disabled.state,'disabled');
    console.log('PASS optional backend stopped/disabled: bounded responses, no app dependency');
  } finally { try { docker('rm','-f',name); } catch { /* --rm already removed a stopped container. */ } }
})().catch(error=>{console.error(error);process.exitCode=1;});
