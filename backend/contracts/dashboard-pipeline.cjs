const fs=require('node:fs'),assert=require('node:assert/strict'),ts=require('typescript'),{Types}=require('mongoose'),{BSON}=require('bson');
const source=fs.readFileSync('src/server/routes/dashboard-summary.ts','utf8');
const body=source.slice(source.indexOf('const fields:'),source.indexOf('export async function dashboardSummary'));
class AnonymousError extends Error{}
const exportsObject={};new Function('exports','Types','PullRequest','Gist','DashboardName','AnonymousError',ts.transpile(body,{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}))(exportsObject,Types,{collection:{name:'anonymizedpullrequests'}},{collection:{name:'anonymizedgists'}},{collection:{name:'dashboardnames'}},AnonymousError);
const user={id:'111111111111111111111111',repositoryMembership:()=>({$or:[{owner:'111111111111111111111111'}]})};
const now='2026-01-02T03:04:05.000Z';
const queries=[{},...['_name','_label','status','anonymizeDate','lastView','pageView','options.expirationDate'].flatMap(sort=>[{sort},{sort:'-'+sort}]),{sort:'invalid'},{sort:['_name','_label']}];
for(const c of JSON.parse(fs.readFileSync('backend/internal/server/testdata/dashboard-filters.json','utf8')))queries.push(c.query);
for(const c of JSON.parse(fs.readFileSync('backend/internal/server/testdata/dashboard-limits.json','utf8')))queries.push(c.values.length?{limit:c.values.length===1?c.values[0]:c.values}:{});
for(const c of JSON.parse(fs.readFileSync('backend/internal/server/testdata/dashboard-cursors.json','utf8')))queries.push({sort:c.sort,cursor:c.cursor});
const app=require('express')();app.set('query parser','extended');const parse=app.get('query parser fn');
const rawQueries=['type[]=repo','type[0]=repo','type[]=repo&type[]=gist','type[x]=repo','attention[]=true','attention=true','statuses[]=','statuses[]=ready&statuses[]=removed','statuses[1]=ready&statuses[0]=error','statuses[x]=ready','q[]=first&q[]=second','q[x]=text','q=%FF','sort[]=','sort[]=_name','sort[1]=_name&sort[0]=status','sort[x]=_name','limit[]=2','limit[0]=2','limit[1]=2&limit[0]=1','limit[x]=2','cursor[]=','cursor[x]=3','cursor[toString]=3','sort[toString]=3','limit[toString]=3','type[toString]=3','statuses[toString]=3','q[toString]=3'];
for(const c of JSON.parse(fs.readFileSync('backend/internal/server/testdata/dashboard-cursors.json','utf8')).slice(0,8)) rawQueries.push('sort='+encodeURIComponent(c.sort)+'&cursor[]='+encodeURIComponent(c.cursor));
const cases=queries.map(query=>({query})).concat(rawQueries.map(rawQuery=>({rawQuery,query:parse(rawQuery)}))).map(({query,rawQuery},i)=>{try{
 const pipeline=BSON.deserialize(BSON.serialize({pipeline:exportsObject.dashboardPipeline(user,query,new Date(now))})).pipeline;
 const sortOrder=Object.keys(pipeline.at(-1).$facet.items.find(stage=>stage.$sort).$sort);
 return {name:`case-${i}`,query,rawQuery,expected:pipeline,sortOrder};
}catch(error){return{name:`case-${i}`,query,rawQuery,error:error instanceof TypeError?"invalid_query_value":error.message}}});
const path='backend/internal/server/testdata/dashboard-pipeline.json',output=JSON.stringify({now,owner:user.id,cases},null,2)+'\n';if(process.argv.includes('--check'))assert.equal(fs.readFileSync(path,'utf8'),output);else fs.writeFileSync(path,output);console.log(`${cases.length} complete TypeScript dashboard pipeline contracts verified`);
