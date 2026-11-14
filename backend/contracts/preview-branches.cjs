'use strict';
const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
const source=ts.createSourceFile('GitHubRepository.ts',fs.readFileSync('src/core/source/GitHubRepository.ts','utf8'),ts.ScriptTarget.Latest,true);
function find(n,p){if(p(n))return n;let result;ts.forEachChild(n,c=>{result ||=find(c,p)});return result}
const method=find(source,n=>ts.isMethodDeclaration(n)&&n.name.getText(source)==='readme');
const fallback=method.body.statements[0].getText(source);
const selected=find(method,n=>ts.isVariableDeclaration(n)&&n.name.getText(source)==='selected').getText(source);
const choose=new Function('opt','model',ts.transpile(fallback+'; const '+selected+'; return selected?.name;', {target:ts.ScriptTarget.ES2022}));
const app=require('express')();app.set('query parser','extended');const parse=app.get('query parser fn');
const branches=['main','release','main,release','[object Object]'].map(name=>({name}));
const queries=['','branch=','branch=main','branch=release','branch[]=release','branch[0]=main','branch=main&branch=release','branch=main&branch[]=release','branch[]=','branch[x]=main','branch[toString]=main','branch=%20main%20'];
const cases=queries.map(query=>{try{return{query,selected:choose.call({_data:{defaultBranch:'main'}},{branch:parse(query).branch},{branches})??null}}catch{return{query,error:true}}});
const file='backend/internal/server/testdata/preview-branches.json',output=JSON.stringify({branches,cases},null,2)+'\n';if(process.argv.includes('--check'))assert.equal(fs.readFileSync(file,'utf8'),output);else fs.writeFileSync(file,output);
console.log(cases.length+' actual TypeScript README branch contracts verified');
