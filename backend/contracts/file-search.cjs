'use strict';
const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
function source(path){return ts.createSourceFile(path,fs.readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true)}
function find(n,p){if(p(n))return n;let result;ts.forEachChild(n,c=>{result ||= find(c,p)});return result}
const routes=source('src/server/routes/repository-public.ts'),core=source('src/core/Repository.ts');
const route=find(routes,n=>ts.isCallExpression(n)&&n.expression.getText(routes)==='router.get'&&n.arguments[0]?.text==='/:repoId/files/search');
const declaration=find(route,n=>ts.isVariableDeclaration(n)&&n.name.getText(routes)==='query').getText(routes);
const condition=find(route,n=>ts.isIfStatement(n)&&n.expression.getText(routes).includes('query.length')).expression.getText(routes);
const select=new Function(ts.transpile(`return function(req){const ${declaration};if(${condition})return null;return query}`,{target:ts.ScriptTarget.ES2022} ))();
const method=find(core,n=>ts.isMethodDeclaration(n)&&n.name.getText(core)==='searchFiles');
const Subject=new Function('isConnected',ts.transpile(`class Subject { ${method.getText(core)} };return Subject`,{target:ts.ScriptTarget.ES2022}))(false);
const files=[{name:'éclair.txt',path:'docs',size:1},{name:'İ.txt',path:'',size:2},{name:'ΟΣ.txt',path:'greek/ΣΙ',size:3},{name:'😀.txt',path:'',size:4},{name:'[x].txt',path:'literal',size:5},{name:'README.md',path:'nested/docs',size:6}];
const app=require('express')();app.set('query parser','extended');const parse=app.get('query parser fn');
const queries=['',...['','a','é','İ','i\u0307','ΟΣ','οσ','ος','ΣΙ','😀',' [x] ','\ufeffREADME\ufeff','\u0085README\u0085','docs','nested/docs','%FF'].map(q=>'q='+encodeURIComponent(q)),'q[]=README','q=README&q=docs','q[x]=README','q[]=', 'q=README&q[]=docs'];
(async()=>{
 const repo=new Subject();repo.anonymizedFiles=async()=>files;const rows=[];
 for(const query of queries){try{const value=select({query:parse(query)});rows.push({query,expected:value===null?[]:await repo.searchFiles(value)})}catch{rows.push({query,error:true})}}
 const file='backend/internal/server/testdata/file-search.json',output=JSON.stringify({files,cases:rows},null,2)+'\n';if(process.argv.includes('--check'))assert.equal(fs.readFileSync(file,'utf8'),output);else fs.writeFileSync(file,output);console.log(`${rows.length} actual TypeScript file search contracts verified`);
})().catch(error=>{console.error(error);process.exitCode=1});
