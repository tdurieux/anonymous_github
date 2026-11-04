const fs = require('node:fs');
const assert = require('node:assert/strict');
const {paginateRest} = require('@octokit/plugin-paginate-rest');
(async () => {
 const start = 'https://api.github.com/user/repos?page=1&per_page=100';
 const next = 'https://api.github.com/user/repos?after=opaque%2Bcursor&per_page=7';
 const cases = [];
 const links = ['', `<${next}>; rel="next"`, `<${next}>;rel="next"`, `<${next}>;\t rel="next"`, `<${next}>;\u00a0rel="next"`, `<${next}>;\ufeffrel="next"`, `<${next}>;\u0085rel="next"`, `<${next}>; rel="prev"`, `<${next}>; rel="Next"`, `<${next}>; rel='next'`, `<${next}> ; rel="next"`, `<${start}>; rel="prev", <${next}>; rel="next"`];
 for (const count of [0, 1, 100]) for (const link of links) cases.push({name:`${count}/${JSON.stringify(link)}`, count, link, conflict:0});
 for (const conflict of [1,2]) cases.push({name:`conflict-on-${conflict}`, count:1, link:`<${next}>; rel="next"`, conflict});
 for (const c of cases) {
  const urls = [];
  const request = async ({url}) => {
   urls.push(url);
   assert.ok(urls.length <= 2);
   if (urls.length === c.conflict) throw Object.assign(new Error('Conflict'), {status:409});
   return {status:200, headers:{link:urls.length === 1 ? c.link : ''}, data:Array.from({length:urls.length === 1 ? c.count : 1},()=>({id:urls.length}))};
  };
  request.endpoint = () => ({method:'GET', url:start, headers:{}});
  const result = await paginateRest({request}).paginate('GET /user/repos');
  c.expected = {urls, ids:result.map(row=>row.id)};
 }
 const target='backend/internal/server/testdata/github-pagination.json';
 const output=JSON.stringify(cases,null,2)+'\n';
 if (process.argv.includes('--check')) assert.equal(fs.readFileSync(target,'utf8'),output,'Octokit pagination contract changed');
 else fs.writeFileSync(target,output);
 console.log(`${cases.length} Octokit pagination contracts ${process.argv.includes('--check')?'verified':'generated'}`);
})().catch(error=>{console.error(error);process.exitCode=1;});
