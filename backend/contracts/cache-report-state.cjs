const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const file='src/server/routes/admin.ts',tree=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
let handler;
function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(tree)==='router.get'&&n.arguments[0]?.text==='/cache')handler=n.arguments[1].getText(tree);ts.forEachChild(n,visit);}
visit(tree);assert.ok(handler);
const code=ts.transpileModule(`module.exports=${handler}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const states=[
 {name:'disabled',enabled:false,storage:'filesystem'},
 {name:'source only',enabled:true,storage:'filesystem',source:true},
 {name:'source and results',enabled:true,storage:'filesystem',source:true,results:true},
 {name:'s3',enabled:true,storage:'s3'},
 {name:'source unavailable',enabled:true,storage:'filesystem',source:true,sourceError:true},
 {name:'results unavailable',enabled:true,storage:'filesystem',source:true,results:true,resultError:true},
];
(async()=>{
 const rows=[];
 for(const input of states){
  const fixture={exports:{}};let expected,headers={};
  const stats={blobs:0,originalBytes:0,storedBytes:0,allocatedBytes:0,activeReaders:0,decisions:0,reservedBytes:0,budgetBytes:65536,maxObjectBytes:4096,oldestAccess:null};
  vm.runInNewContext(code,{module:fixture,config:{SHARED_CACHE_ENABLED:input.enabled,STORAGE:input.storage},cacheMetricsReport:()=>({available:false,reason:'Monitoring is disabled',rows:[]}),sharedBlobCache:()=>input.source?{stats(){if(input.sourceError)throw Error('private path');return stats}}:undefined,resultBlobCache:()=>input.results?{stats(){if(input.resultError)throw Error('private path');return stats}}:undefined});
  await fixture.exports({query:{}},{set(k,v){headers[k]=v},json(v){expected=v}});
  rows.push({input,expected,headers});
 }
 const target='backend/internal/server/testdata/cache-report-state.json',data=JSON.stringify(rows,null,2)+'\n';
 if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),data);else fs.writeFileSync(target,data);
 console.log(`${rows.length} TypeScript cache report state contracts ${process.argv.includes('--check')?'verified':'generated'}`);
})().catch(e=>{console.error(e);process.exitCode=1});
