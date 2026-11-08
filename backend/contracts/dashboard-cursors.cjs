const fs=require('node:fs'),assert=require('node:assert/strict'),ts=require('typescript'),{Types}=require('mongoose');
const source=fs.readFileSync('src/server/routes/dashboard-summary.ts','utf8');
const body=source.slice(source.indexOf('const fields:'),source.indexOf('export async function dashboardSummary'));
class AnonymousError extends Error{}
const exportsObject={};new Function('exports','Types','PullRequest','Gist','DashboardName','AnonymousError',ts.transpile(body,{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}))(exportsObject,Types,{collection:{name:'prs'}},{collection:{name:'gists'}},{collection:{name:'names'}},AnonymousError);
const user={id:'111111111111111111111111',repositoryMembership:()=>({$or:[{owner:'111111111111111111111111'}]})};
const cases=[];
function add(sort,payload,transform=x=>x,http=true){const cursor=transform(Buffer.from(JSON.stringify(payload)).toString('base64url'));let expected,rejected=false;try{const pipeline=exportsObject.dashboardPipeline(user,{sort,cursor});const clause=pipeline.at(-1).$facet.items[1].$match.$or[1];expected={sort,type:payload.type,id:payload.id,value:clause._sort};}catch{rejected=true}cases.push({sort,cursor,rejected,expected,http});}
for(const sort of ['_name','-pageView','anonymizeDate'])for(const value of ['abc',42,null,true,false,{},{$ne:null},[],['2020-01-02'],'2020-01-02T03:04:05Z','0001-01-01',0,8640000000000001])add(sort,{sort,type:'repo',id:user.id,value});
for(const type of ['','other-forge',false,{},['repo']])add('_name',{sort:'_name',type,id:user.id,value:'abc'});
for(const change of [{sort:'wrong'},{id:'bad'},{type:null},{value:undefined}])add('_name',{sort:'_name',type:'repo',id:user.id,value:'abc',...change});
for(const transform of [x=>x+'=',x=>' \n'+x+'\n',x=>x.replace(/-/g,'+').replace(/_/g,'/')])add('_name',{sort:'_name',type:'repo',id:user.id,value:'text'},transform);
const app=require('express')();app.set('query parser','extended');const parse=app.get('query parser fn');
const dates=JSON.parse(fs.readFileSync('backend/internal/server/testdata/admin-dates.json','utf8'));
for(const sort of ['anonymizeDate','-lastView','options.expirationDate']) {
 for(const row of dates) {
  const query=parse(row.query);const value=query.dateFrom??query.dateTo;
  if(value!==undefined)add(sort,{sort,type:'repo',id:user.id,value},x=>x,false);
 }
 for(const value of ['March 1 2024','2024-02-30','2024-02-29T24:00:00Z','-000000-02-03',['2024','3','1'],'2024-03-01T01:00:00+02:00','2024-03-01t00:00z','2024-03-01T00:00Z\0ignored'])add(sort,{sort,type:'repo',id:user.id,value});
}
const path='backend/internal/server/testdata/dashboard-cursors.json',output=JSON.stringify(cases,null,2)+'\n';if(process.argv.includes('--check'))assert.equal(fs.readFileSync(path,'utf8'),output);else fs.writeFileSync(path,output);console.log(`${cases.length} TypeScript dashboard cursor contracts verified`);
