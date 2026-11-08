'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const app=require('express')();app.set('query parser','extended');
const parse=app.get('query parser fn');
const queries=['','days=7','days=','days=7&days=2','days[]=7&days[]=30','days[1]=7&days[0]=2','days=3&days[]=7','days[]=7&days=3','days[1]=7&days=3','days[21]=7','days[x]=7','days=3&days[x]=7','days[x]=7&days=3','days[0][]=7','days[0]=3&days[0]=7','days[toString]=7','days[__proto__][x]=3','days[constructor][prototype][x]=3','days%5B%5D=3','days=7%ff','days=7%zz','days[=3','days[[x]]=3','days[x]ignored[y]=3','days[0][0][0][0][0][0]=3','days[19]=3','days[20]=3','days[01]=3','[days]=3','days[a=b]=7','days=3;other=7',Array(21).fill('days=3').join('&'),Array(21).fill('days[]=3').join('&'),Array(1000).fill('x=3').join('&')+'&days=7'];
const keys=['days','days[]','days[0]','days[1]','days[19]','days[20]','days[21]','days[x]','days[0][]','days[][x]','days[x][]','days[0][x]','days[1][x]','days[__proto__]','days[toString]','days[valueOf]','days[constructor]','other'];
const vals=['','7','2','-1','0x10','7suffix','%EF%BB%BF3','%FF','%zz','a+b'];let seed=48171;function next(n){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n}
for(let i=0;i<700;i++){const parts=[];const count=1+next(10);for(let j=0;j<count;j++)parts.push(keys[next(keys.length)]+'='+vals[next(vals.length)]);queries.push(parts.join('&'));}
for(const key of keys) {
 for(const other of keys) queries.push(key+'=7&'+other+'=2');
 for(const count of [19,20,21,25]) {
  const repeated=Array(count).fill(key+'=7').join('&');
  queries.push(repeated+'&days=2', 'days=2&'+repeated, repeated+'&days[x]=2');
 }
}
const cases=queries.map(query=>{const parsed=parse(query).days;const shape={scalar:typeof parsed==='string',truthy:!!parsed};try{return{query,...shape,value:String(parsed)}}catch{return{query,...shape,error:true}}});
const file='backend/internal/server/testdata/query-values.json',output=JSON.stringify(cases,null,2)+'\n';
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(file,'utf8'),output);else fs.writeFileSync(file,output);
console.log(`${cases.length} Express extended query contracts ${process.argv.includes('--check')?'verified':'generated'}`);
