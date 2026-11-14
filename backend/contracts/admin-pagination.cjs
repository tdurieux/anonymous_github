const fs=require('node:fs');const vm=require('node:vm');const assert=require('node:assert/strict');const ts=require('typescript');
const path='src/server/routes/admin.ts';const tree=ts.createSourceFile(path,fs.readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);
const helpers=['isSafeSortField','parseSort'].map(name=>{const node=tree.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text===name);assert.ok(node);return node.getText(tree)}).join('\n');
const app=require('express')();app.set('query parser','extended');const parse=app.get('query parser fn');
const cases=[];
for(const kind of ['repos','users','conferences']) {
 const route=tree.statements.find(s=>ts.isExpressionStatement(s)&&ts.isCallExpression(s.expression)&&s.expression.expression.getText(tree)==='router.get'&&s.expression.arguments[0]?.text===`/${kind}`);
 const declarations=route.expression.arguments[1].body.statements.filter(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>['page','limit'].includes(d.name.getText(tree))));
 assert.equal(declarations.length,2);
 const mod={exports:{}};
 const code=ts.transpileModule(`${helpers}\nmodule.exports=(req)=>{${declarations.map(s=>s.getText(tree)).join('\n')}return {page,limit,sort:parseSort(req)}}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(code,{module:mod});
 const queries=[{},...['','0','-1','-20suffix','-0x10','2','2.9','2e3','+12suffix',' 17 ','0x10','0Xff','0b10','0007','0xg','junk','\uFEFF12','\u008512','10000','999999999999999999999999999999'].map(value=>({page:value,limit:value})),...['_id','repoId','size.storage','status','$where','a b','a/b','a;drop','status\n','status\r\n','', ['status','_id']].map(sort=>({sort,direction:'asc'})),{sort:'status',direction:['asc','desc']},{sort:'status',direction:'ASC'},{page:['3','4'],limit:['2','3']}];
 for(const query of queries) {
  const expected=mod.exports({query});
  cases.push({kind,query,expected});
 }
 for(const rawQuery of ['page[]=3&limit[]=2','page[1]=3&page[0]=2','page[x]=2','page[toString]=x','limit[toString]=x','sort[]=status&direction[]=asc','sort=status&sort[x]=foo','format[]=csv','format=csv','direction=asc&direction=desc']) {
  try { cases.push({kind,rawQuery,expected:mod.exports({query:parse(rawQuery)})}); }
  catch { cases.push({kind,rawQuery,error:true}); }
 }
}
const output=JSON.stringify(cases,null,2)+'\n';const target='backend/internal/server/testdata/admin-pagination.json';
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),output,'TypeScript admin pagination changed');else fs.writeFileSync(target,output);
console.log(`${cases.length} TypeScript admin pagination contracts ${process.argv.includes('--check')?'verified':'generated'}`);
// The repository/conference routes use find rather than aggregation. Verify
// the installed driver's negative-limit command behavior, not an inferred
// aggregate equivalent.
const {FindOperation}=require('mongodb/lib/operations/find');
const {MongoDBNamespace}=require('mongodb/lib/utils');
for(const limit of [-1,-10,-1001]) {
 let command;
 new FindOperation(null,new MongoDBNamespace('fixture','rows'),{}, {limit,skip:0}).executeCallback({command:(_ns,value,_options,callback)=>{command=value;callback(null,{})}},null,()=>{});
 assert.equal(command.limit,-limit);assert.equal(command.singleBatch,true);
}
console.log('3 installed MongoDB driver negative-limit contracts verified');
