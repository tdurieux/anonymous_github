const fs=require('node:fs'),assert=require('node:assert/strict'),ts=require('typescript');
const source=fs.readFileSync('src/server/routes/project-names.ts','utf8');
const start=source.indexOf('  const body = input');const end=source.indexOf('  const type = String(body.type)',start);
assert.ok(start>=0&&end>start);
const validate=new Function('input','AnonymousError',ts.transpile(source.slice(start,end),{target:ts.ScriptTarget.ES2020})+'return body.name.trim();');
class AnonymousError extends Error{}
const inputs=[{}, {type:'repo',id:'item',name:' Name '}];
for(const field of ['type','id','name'])for(const value of [null,false,0,[],{},''])inputs.push({type:'repo',id:'item',name:'Name',[field]:value});
for(const name of ['x'.repeat(100),'x'.repeat(101),'😀'.repeat(50),'😀'.repeat(51),'\ufeffName\ufeff','\u0085Name\u0085','\u009f','\tName','Name\n','\u007f','\u2028Name\u2029'])inputs.push({type:'repo',id:'item',name});
for(const id of ['é'.repeat(250),'é'.repeat(251),'😀'.repeat(125),'😀'.repeat(126)])inputs.push({type:'gist',id,name:'Name'});
inputs.push({type:'pr',id:'item',name:' '},{type:'other',id:'item',name:'Name'});
const cases=inputs.map((body,i)=>{try{return{name:`case-${i}`,body,expected:validate(body,AnonymousError)}}catch{return{name:`case-${i}`,body,rejected:true}}});
const path='backend/internal/server/testdata/project-names.json',output=JSON.stringify(cases,null,2)+'\n';
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(path,'utf8'),output);else fs.writeFileSync(path,output);
console.log(`${cases.length} TypeScript project-name contracts verified`);
