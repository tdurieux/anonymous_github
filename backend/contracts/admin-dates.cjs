'use strict';
const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
const source=ts.createSourceFile('admin.ts',fs.readFileSync('src/server/routes/admin.ts','utf8'),ts.ScriptTarget.Latest,true);
const method=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='parseDateRange');
const parseRange=new Function(ts.transpile(method.getText(source)+';return parseDateRange;',{target:ts.ScriptTarget.ES2022}))();
const app=require('express')();app.set('query parser','extended');const parse=app.get('query parser fn');
const values=['','invalid','0000','0001-01-01','2024','2024-02','2023-02-29','2024-02-30','2024-02-31','2024-02-32','2024-00-01','2024-13-01','2024-01-00','2024-01-01','2024T00:00','2024-02T00:00','2024-01-01t00:00z',' 2024-01-01 ','2024-01-01T00:00Z ','2024-01-01T00:00Z\0ignored','+010000-01-01','-000001-01-01','-000000-01-01','+275760-09-13','+275760-09-14','-271821-04-20','-271821-04-19'];
for(const date of ['2024-02-29','2023-02-29','2024-02-30'])for(const clock of ['00:00','12:34:56','12:34:56.1','12:34:56.123456789','24:00','24:00:00.001','25:00','12:60','12:34:60'])for(const zone of ['Z','+02:30','-0330',''])values.push(date+'T'+clock+zone);
for(const value of ['0','1','12','13','31','32','49','50','99','100','000000-01-01','-000000-02-03','-000000-01-01T00:00Z','1/2/03','2024/02/30','2024.02.29','Jan 5','5 January 2024','Tue, 05 Mar 2024 12:34:56 GMT','March 5, 2024 12:30 PM','2024-01-01 12:34:56','2024-01-01 12:34:56.1234 GMT+0200','2024-01-01 (comment)','(comment) 2024-01-01','garbage 2024-01-01','garbage2024-01-01','2024-01-01 garbage','2024-01-01 GMT-8','2024-01-01 12::30','2024-01-01 12:30:40 EST','999999999999999999999999'])values.push(value);
for(const date of ['2024-02-29','2023-02-30','0001-01-01','-000000-02-03','01/02/03','32/01/02','Jan 5','5 March 49','December 31 99','2024,1,2'])
 for(const time of ['',' 12:34',' 12:34:56.000123',' 12:34:56.999999999999',' 24:00',' 12:00 AM',' 12:00 PM',' 0:00 PM',' 13:00 PM'])
 for(const zone of ['',' GMT',' UTC+01:30',' EST',' +0130'])values.push(date+time+zone);
for(const suffix of [' ','\t','\n','\uFEFF',' (ignored)',' garbage','\0ignored'])values.push('2024-01-01'+suffix);
const queries=['',...values.map(v=>'dateFrom='+encodeURIComponent(v)), 'dateFrom[]=2024-02-29','dateFrom[0]=2024-02-29','dateFrom=2024-02-29&dateFrom=2024-03-01','dateFrom[]=','dateFrom[x]=x','dateFrom[toString]=x','dateFrom=invalid&dateTo[]=2024-03-01','dateTo[toString]=x'];
const cases=queries.map(query=>{try{return {query,expected:parseRange({query:parse(query)},'date')}}catch{return {query,error:true}}});
const file='backend/internal/server/testdata/admin-dates.json',output=JSON.stringify(cases,null,2)+'\n';if(process.argv.includes('--check'))assert.equal(fs.readFileSync(file,'utf8'),output);else fs.writeFileSync(file,output);
console.log(cases.length+' actual TypeScript admin date/coercion contracts verified');
