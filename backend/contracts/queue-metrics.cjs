const fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm'),assert=require('node:assert/strict');
const admin=ts.createSourceFile('admin.ts',fs.readFileSync('src/server/routes/admin.ts','utf8'),ts.ScriptTarget.Latest,true);
function find(node,predicate){if(predicate(node))return node;let result;ts.forEachChild(node,child=>{result ||= find(child,predicate)});return result}
const ranges=find(admin,n=>ts.isVariableDeclaration(n)&&n.name.getText(admin)==='RANGE_MINUTES').getText(admin);
const route=find(admin,n=>ts.isCallExpression(n)&&n.expression.getText(admin)==='router.get'&&n.arguments[0]?.text==='/queues/metrics');
const declaration=name=>find(route,n=>ts.isVariableDeclaration(n)&&n.name.getText(admin)===name).getText(admin);
const selection=ts.transpileModule(`const ${ranges};function select(req){const ${declaration('queueName')};const ${declaration('range')};const ${declaration('minutes')};return {queue:queueName,range,minutes};}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const code=ts.transpileModule(fs.readFileSync('src/queue/queueMetrics.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const now=1800000000000;
class FixedDate extends Date {static now(){return now}}
(async()=>{
 const result={now,ranges:[],durations:[]};
 for(const input of ['', '1h','6h','24h','7d','60','1440','garbage',' 24h ',['1h','7d']]){
  const sandbox={};vm.createContext(sandbox);vm.runInContext(selection,sandbox);const selected=sandbox.select({query:{range:input}});
  const writes=[];const redis={isOpen:true,on(){},connect(){return Promise.resolve()},multi(){const reads=[];return {hmGet(k){reads.push(k);return this},hIncrBy(...args){writes.push(args);return this},expire(){return this},async exec(){return reads.map(k=>k.endsWith(':'+now)?['2','1','11']:[null,null,null])}}}};
  const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,Date:FixedDate,require:name=>name==='redis'?{createClient:()=>redis}:{default:{}}});
  const points=await module.exports.queryMetrics(selected.queue,selected.minutes);
  result.ranges.push({input,...selected,count:points.length,first:points[0],last:points.at(-1)});
  if(input==='1h')for(const duration of [-2,0,0.49,0.5,1.49,1.5,2.5]){writes.length=0;await module.exports.recordMetric('download','completed',duration);result.durations.push({input:duration,ms:writes.find(x=>x[1]==='ms')[2]})}
 }
 const target='backend/internal/server/testdata/queue-metrics.json',output=JSON.stringify(result,null,2)+'\n';
 if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),output);else fs.writeFileSync(target,output);
 console.log(`${result.ranges.length+result.durations.length} TypeScript queue metric contracts ${process.argv.includes('--check')?'verified':'generated'}`);
})().catch(e=>{console.error(e);process.exitCode=1});
