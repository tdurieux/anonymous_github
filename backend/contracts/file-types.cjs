const {spawnSync}=require('node:child_process');
const assert=require('node:assert/strict');
require('ts-node/register/transpile-only');
const {isTextFile}=require('../../src/core/anonymize-utils');
const mime=require('mime-types');
const samples=[Buffer.alloc(0),Buffer.from('Alice\nhello world'),Buffer.from([0,1,2,3,4]),Buffer.from([0xff,0xfe,65,0]),Buffer.from('研究😀 Alice'),Buffer.from('%PDF-1.7\nAlice')];
let state=1234567;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state>>>24};
const cases=[];
for(const name of ['LICENSE','COPYING','Dockerfile','unknown','script.bat','script.cmd','item.mystery',...Object.keys(mime.types).map(x=>'file.'+x)])for(const raw of samples)cases.push({name,raw});
for(let i=0;i<400;i++){const raw=Buffer.alloc(i%516);for(let j=0;j<raw.length;j++)raw[j]=i%3?random():32+random()%95;cases.push({name:'unknown',raw})}
const input=cases.map(c=>JSON.stringify({operation:'classify',filename:c.name,content:c.raw.toString('base64')})).join('\n')+'\n';
const p=spawnSync(process.env.GO_CONTRACT_BINARY,[],{input,encoding:'utf8',maxBuffer:32*1024*1024,timeout:60000});assert.equal(p.status,0,p.stderr||String(p.error));const output=p.stdout.trim().split('\n').map(JSON.parse);assert.equal(output.length,cases.length);const failures=[];
cases.forEach((c,i)=>{const expected=isTextFile(c.name,c.raw);if(output[i].text!==expected)failures.push({name:c.name,input:c.raw.toString('base64'),expected,actual:output[i]})});console.log(JSON.stringify({cases:cases.length,passed:cases.length-failures.length,failures},null,2));if(failures.length)process.exitCode=1;
