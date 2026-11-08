'use strict';
// Seed and check synthetic data only after proving this is the isolated stack.
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const app = process.argv.includes('--app');
const beta = app || process.argv.includes('--beta');
const compose = ['compose', '--env-file', '.env.go-shadow', '-f', 'backend/compose.shadow.yml'];
if (beta) compose.push('-f', 'backend/compose.shadow-beta.yml');
if (app) compose.push('-f', 'backend/compose.shadow-app.yml');
function docker(args, input) {
  const result = spawnSync('docker', args, {cwd: root, input, encoding: 'utf8', timeout: 30000});
  if (result.error || result.status !== 0) throw Error('Shadow Docker operation failed');
  return result.stdout.trim();
}
(async () => {
  const cid = docker([...compose, 'ps', '-q', 'app']);
  assert(cid, 'shadow app must be running');
  const info = JSON.parse(docker(['inspect', cid]))[0];
  assert.equal(info.Config.Labels['com.docker.compose.project'], 'anonymous-go-shadow');
  assert.equal(info.Config.User, '10001:10001');
  assert.equal(info.HostConfig.ReadonlyRootfs, true);
  assert(Object.values(info.NetworkSettings.Ports || {}).every(p => !p));
  const gateway = JSON.parse(docker(['inspect', docker([...compose,'ps','-q','gateway'])]))[0];
  assert.equal(gateway.Config.Labels['com.docker.compose.project'], 'anonymous-go-shadow');
  assert.deepEqual(gateway.NetworkSettings.Ports['8080/tcp'], [{HostIp:'127.0.0.1',HostPort:'5001'}]);
  for (const service of ['mongodb','redis']) {
    const database = JSON.parse(docker(['inspect',docker([...compose,'ps','-q',service])]))[0];
    assert.equal(database.Config.Labels['com.docker.compose.project'], 'anonymous-go-shadow');
    assert.deepEqual(Object.keys(database.NetworkSettings.Networks), ['anonymous-go-shadow_default']);
    assert(Object.values(database.NetworkSettings.Ports || {}).every(p => !p));
    assert(database.Mounts.every(m => m.Type==='volume' && m.Name.startsWith('anonymous-go-shadow_')));
  }
  const networks = Object.keys(info.NetworkSettings.Networks);
  assert.deepEqual(networks.sort(), beta ? ['anonymous-go-shadow_default','anonymous-go-shadow_outbound'] : ['anonymous-go-shadow_default']);
  assert.equal(JSON.parse(docker(['network', 'inspect', networks[0]]))[0].Internal, true);
  assert(info.Mounts.every(m => (m.Type === 'volume' && m.Name.startsWith('anonymous-go-shadow_')) || (app && m.Type === 'bind' && m.Source === path.join(root,'secrets/github-app-beta.pem') && m.Destination === '/run/secrets/github-app-beta.pem' && !m.RW)));
  const env = Object.fromEntries(info.Config.Env.map(x => {const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];}));
  const mongo = new URL(env.MONGODB_URI);
  assert.equal(mongo.hostname, 'mongodb');
  assert.equal(mongo.pathname, '/shadow');
  assert.equal(env.REDIS_HOSTNAME, 'redis');
  assert.equal(env.GITHUB_APP_ENABLED, app ? 'true' : 'false');
  assert.equal(env.GITHUB_OAUTH_ENABLED, beta ? 'true' : 'false');
  if(beta) {
    assert(env.CLIENT_ID && env.CLIENT_SECRET);
    assert.equal(env.AUTH_CALLBACK,'https://beta.durieux.me/github/auth');
    assert.equal(env.COOKIE_SECURE,'true');
    assert.equal(env.TRUST_PROXY,'2');
  } else assert(!env.CLIENT_SECRET);
  for (const key of ['GITHUB_TOKEN','GITHUB_APP_PRIVATE_KEY','S3_CLIENT_SECRET',...(!app?['GITHUB_APP_CLIENT_SECRET']:[])]) assert(!env[key], 'no unexpected upstream credentials');
  if(app) {assert(env.GITHUB_APP_CLIENT_SECRET);assert.equal(env.GITHUB_APP_PRIVATE_KEY_FILE,'/run/secrets/github-app-beta.pem');assert.equal(env.GITHUB_APP_CALLBACK,'https://beta.durieux.me/github/app/callback');}
  const body = '# Alice shadow demo\n\nhello Alice\n';
  docker([...compose, 'exec', '-T', 'app', 'sh', '-ec', 'mkdir -p /app/repositories/shadow-demo/original; cat > /app/repositories/shadow-demo/original/README.md'], body);
  const script = `
    const connection = new Mongo('mongodb://' + encodeURIComponent(process.env.MONGO_INITDB_ROOT_USERNAME) + ':' + encodeURIComponent(process.env.MONGO_INITDB_ROOT_PASSWORD) + '@127.0.0.1:27017/?authSource=admin');
    const shadow = connection.getDB('shadow');
    const owner = ObjectId('000000000000000000000001');
    const existing = shadow.anonymizedrepositories.findOne({repoId:'shadow-demo'});
    if (existing && existing.owner.toString() !== owner.toString()) throw Error('unexpected fixture owner');
    shadow.users.updateOne({_id:owner},{$setOnInsert:{username:'shadow-fixture-owner',status:'active',isAdmin:false}},{upsert:true});
    shadow.anonymizedrepositories.updateOne({repoId:'shadow-demo'},{$setOnInsert:{owner,status:'ready',statusDate:new Date(),anonymizeDate:new Date('2026-01-01'),settingsSavedAt:new Date('2026-01-01'),treeGeneration:'shadow-fixture-v1',pageView:0,source:{type:'Zip',repositoryName:'fixture/project',branch:'main',commit:'fixture-v1'},options:{terms:['Alice'],expirationMode:'never',image:true,pdf:true,link:true,update:false}}},{upsert:true});
    shadow.files.updateOne({repoId:'shadow-demo',path:'',name:'README.md'},{$setOnInsert:{sha:'fixture-readme',size:${Buffer.byteLength(body)},treeGeneration:'shadow-fixture-v1'}},{upsert:true});
  `;
  docker([...compose,'exec','-T','mongodb','mongosh','--quiet','--nodb'], script);
  const base = beta ? 'https://beta.durieux.me' : 'http://127.0.0.1:5001';
  for (const route of ['/api/healthcheck','/','/r/shadow-demo/']) {
    const response = await fetch(base+route,{headers:{Accept:'text/html'},signal:AbortSignal.timeout(10000)});
    assert.equal(response.status,200,route);await response.arrayBuffer();
  }
  const options = await (await fetch(base+'/api/options')).json();
  assert.equal(options.GITHUB_APP_ENABLED,app);assert.equal(options.GITHUB_OAUTH_ENABLED,beta);
  if(beta) {
    const login = await fetch(base+'/github/login',{redirect:'manual'});
    assert.equal(login.status,302);
    const target=new URL(login.headers.get('location'));
    assert.equal(target.origin,'https://github.com');
    assert.equal(target.pathname,'/login/oauth/authorize');
    assert.equal(target.searchParams.get('client_id'),env.CLIENT_ID);
    assert.equal(target.searchParams.get('redirect_uri'),env.AUTH_CALLBACK);
    assert.match(login.headers.get('set-cookie'),/;\s*Secure/i);
    assert.match(login.headers.get('set-cookie'),/;\s*HttpOnly/i);
    assert.match(login.headers.get('set-cookie'),/;\s*SameSite=Lax/i);
  }
  if(app) {
    const login=await fetch(base+'/github/app/login',{redirect:'manual'});
    assert.equal(login.status,302);
    const target=new URL(login.headers.get('location'));
    assert.equal(target.origin,'https://github.com');
    assert.equal(target.searchParams.get('client_id'),env.GITHUB_APP_CLIENT_ID);
    assert.equal(target.searchParams.get('redirect_uri'),env.GITHUB_APP_CALLBACK);
    assert(!target.searchParams.has('scope'));
  }
  assert.equal((await fetch(base+'/api/user')).status,401);
  const expected = body.replaceAll('Alice','XXXX-1');
  const file = base+'/api/repo/shadow-demo/file/README.md';
  const cold = await fetch(file);assert.equal(cold.status,200);assert.equal(await cold.text(),expected);
  await Promise.all(Array.from({length:8},async()=>{const r=await fetch(file);assert.equal(r.status,200);assert.equal(await r.text(),expected);}));
  const zip=await fetch(base+'/api/repo/shadow-demo/zip');assert.equal(zip.status,200);
  const bytes=Buffer.from(await zip.arrayBuffer());assert.equal(bytes.readUInt32LE(0),0x04034b50);
  console.log(JSON.stringify({isolation:'passed',health:'passed',authentication:beta?(app?'App and legacy OAuth redirects verified; App authorization pending':'legacy OAuth redirect and secure cookie verified; user sign-in still required'):'disabled until a separate callback is configured',exactAnonymizedFileChecks:9,zip:'passed',demo:base+'/r/shadow-demo/'},null,2));
})().catch(error => {console.error(error.message);process.exitCode=1;});
