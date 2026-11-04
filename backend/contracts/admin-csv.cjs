const fs=require('node:fs');const vm=require('node:vm');const assert=require('node:assert/strict');const ts=require('typescript');
(async()=>{
 const path='src/server/routes/admin.ts';const tree=ts.createSourceFile(path,fs.readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);
 const helpers=['escapeRegex','isSafeSortField','parseSort','parseDateRange','csvEscape','sendCsv'].map(name=>{const node=tree.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text===name);assert.ok(node);return node.getText(tree)}).join('\n');
 const now='2030-01-02T12:00:00.000Z';class FixedDate extends Date{constructor(...args){super(...(args.length?args:[now]))}}
 const rich={repoId:'sample',username:'sample',conferenceID:'sample',name:'Conference',status:'ready',statusMessage:'Message',anonymizeDate:'2029-04-03T01:02:03.456Z',lastView:'2029-05-01T00:00:00.000Z',dateOfEntry:'2028-01-01T00:00:00.000Z',startDate:'2029-01-01T00:00:00.000Z',endDate:'2031-01-01T00:00:00.000Z',pageView:1.5,size:{storage:2.5},source:{repositoryName:'team/subgroup/project',branch:'main',commit:'opaque:revision',accessToken:'synthetic-secret'},options:{terms:['one','two']},emails:[{email:'chair@example.test'}],isAdmin:true,price:0.125,repositories:[{id:'one'},{id:'two'}],conference:'Conference',apiTokens:[{tokenHash:'synthetic-secret'}]};
 const samples=[{name:'empty',rows:[]},{name:'minimal',rows:[{}]},{name:'rich',rows:[rich]}];
 for(const value of [' leading','trailing ','a,b','say "hi"','line\nnext','line\rnext','back\\slash','é😀'])samples.push({name:`text/${JSON.stringify(value)}`,rows:[{...rich,name:value,username:value,repoId:value,statusMessage:value}]});
 for(const value of ['0001-01-01T00:00:00.000Z','2029-01-01T01:00:00+01:00',null])samples.push({name:`date/${value}`,rows:[{...rich,anonymizeDate:value,lastView:value,dateOfEntry:value,startDate:value,endDate:value}]});
 samples.push({name:'multiple',rows:[rich,{}, {...rich,pageView:1e21,size:{storage:1e20},price:1e-7}]});
 const cases=[];
 for(const kind of ['repos','users','conferences']) {
  const route=tree.statements.find(s=>ts.isExpressionStatement(s)&&ts.isCallExpression(s.expression)&&s.expression.expression.getText(tree)==='router.get'&&s.expression.arguments[0]?.text===`/${kind}`);
  const code=ts.transpileModule(`${helpers}\nmodule.exports=${route.expression.arguments[1].getText(tree)}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  for(const sample of samples) {
   const chain={lean:async()=>sample.rows};chain.sort=chain.limit=()=>chain;
   const model={find:()=>chain};const mod={exports:{}};
   vm.runInNewContext(code,{module:mod,Date:FixedDate,AnonymizedRepositoryModel:model,UserModel:model,ConferenceModel:model});
   const headers={};let body;
   await mod.exports({query:{format:'csv'}},{setHeader:(key,value)=>headers[key]=value,send:value=>body=value});
   assert.equal(typeof body,'string');assert.ok(!body.includes('synthetic-secret'));
   cases.push({name:`${kind}/${sample.name}`,kind,rows:sample.rows,expected:body,headers});
  }
 }
 const output=JSON.stringify(cases,null,2)+'\n';const target='backend/internal/server/testdata/admin-csv.json';
 if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),output,'TypeScript CSV output changed');else fs.writeFileSync(target,output);
 console.log(`${cases.length} TypeScript CSV contracts ${process.argv.includes('--check')?'verified':'generated'}`);
})().catch(error=>{console.error(error);process.exitCode=1});
