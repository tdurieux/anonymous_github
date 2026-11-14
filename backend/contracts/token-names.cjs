const fs=require('node:fs');const assert=require('node:assert/strict');
const source=fs.readFileSync('src/server/routes/admin-tokens.ts','utf8');
const expression=source.match(/const name = (.*);/)[1];
const nameFor=new Function('req',`return ${expression}`);
const inputs=[undefined,null,false,true,0,1,-1,1e21,[],[null],['Alice','Bob'],[[1,null],false],{}, {name:'ignored'}, {toString:'shadow'}, [{toString:null}], '', '  Alice  ', '\ufeffAlice\ufeff', '\u0085Alice\u0085','x'.repeat(300),'é'.repeat(200)];
const cases=inputs.map((value,i)=>{const body=value===undefined?{}:{name:value};try{return {name:`case-${i}`,body,expected:nameFor({body})}}catch{return{name:`case-${i}`,body,rejected:true}}});
const path='backend/internal/server/testdata/token-names.json';const output=JSON.stringify(cases,null,2)+'\n';
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(path,'utf8'),output);else fs.writeFileSync(path,output);
console.log(`${cases.length} TypeScript token naming contracts verified`);
