// Run the TypeScript report against a deterministic database protocol fixture.
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const source = fs.readFileSync('src/core/cache-observability.ts', 'utf8');
const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const cases = [];
for (const input of [undefined, '', '15', '60', '1440', '10080', '30', ' 15 ', '1.5e1', '0xf', '0b1111', '15.0', '15x', ['15'], ['15','60']]) {
 let selection;
 class DatabaseSync {
  exec() {}
  prepare(sql) { return {
   run() {},
   get: () => ({dropped:3}),
   all: (...args) => { selection=args; return []; },
  }; }
 }
 const module={exports:{}};
 const config={CACHE_MONITORING_ENABLED:true,SHARED_CACHE_PATH:'/synthetic'};
 const dependencies={os:{hostname:()=> 'synthetic'},'node:sqlite':{DatabaseSync},fs:{mkdirSync(){}},path:require('node:path'),'../config':{default:config},'./request-monitoring':{cacheTraffic:()=> 'background'}};
 class FixedDate extends Date { static now() { return 1800000000000; } }
 vm.runInNewContext(code,{exports:module.exports,module,require:name=>{assert.ok(dependencies[name],name);return dependencies[name]},Date:FixedDate,process:{pid:1},setInterval(){},clearInterval(){}});
 const report=module.exports.cacheMetricsReport(Number(input));
 cases.push({input:input===undefined?null:input,windowMinutes:report.windowMinutes,period:selection[0],cutoff:selection[1],buckets:report.latencyBucketsMs});
}
const target='backend/internal/server/testdata/cache-metrics.json';
const output=JSON.stringify(cases,null,2)+'\n';
if(process.argv.includes('--check')) assert.equal(fs.readFileSync(target,'utf8'),output);
else fs.writeFileSync(target,output);
console.log(`${cases.length} TypeScript cache report contracts ${process.argv.includes('--check')?'verified':'generated'}`);
