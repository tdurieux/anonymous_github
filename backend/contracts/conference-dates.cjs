'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
require('ts-node/register/transpile-only');const mongoose=require('mongoose');
const schema=require('../../src/core/model/conference/conferences.schema').default;
const Model=mongoose.model('conference_date_contract',schema);
const source=ts.createSourceFile('conference.ts',fs.readFileSync('src/server/routes/conference.ts','utf8'),ts.ScriptTarget.Latest,true);
const apply=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='applyConferenceForm');
const mod={exports:{}};vm.runInNewContext(ts.transpile(apply.getText(source)+';module.exports=applyConferenceForm',{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}),{module:mod,exports:{},Date});
const values=['March 1 2031','2031-02-30','0001-01-01','0000-01-01','-000001-01-01','+010000-01-01','2031-01-01T24:00:00Z','2031-01-01T01:00:00+02:00','invalid','',null,false,true,0,1,1.5,-1.5,1924992000000,'1924992000000',8640000000000001,{}, {toString:'bad'}, {valueOf:1},[],['2031','1','1'],[1],[null]];
const cases=[];
for(const field of ['startDate','endDate'])for(const value of values){
 const body={name:'Conference',startDate:'2031-01-01',endDate:'2032-01-01',[field]:value};
 const row={body};
 try{const doc=new Model();mod.exports(doc,body,true);const err=doc.validateSync();if(err)row.error=true;else row.expected={startDate:doc.startDate.toISOString(),endDate:doc.endDate.toISOString()}}catch{row.error=true}
 cases.push(row);
}
const file='backend/internal/server/testdata/conference-dates.json',output=JSON.stringify(cases,null,2)+'\n';if(process.argv.includes('--check'))assert.equal(fs.readFileSync(file,'utf8'),output);else fs.writeFileSync(file,output);
console.log(cases.length+' actual TypeScript/Mongoose conference date contracts verified');
