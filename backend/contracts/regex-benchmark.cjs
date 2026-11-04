// Run from any directory with GO_BASELINE_BINARY and GO_BENCHMARK_BINARY.
const {spawnSync}=require('node:child_process');
const binaries={before:process.env.GO_BASELINE_BINARY,after:process.env.GO_BENCHMARK_BINARY};
if(!binaries.before||!binaries.after)throw new Error('GO_BASELINE_BINARY and GO_BENCHMARK_BINARY required');
const samples=[];
for(let run=0;run<3;run++)for(const implementation of run%2?['after','before']:['before','after']){
 const child=spawnSync(binaries[implementation],[],{encoding:'utf8',timeout:120000});
 if(child.status!==0)throw new Error(child.stderr||String(child.error));
 for(const line of child.stdout.trim().split('\n'))samples.push({run,implementation,...JSON.parse(line)});
}
const median=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
const comparison=[...new Set(samples.map(v=>v.name))].map(name=>{
 const before=samples.filter(v=>v.name===name&&v.implementation==='before'),after=samples.filter(v=>v.name===name&&v.implementation==='after');
 if([...before,...after].some(v=>v.error)||new Set([...before,...after].map(v=>v.sha256)).size!==1)throw new Error('output mismatch '+name);
 const beforeMs=median(before.map(v=>v.matchMs)),afterMs=median(after.map(v=>v.matchMs));
 return {name,beforeMs,afterMs,speedup:beforeMs/afterMs,beforeAllocatedBytes:median(before.map(v=>v.allocatedBytes)),afterAllocatedBytes:median(after.map(v=>v.allocatedBytes)),sha256:before[0].sha256};
});
console.log(JSON.stringify({measuredAt:new Date().toISOString(),method:'Three fresh processes per version, alternating order; transform only, excludes compilation, I/O, child startup and fixture generation. Same-machine comparison against the Go implementation before regex optimization.',comparison,samples},null,2));
