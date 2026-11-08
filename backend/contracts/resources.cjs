// The TypeScript implementation is the oracle. Run --check in CI to detect drift.
const fs = require('node:fs');
const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');
const config = require('../../src/config').default;
config.ANONYMIZATION_MASK = 'XXXX'; config.APP_HOSTNAME = 'anonymous.test';
const Gist = require('../../src/core/Gist').default;
const PullRequest = require('../../src/core/PullRequest').default;
const Repository = require('../../src/core/Repository').default;
const flags = ['title','body','diff','content','comments','username','date','origin'];
const cases = [];
for (const kind of ['gist','pr']) for (const rich of [false,true]) for (let bits=0;bits<256;bits++) {
  const options = {terms:['Alice'],link:true,image:true};
  flags.forEach((flag,index)=>options[flag]=!!(bits&(1<<index)));
  const payload = {title:'Alice title',body:'Alice body',diff:'- Alice\n+ Bob',description:'Alice snippet',ownerLogin:'Alice',isPublic:false,merged:false,state:'open',draft:false};
  if (rich) Object.assign(payload,{mergedDate:null,updatedDate:'2026-01-01T00:00:00.000Z',creationDate:'2025-01-01T00:00:00.000Z',baseRepositoryFullName:'Alice/project',files:[{filename:'Alice.txt',content:'Alice content',size:13},{filename:'empty',content:'',size:0,type:'text/plain',language:'Text'}],comments:[{body:'Alice comment',author:'Alice',creationDate:'2025-01-01T00:00:00.000Z'},{body:'reply',author:'Bob'}]});
  const record = {owner:'111111111111111111111111',gistId:'example',pullRequestId:'example',source:{gistId:'upstream',repositoryFullName:'Alice/project',pullRequestId:1},options,[kind==='gist'?'gist':'pullRequest']:payload};
  if(rich)record.anonymizeDate='2026-02-01T00:00:00.000Z';
  const instance = new (kind==='gist'?Gist:PullRequest)(record);
  cases.push({name:`${kind}/${rich?'rich':'minimal'}/${bits}`,kind,record,operation:"content",expected:instance.content()});
}
for (const kind of ['gist','pr','repo']) for (const status of ['ready','preparing','error','removed']) for (const rich of [false,true]) {
 const record={owner:'111111111111111111111111',status,source:{},options:{terms:['Alice']},gist:{},pullRequest:{}};
 if(rich)Object.assign(record,{repoId:'example',gistId:'example',pullRequestId:'example',size:{storage:123,file:2},coauthors:[{username:'Bob',githubId:2,photo:'photo',private:'secret'}],conference:'conf',statusMessage:'error_message',anonymizeDate:'2026-01-01T00:00:00.000Z',source:{repositoryId:'cached',repositoryName:'Alice/repo',type:'GitHubStream',commit:'abc',branch:'main',gistId:'upstream',repositoryFullName:'Alice/repo',pullRequestId:12},gist:{description:'Alice',isPublic:true,files:[{filename:'readme',content:'Alice',size:5,private:'secret'}],comments:[{author:'Alice',body:'hello',private:'secret'}]},pullRequest:{title:'Alice',state:'closed',merged:true,mergedDate:null}});
 const Type=kind==='gist'?Gist:kind==='pr'?PullRequest:Repository;
 cases.push({name:`${kind}/private/${status}/${rich}`,kind,operation:'private',record,expected:new Type(record).toJSON()});
}
const output=JSON.stringify(cases)+'\n';
const target='backend/internal/server/testdata/resources.json';
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),output,'TypeScript resource contract changed; regenerate and review');
else fs.writeFileSync(target,output);
console.log(`${cases.length} TypeScript resource output contracts ${process.argv.includes('--check')?'verified':'generated'}`);

process.exit(0);
