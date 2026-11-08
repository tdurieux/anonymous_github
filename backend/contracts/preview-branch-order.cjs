'use strict';
const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
const source=ts.createSourceFile('GitHubRepository.ts',fs.readFileSync('src/core/source/GitHubRepository.ts','utf8'),ts.ScriptTarget.Latest,true);
function find(n,p){if(p(n))return n;let result;ts.forEachChild(n,c=>{result ||=find(c,p)});return result}
const method=find(source,n=>ts.isMethodDeclaration(n)&&n.name.getText(source)==='readme');
const code=ts.transpile('({'+method.getText(source)+'})',{target:ts.ScriptTarget.ES2022});
const app=require('express')();app.set('query parser','extended');const parse=app.get('query parser fn');
(async()=>{
 const cases=[];
 for(const mode of ['populated','empty','failure'])for(const query of ['branch[]=','branch[toString]=main','branch=missing']) {
  const calls=[];
  class AnonymousError extends Error{constructor(code,options){super(code);this.httpStatus=options.httpStatus}}
  const model={findOne:()=>({select:()=>{calls.push('lookup');return {branches:[]}}})};
  const instance=new Function('RepositoryModel','AnonymousError','return '+code)(model,AnonymousError);
  instance._data={defaultBranch:'main'};
  instance.branches=async()=>{calls.push('branches');if(mode==='failure')throw new AnonymousError('repo_not_found',{httpStatus:503});return mode==='empty'?[]:[{name:'main',commit:'fixture',readme:'cached'}]};
  let error,status;
  try{await instance.readme({branch:parse(query).branch,accessToken:'fixture'})}catch(e){error=e instanceof TypeError?'invalid_query_value':e.message;status=e.httpStatus||500}
  assert(error);cases.push({mode,query,calls,error,status});
 }
 const file='backend/internal/server/testdata/preview-branch-order.json',output=JSON.stringify(cases,null,2)+'\n';
 if(process.argv.includes('--check'))assert.equal(fs.readFileSync(file,'utf8'),output);else fs.writeFileSync(file,output);
 console.log(cases.length+' actual TypeScript README discovery-order contracts verified');
})().catch(e=>{console.error(e);process.exitCode=1});
