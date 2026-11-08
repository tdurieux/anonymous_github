'use strict';
// Runs only against the isolated integration database supplied by the Go test.
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
require('ts-node/register/transpile-only');
const mongoose=require('mongoose');
const User=require('../../src/core/model/users/users.model').default;
const Repo=require('../../src/core/model/anonymizedRepositories/anonymizedRepositories.model').default;
const Conf=require('../../src/core/model/conference/conferences.model').default;
(async()=>{
 const uri=process.env.GO_TEST_MONGODB_URI,db=process.env.ADMIN_CAST_DATABASE;
 assert(/^admin_cast_[0-9a-f]{24}$/.test(db||''));assert(['127.0.0.1','localhost'].includes(new URL(uri).hostname));
 const connection=await mongoose.createConnection(uri,{dbName:db}).asPromise();
 try {
 const models=[User,Repo,Conf].map(m=>connection.model(m.modelName,m.schema,m.collection.name));
 const [users,repos,conferences]=models;
 const id=n=>new mongoose.Types.ObjectId(n.toString(16).padStart(24,'0'));
 await users.collection.insertMany([{_id:id(1),username:'alpha',dateOfEntry:new Date('2024-03-01T00:00:00Z'),status:'active',isAdmin:true},{_id:id(2),username:'beta',dateOfEntry:new Date('2023-01-01T00:00:00Z'),status:'banned',isAdmin:false}]);
 await repos.collection.insertMany([{_id:id(11),repoId:'one',anonymizeDate:new Date('2024-03-01T00:00:00Z'),status:'ready',owner:id(1),conference:'alpha',size:{storage:3}},{_id:id(12),repoId:'two',anonymizeDate:new Date('2023-01-01T00:00:00Z'),status:'ready',owner:id(2),conference:'beta',size:{storage:5}}]);
 const tree=ts.createSourceFile('admin.ts',fs.readFileSync('src/server/routes/admin.ts','utf8'),ts.ScriptTarget.Latest,true);
 const helpers=['escapeRegex','isSafeSortField','parseSort','parseDateRange','csvEscape','sendCsv'].map(name=>tree.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text===name).getText(tree)).join('\n');
 const app=require('express')();app.set('query parser','extended');const parse=app.get('query parser fn');
 const cases=[];
 for(const kind of ['users','repos']){
  const route=tree.statements.find(s=>ts.isExpressionStatement(s)&&ts.isCallExpression(s.expression)&&s.expression.arguments[0]?.text==='/'+kind);
  const mod={exports:{}};vm.runInNewContext(ts.transpile(helpers+'\nmodule.exports='+route.expression.arguments[1].getText(tree),{target:ts.ScriptTarget.ES2022}),{module:mod,Date,AnonymizedRepositoryModel:repos,UserModel:users,ConferenceModel:conferences});
  const queries=kind==='users'?['status[]=active','status=active&status=banned','status[_id]=active','status[$in]=active','status[$exists]=yes','status[$regex]=^act','status[$eq][_id]=active','status[$in][]=active','status[a]=active','status[$unknown]=x','status[]=active&format=csv']:['conference[]=alpha','conference=alpha&conference=beta','conference[_id]=alpha','conference[$in]=alpha','conference[$exists]=yes','conference[$eq][_id]=alpha','conference[$in][]=alpha','conference[a]=alpha','owner[]=alpha','owner=alpha&owner=beta','owner[_id]=alpha','owner[$in]=alpha','owner[$regex]=^alp','owner[a]=alpha','owner=missing&conference[a]=invalid','conference[]=alpha&format=csv'];
  queries.push('dateFrom[]=2024-02-30','dateTo=2024-02-29T24:00:00Z','dateFrom=March%201%202024','dateFrom=2024-03-01T01:00:00%2B02:00','dateFrom=0001-01-01','dateFrom[toString]=x','dateTo[toString]=x','dateFrom[]=2024-02-30&format=csv');
  if(kind==='repos')queries.push('owner=missing&dateFrom[toString]=x');
  for(const query of queries){
   let output,csv;const headers={};
   try{await mod.exports({query:parse(query)},{json:value=>{output=value},setHeader:(k,v)=>{headers[k]=v},send:value=>{csv=value}});
    if(output){output=JSON.parse(JSON.stringify(output));output.results=output.results.map(r=>r._id);output.statusCounts.sort((a,b)=>String(a._id).localeCompare(String(b._id)));}
    cases.push({kind,query,output,csv});
   }catch(e){cases.push({kind,query,error:true,errorMessage:e.message})}
  }
 }
 process.stdout.write(JSON.stringify(cases));
 }finally{await connection.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
