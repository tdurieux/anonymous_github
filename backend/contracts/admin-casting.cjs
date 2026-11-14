'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
require('ts-node/register/transpile-only');
const User=require('../../src/core/model/users/users.model').default;
const Repo=require('../../src/core/model/anonymizedRepositories/anonymizedRepositories.model').default;
const app=require('express')();app.set('query parser','extended');const parse=app.get('query parser fn');
const inputs=['','x=','x=active','x[]=active','x=active&x=banned','x[1]=active','x[0][0]=active','x[_id]=active','x[a]=active','x[toString]=active','x[$eq]=active','x[$ne]=banned','x[$in][]=active&x[$in][]=banned','x[$in]=active','x[$nin][]=banned','x[$all][]=active','x[$gt]=a','x[$gte]=a','x[$lt]=z','x[$lte]=z','x[$exists]=true','x[$exists]=false','x[$exists]=1','x[$exists]=yes','x[$exists]=no','x[$exists]=bad','x[$exists][]=true','x[$type]=string','x[$type][]=string&x[$type][]=2','x[$type][a]=x','x[$regex]=act.*&x[$options]=i','x[$not][$eq]=active','x[$not]=active','x[$not][$not][$eq]=active','x[$unknown]=x','x[$eq][]=active','x[$eq][_id]=active','x[$in][0][_id]=active','x[a]=active&x[$eq]=active'];
const cases=[];
for(const [field,Model] of [['username',User],['status',User],['conference',Repo]])for(const input of inputs){
 const query=input.replace(/(^|&)x/g,(_,prefix)=>prefix+field),value=parse(query)[field];
 const row={field,query,present:!!value};
 if(value){
  const raw={[field]:value};row.raw=JSON.parse(JSON.stringify(raw));
  try{row.casted=JSON.parse(JSON.stringify(Model.find(raw).cast(Model)));row.rawAfter=JSON.parse(JSON.stringify(raw))}catch(e){row.error=true}
 }
 cases.push(row);
}
const file='backend/internal/server/testdata/admin-casting.json',output=JSON.stringify(cases,null,2)+'\n';
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(file,'utf8'),output);else fs.writeFileSync(file,output);
console.log(cases.length+' actual Mongoose admin casting contracts verified');
