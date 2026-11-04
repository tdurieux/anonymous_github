'use strict';
const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
function find(n,p){if(p(n))return n;let result;ts.forEachChild(n,c=>{result ||= find(c,p)});return result}
const source=ts.createSourceFile('github-app.ts',fs.readFileSync('src/core/github-app.ts','utf8'),ts.ScriptTarget.Latest,true);
const fn=find(source,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='selectRepositoryAccess');
const condition=find(fn,n=>ts.isIfStatement(n)&&n.expression.getText(source).startsWith('choice !== undefined')).expression.getText(source);
const invalid=new Function('choice','return '+condition);
const app=require('express')();app.set('query parser','extended');const parse=app.get('query parser fn');
const queries=['','connection=','connection=oauth','connection=github-app','connection=custom','connection=oauth&connection=github-app','connection[]=oauth','connection[0]=github-app','connection[x]=oauth','connection=oauth&connection[]=oauth','connection[]=github-app&connection=oauth','connection[toString]=oauth','connection=%6fauth','anonymizedRepoId=fixture','anonymizedRepoId[]=fixture','anonymizedRepoId=fixture&anonymizedRepoId[]=fixture','anonymizedRepoId='];
const cases=queries.map(query=>{const parsed=parse(query);return{query,savedResource:typeof parsed.anonymizedRepoId==='string',invalidConnection:invalid(parsed.connection),choice:typeof parsed.connection==='string'?parsed.connection:''}});
const file='backend/internal/server/testdata/preview-query.json',output=JSON.stringify(cases,null,2)+'\n';if(process.argv.includes('--check'))assert.equal(fs.readFileSync(file,'utf8'),output);else fs.writeFileSync(file,output);console.log(`${cases.length} TypeScript preview query contracts verified`);
