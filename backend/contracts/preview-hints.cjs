'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
require('ts-node/register/transpile-only');
const Model=require('../../src/core/model/repositories/repositories.model').default;
const app=require('express')();app.set('query parser','extended');const parse=app.get('query parser fn');
const id='507f1f77bcf86cd799439011';
const queries=['','repositoryID=','repositoryID='+id,'repositoryID='+id.toUpperCase(),'repositoryID=abcdefghijkl','repositoryID=invalid','repositoryID[]='+id,'repositoryID='+id+'&repositoryID='+id,'repositoryID[2]='+id,'repositoryID[0][0]='+id,'repositoryID[_id]='+id,'repositoryID[x]='+id,'repositoryID[]=','repositoryID='+id+'&repositoryID[]=invalid','repositoryID[]=invalid&reconnect=1','repositoryID[]=invalid&reconnect[]=1'];
const cases=queries.map(query=>{
 const q=parse(query),value=q.reconnect==='1'?undefined:q.repositoryID;
 if(!value)return {query,filter:null};
 try{return {query,filter:JSON.parse(JSON.stringify(Model.findById(value).cast(Model)))}}catch{return {query,error:true}}
});
const file='backend/internal/server/testdata/preview-hints.json',output=JSON.stringify(cases,null,2)+'\n';
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(file,'utf8'),output);else fs.writeFileSync(file,output);
console.log(cases.length+' actual Mongoose preview hint contracts verified');
