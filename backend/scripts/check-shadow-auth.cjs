'use strict';
// Explicitly authorized beta-only admin bootstrap and authenticated deployment checks.
// Credentials remain in memory. The temporary key is removed even when a check fails.
const assert = require('node:assert/strict');
const {randomBytes, createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const base = 'https://beta.durieux.me';
const compose = ['compose', '--env-file', '.env.go-shadow', '-f', 'backend/compose.shadow.yml', '-f', 'backend/compose.shadow-beta.yml'];
const appFlow = process.argv.includes('--app-flow');
const monitoringOnly = process.argv.includes('--monitoring-only');
const app = appFlow || process.argv.includes('--app');
if(app) compose.push('-f','backend/compose.shadow-app.yml');
function docker(args, input) {
  const r = spawnSync('docker', args, {cwd:root, input, encoding:'utf8', timeout:30000});
  if (r.error || r.status !== 0) throw Error('Shadow Docker operation failed');
  return r.stdout.trim();
}
function db(script) {
  return docker([...compose, 'exec', '-T', 'mongodb', 'mongosh', '--quiet', '--nodb', '--file', '/dev/stdin'], `
const c = new Mongo('mongodb://' + encodeURIComponent(process.env.MONGO_INITDB_ROOT_USERNAME) + ':' + encodeURIComponent(process.env.MONGO_INITDB_ROOT_PASSWORD) + '@127.0.0.1:27017/?authSource=admin');
const d = c.getDB('shadow');
${script}
`);
}
const report = {verifiedAt:new Date().toISOString(), hostname:'beta.durieux.me', configurationMode:app?'GitHub App enabled alongside legacy OAuth':'legacy OAuth only', checks:[], productionChanged:false};
const key = randomBytes(32).toString('hex');
const hash = createHash('sha256').update(key).digest('hex');
const id = randomBytes(12).toString('hex');
const repoId = 'go-beta-check-' + Date.now();
let bootstrapped = false, createdRepo = false;
const requestIDs=new Set();
const fixture = appFlow ? {name:'tdurieux/synctex-js',branch:'master',file:'LICENSE',term:'MIT'} : {name:'octocat/Hello-World',branch:'master',file:'README',term:'Hello'};
async function call(method, route, body, expected=200, token=key, extraHeaders={}, binary=false) {
  const start = performance.now();
  const response = await fetch(base+route, {method, headers:{...(token ? {Authorization:'Bearer '+token}:{}), 'Content-Type':'application/json', ...extraHeaders}, body:body===undefined?undefined:JSON.stringify(body), signal:AbortSignal.timeout(45000), redirect:'manual'});
  assert.equal(response.status, expected, method+' '+route+' unexpected status; deployment='+response.headers.get('x-anonymous-deployment'));
  const requestID=response.headers.get('x-request-id');
  assert(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestID||''),'missing generated request ID on '+method+' '+route+' (status '+response.status+', deployment '+response.headers.get('x-anonymous-deployment')+')');
  assert(!requestIDs.has(requestID),'request ID reused');
  requestIDs.add(requestID);
  const headersMs=Math.round(performance.now()-start);
  const chunks=[];
  let firstBodyByteMs=null;
  for await (const chunk of response.body) {
    if(chunk.length && firstBodyByteMs===null) firstBodyByteMs=Math.round(performance.now()-start);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const text = bytes.toString('utf8');
  let value; try {value=JSON.parse(text);} catch {value=text;}
  report.checks.push({method, route, requestID, status:response.status, expected, bytes:bytes.length, headersMs, firstBodyByteMs, elapsedMs:Math.round(performance.now()-start)});
  assert.equal(response.headers.get('x-anonymous-deployment'), 'go-shadow-beta', 'wrong deployment');
  assert.equal(response.status, expected, method+' '+route+' unexpected status');
  assert(!text.includes(key) && !text.includes(hash), 'credential exposure');
  return {value:binary?bytes:value,response};
}
(async () => {
  assert(process.argv.includes('--bootstrap-admin'), 'Explicit --bootstrap-admin required; leaves the sole real beta account as admin');
  for (const service of ['app','mongodb']) {
    const info=JSON.parse(docker(['inspect',docker([...compose,'ps','-q',service])]))[0];
    assert.equal(info.Config.Labels['com.docker.compose.project'],'anonymous-go-shadow');
    assert(Object.values(info.NetworkSettings.Ports||{}).every(v=>!v));
    assert(info.Mounts.every(m=>(m.Type==='volume' && m.Name.startsWith('anonymous-go-shadow_')) || (app && service==='app' && m.Type==='bind' && m.Source===path.join(root,'secrets/github-app-beta.pem') && m.Destination==='/run/secrets/github-app-beta.pem' && !m.RW)));
    if(service==='mongodb') assert.deepEqual(Object.keys(info.NetworkSettings.Networks),['anonymous-go-shadow_default']);
    if(service==='app') {
      const env=Object.fromEntries(info.Config.Env.map(v=>{const i=v.indexOf('=');return [v.slice(0,i),v.slice(i+1)];}));
      const uri=new URL(env.MONGODB_URI);
      assert.equal(uri.hostname,'mongodb');assert.equal(uri.pathname,'/shadow');
      assert.equal(env.APP_HOSTNAME,'beta.durieux.me');
    }
  }
  await call('GET','/api/user',undefined,401,'');
  db(`const users=d.users.find({'externalIDs.github':{$exists:true},status:'active'}).toArray();
if(users.length!==1) throw Error('Expected exactly one active GitHub beta account');
const result=d.users.updateOne({_id:users[0]._id,status:'active'},{$set:{isAdmin:true},$push:{apiTokens:{_id:ObjectId('${id}'),name:'Temporary beta deployment validation',tokenHash:'${hash}',createdAt:new Date()}}});
if(result.modifiedCount!==1) throw Error('Bootstrap failed');`);
  bootstrapped=true;
  const {value:user}=await call('GET','/api/user');
  assert.equal(user.isAdmin,true);
  for(const route of (monitoringOnly ? ['/api/admin/overview','/api/admin/queues','/api/admin/performance','/api/admin/errors','/api/admin/errors/stats'] : ['/github/connections','/api/providers','/api/user/dashboard','/api/user/default','/api/user/quota','/api/admin/overview','/api/admin/users','/api/admin/repos','/api/admin/queues','/api/admin/performance','/api/admin/errors','/api/admin/errors/stats','/api/admin/tokens'])) {
    const {value}=await call('GET',route);
    if(route==='/api/admin/queues') {
      for(const queue of value.queues) {
        for(const field of ['workers','completed24h','failed24h']) assert(Number.isFinite(queue[field]),'missing queue overview '+field);
        assert(queue.workers>=1,'beta worker not registered: '+queue.key);
        assert.equal(queue.concurrency,queue.key==='download'?3:5,'wrong beta worker concurrency');
      }
      report.queueOverviewFields='passed';
    }
    if(route==='/api/admin/overview') {
      for(const [group,field] of [['repos','activeRepos24h'],['repos','newRepos24h'],['users','newUsers24h'],['system','cpuPercent'],['system','memPercent'],['system','diskPercent']]) {
        assert(Number.isFinite(value[group]?.[field]),'Missing overview field '+group+'.'+field);
      }
      const today=new Date();today.setUTCHours(0,0,0,0);
      const current=value.history.filter(row=>new Date(row.date).getTime()===today.getTime());
      assert.equal(current.length,1,'admin history should contain one current-day snapshot');
      assert.equal(current[0].nbRepositories,value.repos.total,'admin history uses stale totals');
      report.overviewHistoryFresh='passed';
      report.overviewBrowserFields='passed';
    }
  }
  const {value:errorList}=await call('GET','/api/admin/errors?limit=5001');
  assert.equal(errorList.max,5000);assert.equal(errorList.limit,5000);assert.equal(errorList.available,true);
  const {value:beforeErrors}=await call('GET','/api/admin/errors/stats');
  await call('GET','/api/repo/'+repoId+'-missing',undefined,404);
  const {value:afterErrors}=await call('GET','/api/admin/errors/stats');
  assert.equal(afterErrors.available,true);assert.equal(afterErrors.buckets.length,24);
  assert(afterErrors.severity.info>=beforeErrors.severity.info+1,'missing routine 404 counter');
  report.errorMonitoring={maxEntries:5000,hourlyBuckets:24,routine404Counted:true};
  const windows=[];
  for(const [queue,range,count] of [['download','1h',60],['download','6h',360],['download','24h',1440],['download','7d',10080],['remove','1h',60],['cache','1h',60],['download','unrecognized',60]]) {
    const {value:history}=await call('GET','/api/admin/queues/metrics?queue='+queue+'&range='+range);
    assert.equal(history.queue,queue);assert.equal(history.range,range);assert.equal(history.points.length,count);
    assert.equal(history.points.at(-1).ts-history.points[0].ts,(count-1)*60000);
    for(const point of history.points) for(const field of ['ts','completed','failed','avgMs']) assert(Number.isFinite(point[field]),'invalid queue point '+field);
    windows.push({queue,range,points:count});
  }
  await call('GET','/api/admin/queues/metrics?queue=unknown',undefined,404);
  report.queueMetricWindows=windows;
  const statFields=['nbRepositories','nbUsers','nbPageViews','nbPullRequests'];
  const {value:publicStats}=await call('GET','/api/stat',undefined,200,'');
  for(const field of statFields) assert(Number.isFinite(publicStats[field]) && publicStats[field]>=0,'invalid public statistic '+field);
  const publicWindows=[];
  for(const [query,days] of [['days=-2',1],['days=0',30],['days=0x10',16],['days=7suffix',7],['days=999',365],['days[]=7&days[]=30',7],['days[1]=7&days[0]=1',1],['days[x]=7',30]]) {
    const started=new Date();started.setUTCHours(0,0,0,0);
    const {value:history}=await call('GET','/api/stat/history?'+query,undefined,200,'');
    assert(Array.isArray(history) && history.length>0,'missing public history');
    const lower=started.getTime()-(days-1)*86400000;
    let previous=-Infinity;
    for(const row of history) {
      const date=Date.parse(row.date);
      assert(Number.isFinite(date) && date>=lower && date>=previous,'invalid history window/order');
      previous=date;
      for(const field of statFields) assert(Number.isFinite(row[field]) && row[field]>=0,'invalid history statistic '+field);
    }
    publicWindows.push({query,days,rows:history.length});
  }
  report.publicStatistics={anonymousAccess:true,windows:publicWindows};
  for(const query of ['statuses[]=','type[]=repo']) {
    const {value:dashboard}=await call('GET','/api/user/dashboard?'+query);
    assert.deepEqual(dashboard.items,[],'array-valued dashboard filter not preserved');
    assert.equal(dashboard.filtered,0);
  }
  for(const query of ['sort[]=','cursor[]=']) await call('GET','/api/user/dashboard?'+query,undefined,400);
  report.dashboardExtendedQueries='passed';
  const dateCursor=value=>Buffer.from(JSON.stringify({sort:'anonymizeDate',type:'repo',id:'000000000000000000000001',value})).toString('base64url');
  const cursorRoute=value=>'/api/user/dashboard?sort=anonymizeDate&limit=5&cursor='+dateCursor(value);
  const {value:canonicalDates}=await call('GET',cursorRoute('2024-03-01T00:00:00.000Z'));
  for(const date of ['March 1 2024','2024-02-30','2024-02-29T24:00:00Z',['2024','3','1']]) {
    const {value}=await call('GET',cursorRoute(date));
    assert.deepEqual(value.items,canonicalDates.items);assert.equal(value.cursor,canonicalDates.cursor);
  }
  await call('GET',cursorRoute('not a date'),undefined,400);
  report.dashboardDateCursors='passed';
  for(const [query,expected] of [['minutes=6e1',60],['minutes[]=60',60],['minutes[0]=15',15]]) {
    const {value:performance}=await call('GET','/api/admin/performance?'+query);
    assert.equal(performance.windowMinutes,expected,'monitoring query window mismatch');
  }
  report.monitoringExtendedQueries='passed';
  for(const [query,queue,range,count] of [['queue[]=cache&range[]=6h','cache','6h',360],['range[]=','download','',60],['range=toString','download','toString',0]]) {
    const {value:history}=await call('GET','/api/admin/queues/metrics?'+query);
    assert.equal(history.queue,queue);assert.equal(history.range,range);assert.equal(history.points.length,count);
  }
  await call('GET','/api/admin/queues/metrics?queue[]=',undefined,404);
  const {value:arrayQueue}=await call('GET','/api/admin/queues?queue[]=remove');
  assert.equal(arrayQueue.selectedQueue,'remove');
  const {value:arrayErrors}=await call('GET','/api/admin/errors?offset[]=2&limit[]=7');
  assert.equal(arrayErrors.offset,2);assert.equal(arrayErrors.limit,7);assert(arrayErrors.entries.length<=7);
  report.adminExtendedQueries='passed';
  for(const query of ['connection=','connection[]=oauth','connection=oauth&connection[]=github-app']) {
    const {value:rejected}=await call('GET','/api/repo/octocat/Hello-World?'+query,undefined,400);
    assert.equal(rejected.error,'invalid_connection');
  }
  report.previewConnectionQueries='passed';
  for(const query of ['repositoryID[]=invalid','repositoryID=invalid','repositoryID[$exists]=true']) {
    const {value:rejected}=await call('GET','/api/repo/octocat/Hello-World?'+query,undefined,500);
    assert.equal(rejected.error,'internal_error');
  }
  report.previewCacheHintRejections='passed';
  for(const query of ['q[]=ab','q[length]=1']) {
    const {value}=await call('GET','/api/user/search/github-users?'+query);
    assert.deepEqual(value,[]);
  }
  for(const query of ['q=ab&q=cd','q[x]=ab','q[length][toString]=1']) {
    const {value}=await call('GET','/api/user/search/github-users?'+query,undefined,500);
    assert.equal(value.error,'internal_error');
  }
  report.userSearchQueries='passed';
  for(const kind of ['repos','users','conferences']) {
    const {value}=await call('GET','/api/admin/'+kind+'?page[]=2&limit[]=2&sort[]=status&direction[]=asc&format[]=csv');
    assert.equal(value.page,2);assert.deepEqual(value.sort,{_id:-1});
    const {value:large}=await call('GET','/api/admin/'+kind+'?page=1000001&limit=1');
    assert.equal(large.page,1000001);
    for(const query of ['page=-1','page[toString]=x',...(kind==='users'?['limit=-1']:[])]) {
      const {value:rejected}=await call('GET','/api/admin/'+kind+'?'+query,undefined,500);
      assert.equal(rejected.error,'internal_error');
    }
  }
  report.adminListPaginationQueries='passed';
  for(const kind of ['repos','conferences']) {
    const {value}=await call('GET','/api/admin/'+kind+'?limit=-1');
    assert(value.results.length<=1);
    const {value:flags}=await call('GET','/api/admin/'+kind+'?ready[]=true');
    assert.deepEqual(flags.query,{$and:[{$or:[{status:'ready'}]}]});
  }
  for(const kind of ['repos','users','conferences']) {
    const {value}=await call('GET','/api/admin/'+kind+'?search[]=x',undefined,500);
    assert.equal(value.error,'internal_error');
  }
  report.adminListFilterQueries='passed';
  const {value:arrayStatus}=await call('GET','/api/admin/users?status[]=active');
  assert.deepEqual(arrayStatus.query.status,['active']);
  assert.deepEqual(arrayStatus.results,[]);assert(arrayStatus.total>=1);
  const {value:operatorStatus}=await call('GET','/api/admin/users?status[$in][]=active');
  assert.deepEqual(operatorStatus.query.status,{$in:['active']});
  assert(operatorStatus.results.length>=1);
  for(const route of ['/api/admin/users?status[a]=active','/api/admin/users?status[$in]=active','/api/admin/repos?owner[a]=x','/api/admin/repos?conference[$unknown]=x']) {
    const {value}=await call('GET',route,undefined,500);assert.equal(value.error,'internal_error');
  }
  report.adminListCastingQueries='passed';
  for(const [kind,field] of [['repos','anonymizeDate'],['users','dateOfEntry'],['conferences','startDate']]) {
    const {value}=await call('GET','/api/admin/'+kind+'?dateFrom[]=2024-02-30');
    const filter=kind==='users'?value.query:value.query.$and[0];
    assert.deepEqual(filter[field],{$gte:'2024-03-01T00:00:00.000Z'});
    const {value:legacy}=await call('GET','/api/admin/'+kind+'?dateTo=March%201%202024');
    const legacyFilter=kind==='users'?legacy.query:legacy.query.$and[0];
    assert.deepEqual(legacyFilter[field],{$lte:'2024-03-01T00:00:00.000Z'});
    const {value:invalid}=await call('GET','/api/admin/'+kind+'?dateFrom[toString]=x',undefined,500);
    assert.equal(invalid.error,'internal_error');
  }
  report.adminListDateQueries='passed';
  if(monitoringOnly) {report.result='passed';return;}

  if(appFlow) {
    const {value:connections}=await call('GET','/github/connections');
    assert(connections.appConnected && !connections.appError && connections.installations.length>0,'App authorization or installation unavailable');
  }
  const {value:issued}=await call('POST','/api/admin/tokens',{name:'Temporary API lifecycle check'});
  assert(typeof issued.id==='string' && /^[a-f0-9]{24}$/.test(issued.id), 'invalid issued key ID');
  try {
    assert(typeof issued.token==='string' && issued.token.length===64,'invalid issued key');
    await call('GET','/api/user',undefined,200,issued.token);
  } finally {
    await call('DELETE','/api/admin/tokens/'+issued.id);
  }
  await call('GET','/api/user',undefined,401,issued.token);
  report.apiKeyLifecycle='passed';
  const {response:login}=await call('POST','/github/login-token',{});
  const setCookie=login.headers.get('set-cookie')||'';
  const cookie=setCookie.split(';')[0];
  assert(cookie.startsWith('connect.sid='),'session cookie missing');
  try {
    assert(/;\s*Secure/i.test(setCookie),'session cookie must be Secure');
    assert(/;\s*HttpOnly/i.test(setCookie),'session cookie must be HttpOnly');
    assert(/;\s*Max-Age=2592000(?:;|$)/i.test(setCookie),'session cookie must persist for 30 days');
    assert(/;\s*Expires=/i.test(setCookie),'persistent session cookie must have an expiry');
    assert(/;\s*SameSite=Lax/i.test(setCookie),'session cookie must use SameSite=Lax');
    const {value:sessionUser}=await call('GET','/api/user',undefined,200,'',{Cookie:cookie});
    assert(sessionUser.isAdmin===true && sessionUser.username===user.username,'session identity mismatch');
  } finally {
    await call('GET','/api/user/logout',undefined,302,'',{Cookie:cookie});
  }
  await call('GET','/api/user',undefined,401,'',{Cookie:cookie});
  report.sessionLoginLogout='passed';
  const {value:preview}=await call('POST','/api/anonymize-preview',{content:'hello Alice',options:{terms:['Alice']}});
  assert.equal(preview.content,'hello XXXX-1');
  const prefix='/api/providers/github/repository/';
  const query='?name='+encodeURIComponent(fixture.name)+'&connection='+(appFlow?'github-app':'oauth');
  await call('GET',prefix+'metadata'+query);
  const {value:branches}=await call('GET',prefix+'branches'+query);
  await call('GET',prefix+'readme'+query);
  const branch=branches.find(b=>b.name===fixture.branch);
  assert(branch && typeof branch.commit==='string' && /^[a-f0-9]{40}$/.test(branch.commit), 'public fixture branch missing');
  let expected='XXXX-1 World!\n';
  if(appFlow) {
    const source=await fetch('https://raw.githubusercontent.com/'+fixture.name+'/'+branch.commit+'/'+fixture.file,{signal:AbortSignal.timeout(15000)});
    assert.equal(source.status,200,'public fixture source unavailable');
    const original=await source.text();
    assert(original.includes('MIT'),'fixture no longer exercises anonymization');
    expected=original.replace(/\bMIT\b/gi,'XXXX-1');
  }
  await call('POST','/api/repo',{repoId,fullName:fixture.name,connection:appFlow?'github-app':'oauth',source:{provider:'github',branch:fixture.branch,commit:branch.commit},terms:[fixture.term],options:{expirationMode:'never',image:true,pdf:true,link:true}});
  createdRepo=true;
  if(process.argv.includes('--website')) db(`d.anonymizedrepositories.updateOne({repoId:'${repoId}'},{$set:{'options.page':true,'options.pageSource':{branch:'${fixture.branch}',path:'/'}}});`);
  if(appFlow) db(`const row=d.anonymizedrepositories.findOne({repoId:'${repoId}'}); if(row?.githubAccess?.kind!=='github-app') throw Error('App binding missing');`);
  let ready=false;
  for(let i=0;i<30;i++) {
    const {value:r}=await call('GET','/api/repo/'+repoId);
    if(r.status==='ready') {ready=true;break;}
    assert(r.status!=='error','repository processing failed');
    await new Promise(r=>setTimeout(r,1000));
  }
  assert(ready,'repository did not become ready');
  const {value:content}=await call('GET','/api/repo/'+repoId+'/file/'+fixture.file,undefined,200,'');
  assert.equal(content,expected);
  async function checkWebsite() {
    if(!process.argv.includes('--website')) return;
    const page=await call('GET','/w/'+repoId+'/'+fixture.file,undefined,200,'',{'Accept-Encoding':'gzip'});
    assert.equal(page.value,expected,'website output differs from file');
    assert(page.response.headers.get('content-security-policy').includes('sandbox'),'website sandbox missing');
  }
  await checkWebsite();
  await call('GET','/api/repo/'+repoId+'/files',undefined,200,'');
  const {value:zip}=await call('GET','/api/repo/'+repoId+'/zip',undefined,200,'',{},true);
  function zipManifest(archive) {
  const unzip=spawnSync('python3',['-c',`import io,sys,zipfile,json,base64,hashlib
v=json.load(sys.stdin)
with zipfile.ZipFile(io.BytesIO(base64.b64decode(v['zip']))) as z:
    assert z.testzip() is None
    files=[n for n in z.namelist() if not n.endswith('/')]
    if v['single']: assert len(files)==1
    matches=[n for n in files if n==v['file'] or n.endswith('/'+v['file'])]
    assert len(matches)==1
    assert z.read(matches[0])==v['expected'].encode('utf8')
    print(json.dumps([[n, hashlib.sha256(z.read(n)).hexdigest()] for n in z.namelist()]))
`],{input:JSON.stringify({zip:archive.toString('base64'),file:fixture.file,expected,single:!appFlow}),timeout:10000});
  assert(!unzip.error && unzip.status===0,'ZIP CRC, entries or anonymized bytes mismatch');
  return JSON.parse(unzip.stdout.toString());
  }
  const originalManifest=zipManifest(zip);
  report.zipManifestSHA256=createHash('sha256').update(JSON.stringify([...originalManifest].sort((a,b)=>a[0].localeCompare(b[0])))).digest('hex');
  report.zipEntries=originalManifest.length;
  report.zipSourceCommit=branch.commit;
  report.exactZipContents='passed';
  if(process.argv.includes('--repeat-content')) {
    for(let i=0;i<2;i++) {
      const again=await call('GET','/api/repo/'+repoId+'/file/'+fixture.file,undefined,200,'');
      assert.equal(again.value,expected,'repeated file changed');
      await checkWebsite();
      const archive=await call('GET','/api/repo/'+repoId+'/zip',undefined,200,'',{},true);
      // Timed streaming flushes can change deflate framing, but not archive contents.
      assert.deepEqual(zipManifest(archive.value),originalManifest,'repeated ZIP contents changed');
    }
    report.repeatedContentChecks=3;
  }
  const {value:metrics}=await call('GET','/api/admin/performance');
  assert.equal(metrics.available,true,'performance history unavailable');
  assert(metrics.routes.some(row=>row.metric==='request' && row.count>0),'missing request metrics');
  assert(metrics.instances.some(row=>row.runtime==='go' && row.memory?.rss>0),'missing Go process sample');
  assert(metrics.runtimeSeries.length>0,'missing runtime history');
  for(const stage of ['repository','authorization','worker_wait','anonymize']) {
    assert(metrics.stages.some(row=>row.metric===stage && row.count>0),'missing stage '+stage);
  }
  report.performanceMonitoring={requests:true,processSamples:true,runtimeHistory:true,stages:['repository','authorization','worker_wait','anonymize'],upstreamObserved:metrics.stages.some(row=>row.metric==='upstream' && row.count>0),upstreamNote:'Shared-cache hits need no upstream read; provider timing is checked by the integration suite.'};
  await call('GET','/api/user',undefined,401,randomBytes(32).toString('hex'));
  report.result='passed';
})().catch(e=>{report.result='failed';report.failure=e.message;process.exitCode=1;}).finally(async()=>{
  try {
    if(createdRepo) {
      await call('DELETE','/api/repo/'+repoId);
      let removed=false;
      for(let i=0;i<30;i++) {
        const {value:r}=await call('GET','/api/repo/'+repoId);
        if(r.status==='removed') {removed=true;break;}
        await new Promise(r=>setTimeout(r,1000));
      }
      assert(removed,'test repository removal did not finish');
      await call('GET','/api/repo/'+repoId+'/file/'+fixture.file,undefined,410,'');
      report.testRepositoryRemoved=true;
    }
  } catch {report.testRepositoryRemoved=false;process.exitCode=1;}
  if(bootstrapped) {
    try {
      db(`d.users.updateOne({'apiTokens._id':ObjectId('${id}')},{$pull:{apiTokens:{_id:ObjectId('${id}')}}});`);
      await call('GET','/api/user',undefined,401);
      report.temporaryKeyRevoked=true;
      report.betaAccountAdmin=true;
    } catch {report.temporaryKeyRevoked=false;process.exitCode=1;}
  }
  report.uniqueRequestIDsVerified=requestIDs.size;
  if(process.exitCode) report.result='failed';
  fs.writeFileSync(path.join(root,monitoringOnly?'backend/reports/shadow-monitoring-authenticated-deployment.json':appFlow?'backend/reports/shadow-app-authenticated-deployment.json':'backend/reports/shadow-authenticated-deployment.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
});
