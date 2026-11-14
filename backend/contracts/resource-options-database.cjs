'use strict';
// Actual route option helpers and Mongoose writes against an isolated test DB.
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
process.env.SESSION_SECRET ||= 'synthetic-option-oracle';
require('ts-node/register/transpile-only');
const mongoose=require('mongoose');
(async()=>{
 const uri=process.env.GO_TEST_MONGODB_URI,db=process.env.RESOURCE_OPTIONS_DATABASE;
 assert(/^resource_options_[0-9a-f]{24}$/.test(db||''));assert(['127.0.0.1','localhost'].includes(new URL(uri).hostname));
 const connection=await mongoose.createConnection(uri,{dbName:db}).asPromise();
 try {
 const tree=ts.createSourceFile('route-utils.ts',fs.readFileSync('src/server/routes/route-utils.ts','utf8'),ts.ScriptTarget.Latest,true);
 const errorHelper=tree.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text==='handleError');
 const errorModule={exports:{}};
 vm.runInNewContext(ts.transpile(errorHelper.getText(tree).replace(/^export\s+/, '')+';module.exports=handleError',{target:ts.ScriptTarget.ES2022}),{module:errorModule,Error,AnonymousError:require('../../src/core/AnonymousError').default,printError:()=>{},isResponseCancellation:()=>false});
 const cases=[];
 for(const [kind,route,helper,modelName] of [['repo','repository','updateRepoModel','anonymizedRepositories'],['gist','gist','updateGistModel','anonymizedGists'],['pr','pullRequest','updatePullRequestModel','anonymizedPullRequests']]){
  const source=ts.createSourceFile(route,fs.readFileSync(`src/server/routes/${route}-private.ts`,'utf8'),ts.ScriptTarget.Latest,true);
  const fn=source.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text===helper);
  const mod={exports:{}};vm.runInNewContext(ts.transpile(fn.getText(source)+';module.exports='+helper,{target:ts.ScriptTarget.ES2022}),{module:mod,Date,normalizePreserveFiles:require("../../src/core/preserve-files").normalizePreserveFiles});
  const Model=connection.model(modelName,require(`../../src/core/model/${modelName}/${modelName}.schema.ts`).default);
  const options=[{}, {image:'bad'}, {image:[]}, {image:{}}, {expirationDate:'bad'}, {expirationDate:[]}, {expirationDate:{}}, {expirationDate:{toString:'bad'}}, {expirationDate:1e16}, {expirationDate:'0001-01-01'}, {expirationDate:['2030','3','1']}, {image:'bad',expirationDate:'bad',link:false}, {image:true,link:false}, {expirationMode:0}, {expirationMode:true}, {expirationMode:{}}, {expirationMode:[]}, {expirationMode:{_id:'date'}}, {pageSource:{branch:1,path:false}}, {pageSource:{branch:{},path:'/'}}, {pageSource:{branch:[],path:{}}}, {pageSource:null}, {pageSource:true}, {pageSource:[]}, {pageSource:{unknown:'ignored'}}];
  for(const create of [true,false])for(const input of options){
   const body={terms:['Alice'],source:{branch:'main',commit:'abc'},options:input};
   const resourceId=new mongoose.Types.ObjectId().toHexString();
   let model=new Model({repoId:resourceId,gistId:resourceId,pullRequestId:resourceId,options:{terms:['before'],image:true,link:true,expirationDate:new Date('2040-01-01')}});
   if(!create){await model.save();model=await Model.findById(model._id)}
   let error;
   try {mod.exports(model,body);if(create)await model.save();else await Model.updateOne({_id:model._id},{$set:{options:model.options}}).exec();}
   catch(e){let status;errorModule.exports(e,{status:n=>{status=n;return{json:value=>{error={status,...value}}}}});}
   const stored=await Model.collection.findOne({_id:model._id});
   cases.push({kind,create,body,error,stored:stored?.options});
  }
 }
 process.stdout.write(JSON.stringify(cases));
 }finally{await connection.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
