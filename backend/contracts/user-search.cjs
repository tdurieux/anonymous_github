'use strict';
const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
const source=ts.createSourceFile('user.ts',fs.readFileSync('src/server/routes/user.ts','utf8'),ts.ScriptTarget.Latest,true);
function find(n,p){if(p(n))return n;let result;ts.forEachChild(n,c=>{result ||=find(c,p)});return result}
const route=find(source,n=>ts.isCallExpression(n)&&n.arguments[0]?.text==='/search/github-users');
const callback=ts.transpile('('+route.arguments[1].getText(source)+')',{target:ts.ScriptTarget.ES2022});
const app=require('express')();app.set('query parser','extended');const parse=app.get('query parser fn');
const {Octokit}=require('@octokit/rest');const oct=new Octokit();
const queries=['','q=','q=a','q=ab','q=%F0%9F%98%80','q=%C3%A9','q=++','q=a%2Bb','q=a%26b','q[]=ab','q[]=a&q[]=b','q=ab&q=cd','q[1]=ab','q[0]=a&q[2]=b','q[x]=ab','q[length]=0','q[length]=1','q[length]=2','q[length]=abc','q[length][]=1','q[length][toString]=1','q[toString]=ab','q[21]=ab','q=ab&q[x]=cd'];
(async()=>{
 const cases=[];
 for(const query of queries){
  const row={query,tokenCalls:0};
  const handler=new Function('getUser','octokit','handleError','return '+callback)(async()=>({getAccessToken:async()=>{row.tokenCalls++;return 'fixture';}}),()=>({search:{users:async params=>{const endpoint=oct.search.users.endpoint(params);row.upstreamQuery=new URL(endpoint.url).searchParams.get('q');return {data:{items:[]}};}}}),()=>{row.error=true});
  await handler({query:parse(query)},{json:value=>{row.response=value}});cases.push(row);
 }
 const file='backend/internal/server/testdata/user-search.json',output=JSON.stringify(cases,null,2)+'\n';
 if(process.argv.includes('--check'))assert.equal(fs.readFileSync(file,'utf8'),output);else fs.writeFileSync(file,output);
 console.log(cases.length+' actual TypeScript user-search/Octokit contracts verified');
})().catch(e=>{console.error(e);process.exitCode=1});
