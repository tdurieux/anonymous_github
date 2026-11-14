'use strict';
const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
function source(path){return ts.createSourceFile(path,fs.readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true)}
function find(n,p){if(p(n))return n;let result;ts.forEachChild(n,c=>{result ||= find(c,p)});return result}
const file=source('src/server/routes/file.ts'),preview=source('src/server/routes/repository-private.ts'),user=source('src/server/routes/user.ts');
const download=find(file,n=>ts.isIfStatement(n)&&n.expression.getText(file)==='req.query.download').expression.getText(file);
const refresh=find(preview,n=>ts.isPropertyAssignment(n)&&n.name.getText(preview)==='force'&&n.initializer.getText(preview).includes('req.query.force')).initializer.getText(preview);
const force=find(user,n=>ts.isCallExpression(n)&&n.expression.getText(user)==='getAllRepositories').arguments[1].getText(user);
const select=new Function('req',`return {download:!!(${download}),force:(${force}),refresh:(${refresh})}`);
const app=require('express')();app.set('query parser','extended');const parse=app.get('query parser fn');
const queries=['',...['download','force','reconnect'].flatMap(name=>['','1','0','true'].flatMap(value=>[name+'='+value,name+'[]='+value,name+'[0]='+value,name+'[x]='+value])), 'force=1&force[]=1','reconnect=1&reconnect[]=1','force[toString]=x','reconnect=1&force[toString]=x'];
const cases=queries.map(query=>{try{return {query,...select({query:parse(query)})}}catch{return {query,error:true}}});
const filePath='backend/internal/server/testdata/file-query.json',output=JSON.stringify(cases,null,2)+'\n';if(process.argv.includes('--check'))assert.equal(fs.readFileSync(filePath,'utf8'),output);else fs.writeFileSync(filePath,output);console.log(`${cases.length} TypeScript file query contracts verified`);
