'use strict';
const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
function find(n,p){if(p(n))return n;let result;ts.forEachChild(n,c=>{result ||= find(c,p)});return result}
function windowExpression(path){const source=ts.createSourceFile(path,fs.readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);return find(source,n=>ts.isVariableDeclaration(n)&&n.name.getText(source)==='windowMinutes').initializer.getText(source)}
const performanceWindow=new Function('minutes','return '+windowExpression('src/core/performance-monitoring.ts'));
const cacheWindow=new Function('minutes','return '+windowExpression('src/core/cache-observability.ts'));
const app=require('express')();app.set('query parser','extended');const parse=app.get('query parser fn');
const queries=['',...['','60',' 60 ','060','60.0','6e1','0x3c','0b111100','0o74','15','1440','10080','NaN','Infinity','-Infinity','+60','-60','60x','0x3c_','0xffffffffffffffffffff','\ufeff60','\u008560'].map(x=>'minutes='+encodeURIComponent(x)),'minutes[]=60','minutes[0]=60','minutes[1]=60','minutes[]=60&minutes[]=15','minutes[0][]=60','minutes[x]=60','minutes[toString]=60','minutes[]=','minutes=60&minutes[]=15','minutes[20]=60','minutes=60%FF','minutes=60%zz'];
const cases=queries.map(query=>{try{const minutes=Number(parse(query).minutes);return{query,performance:performanceWindow(minutes),cache:cacheWindow(minutes)}}catch{return{query,error:true}}});
const file='backend/internal/server/testdata/monitoring-query.json',output=JSON.stringify(cases,null,2)+'\n';if(process.argv.includes('--check'))assert.equal(fs.readFileSync(file,'utf8'),output);else fs.writeFileSync(file,output);console.log(`${cases.length} TypeScript monitoring query contracts verified`);
