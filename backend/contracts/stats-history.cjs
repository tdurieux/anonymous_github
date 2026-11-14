const fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=ts.createSourceFile('dailyStatsSnapshot.ts',fs.readFileSync('src/server/dailyStatsSnapshot.ts','utf8'),ts.ScriptTarget.Latest,true);
const functions=['utcMidnight','mergeCurrentStatsIntoHistory'].map(name=>source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(source));
const sandbox={exports:{}};vm.createContext(sandbox);vm.runInContext(ts.transpileModule(functions.join('\n'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,sandbox);
const counts={nbRepositories:12,nbUsers:3,nbPageViews:99,nbPullRequests:2};
const cases=[];
for(const now of ['2026-11-03T00:00:00Z','2026-11-03T23:59:59.999Z','2024-02-29T12:00:00Z','2027-01-01T01:00:00+14:00']) {
 const midnight=new Date(now);midnight.setUTCHours(0,0,0,0);
 const at=ms=>new Date(midnight.getTime()+ms).toISOString();
 for(const dates of [[],[at(-86400000)],[at(12*3600000)],[at(13*3600000),at(12*3600000)],[at(86400000),at(-86400000),at(1)]]) {
  const rows=dates.map((date,i)=>({date,nbRepositories:i,nbUsers:i,nbPageViews:i,nbPullRequests:i}));
  cases.push({now,rows,current:counts,expected:sandbox.mergeCurrentStatsIntoHistory(rows,counts,new Date(now))});
 }
}
const target='backend/internal/server/testdata/stats-history.json',output=JSON.stringify(cases,null,2)+'\n';
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),output);else fs.writeFileSync(target,output);
console.log(`${cases.length} TypeScript history merge contracts ${process.argv.includes('--check')?'verified':'generated'}`);
