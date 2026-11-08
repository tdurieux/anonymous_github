const fs=require('node:fs');const vm=require('node:vm');const assert=require('node:assert/strict');const ts=require('typescript');
(async()=>{
 const now='2030-01-01T12:00:00.000Z';Date.now=()=>new Date(now).getTime();
 require('ts-node/register/transpile-only');const mongoose=require('mongoose');
 const UserModel=mongoose.model('admin_user_contract',require('../../src/core/model/users/users.schema.ts').default);
 const RepositoryModel=mongoose.model('Repository',require('../../src/core/model/repositories/repositories.schema.ts').default);
 const path='src/core/User.ts';const tree=ts.createSourceFile(path,fs.readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);
 const cls=tree.statements.find(s=>ts.isClassDeclaration(s)&&s.name?.text==='User');const method=cls.members.find(s=>ts.isMethodDeclaration(s)&&s.name.getText(tree)==='toJSON');assert.ok(method);
 const mod={exports:{}};vm.runInNewContext(ts.transpileModule(`module.exports=function() ${method.body.getText(tree)}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{module:mod});
 const uid='111111111111111111111111',rid='222222222222222222222222',rid2='333333333333333333333333',missing='444444444444444444444444';
 const base={_id:uid,username:'sample',dateOfEntry:now};
 const repo={_id:rid,externalId:'forge:opaque-id',name:'team/subgroup/project',source:'fixture',url:'https://forge.test/team/subgroup/project',dateOfEntry:now,size:123,defaultBranch:'main',pageSource:{branch:'docs',path:'/'},branches:[{_id:'555555555555555555555555',name:'main',commit:'opaque:revision',readme:'Readme'}]};
 const inputs=[
  ['minimal',base,[]],
  ['defaults',{_id:uid,username:'sample'},[]],
  ['rich',{...base,photo:'https://avatar.test',isAdmin:true,status:'banned',externalIDs:{github:'123'},accessTokenDates:{github:now},emails:[{_id:'666666666666666666666666',email:'owner@example.test',default:true}],projectNames:{'repo:example':'Project'},default:{terms:['Alice'],options:{expirationMode:'never',image:false,page:'docs'}},__v:2,accessTokens:{github:'synthetic-secret'},apiTokens:[{tokenHash:'synthetic-secret'}]},[]],
  ['populated',{...base,repositories:[rid,rid2]},[repo,{_id:rid2,name:'minimal'}]],
  ['missing-reference',{...base,repositories:[missing,rid]},[repo]],
  ['duplicate-references',{...base,repositories:[rid,rid]},[repo]],
  ['null-fields',{...base,isAdmin:null,status:null,default:null,emails:null,externalIDs:null,projectNames:null,repositories:null},[]],
  ['empty-maps',{...base,externalIDs:{},accessTokenDates:{},projectNames:{},default:{options:{}}},[]],
 ];
 const cases=[];
 for(const [name,user,repositories]of inputs){
  const document=UserModel.hydrate(user);
  RepositoryModel.find=(query)=>({exec:async()=>repositories.filter(r=>query._id.$in.map(String).includes(r._id)).map(r=>RepositoryModel.hydrate(r))});
  await UserModel.populate(document,{path:'repositories',model:RepositoryModel});
  const expected=mod.exports.call({_model:document});
  cases.push({name,user,repositories,expected});
 }
 const output=JSON.stringify({now,cases},null,2)+'\n';const target='backend/internal/server/testdata/admin-user.json';
 if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),output,'TypeScript admin user output changed');else fs.writeFileSync(target,output);
 console.log(`${cases.length} TypeScript populated user contracts ${process.argv.includes('--check')?'verified':'generated'}`);
})().catch(error=>{console.error(error);process.exitCode=1});
