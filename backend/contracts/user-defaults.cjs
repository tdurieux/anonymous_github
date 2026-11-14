const fs=require('node:fs');const assert=require('node:assert/strict');
require('ts-node/register/transpile-only');const mongoose=require('mongoose');
const Model=mongoose.model('user_defaults_contract',require('../../src/core/model/users/users.schema.ts').default);
const inputs=[{}, {terms:['Alice','']}, {terms:[1,true,false,null,-0,1e21]}, {terms:'Alice'}, {terms:null}, {terms:[{}]}, {terms:[]}, {options:{}}, {options:null}, {unknown:'discard',options:{unknown:true,expirationDate:'2030-01-01',pageSource:{branch:'main'}}}];
for(const value of [true,false,null,0,1,'0','1','true','false','yes','no','',2,[],{}])inputs.push({options:Object.fromEntries(['update','image','pdf','notebook','link'].map(key=>[key,value]))});
for(const value of [null,true,false,0,'docs',{},[]])inputs.push({options:{page:value,expirationMode:value}});
for(const options of [false,true,0,1,"bad",[]])inputs.push({options});
const cases=[];
for(const [i,body]of inputs.entries()) {
 let stored,expected,rejected=false;
 try{
  const query=Model.updateOne({_id:'111111111111111111111111'},{$set:{default:body}});
  stored=query._castUpdate(query.getUpdate()).$set.default;
  expected=Model.hydrate({_id:'111111111111111111111111',default:stored}).default;
 }catch(error){assert.ok(error.name==='CastError',error);rejected=true;}
 cases.push({name:`case-${i}`,body,rejected,stored,expected});
}
const initial=[{}, {default:null}, {default:{}}, {default:{options:{}}}].map(user=>({user,expected:Model.hydrate({_id:'111111111111111111111111',...user}).default}));
const target='backend/internal/server/testdata/user-defaults.json';const output=JSON.stringify({cases,initial},null,2)+'\n';
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),output,'TypeScript user defaults changed');else fs.writeFileSync(target,output);
console.log(`${cases.length} TypeScript default-setting casts and ${initial.length} read contracts ${process.argv.includes('--check')?'verified':'generated'}`);
