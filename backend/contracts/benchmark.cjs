// Compare the same synthetic inputs in fresh Node and Go processes. Run from repository root.
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
if(process.argv[2]==='node') {
 require('ts-node/register/transpile-only');
 const {ContentAnonimizer}=require('../../src/core/anonymize-utils');
 const {createHash}=require('node:crypto');
 const terms=['first.last','user@example.org','dept.example.edu','lab.io','project.org','Author X. Name',...Array.from({length:41},(_,i)=>`Researcher${i}`)];
 const row='123,456,78.91234,-45.123456\n';
 const fixtures=[['2 MB CSV, 47 absent terms',()=>row.repeat(70000),terms],['100 MB CSV, 47 absent terms',()=>row.repeat(3600000),terms],['50 MB CSV, sparse matches',()=>`first.last\n${row.repeat(1800000)}\nhttps://host/user@example.org`,terms],['22 MB text, 1.2 million replacements',()=> 'Alice 123 first.last,45.678,-23.456\n'.repeat(600000),['Alice',...terms]]];
 for(const [name,fixture,rules] of fixtures){const input=fixture();let t=performance.now();const engine=new ContentAnonimizer({terms:rules});const compileMs=performance.now()-t;t=performance.now();try{const output=engine.anonymize(input);const matchMs=performance.now()-t;console.log(JSON.stringify({runtime:process.version,name,inputBytes:Buffer.byteLength(input),outputBytes:Buffer.byteLength(output),compileMs,matchMs,sha256:createHash('sha256').update(output).digest('hex')}))}catch(e){console.log(JSON.stringify({name,error:e.message}))}}
} else {
 const go=process.env.GO_BENCHMARK_BINARY;if(!go)throw new Error('GO_BENCHMARK_BINARY required');
 const samples=[];for(let run=0;run<3;run++)for(const runtime of run%2?['go','node']:['node','go']){const child=runtime==='node'?spawnSync(process.execPath,[__filename,'node'],{encoding:'utf8',timeout:120000}):spawnSync(go,[],{encoding:'utf8',timeout:120000});if(child.status!==0)throw new Error(child.stderr||String(child.error));for(const line of child.stdout.trim().split('\n'))samples.push({run,implementation:runtime,...JSON.parse(line)})}
 const med=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];const comparison=[...new Set(samples.map(v=>v.name))].map(name=>{const n=samples.filter(v=>v.name===name&&v.implementation==='node'),g=samples.filter(v=>v.name===name&&v.implementation==='go');if([...n,...g].some(v=>v.error)||new Set([...n,...g].map(v=>v.sha256)).size!==1)throw new Error(`output mismatch: ${name}`);const nodeMs=med(n.map(v=>v.matchMs)),goMs=med(g.map(v=>v.matchMs));return {name,nodeMedianMs:nodeMs,goMedianMs:goMs,speedup:nodeMs/goMs,sha256:n[0].sha256}});
 console.log(JSON.stringify({measuredAt:new Date().toISOString(),method:'Three fresh processes per runtime, alternating order; transform only, excludes compilation, I/O, child startup and fixture generation. Synthetic data, not production load.',comparison,samples},null,2));
}
