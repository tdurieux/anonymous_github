const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const ts=require('typescript');
(async()=>{
 const path='src/server/routes/admin.ts';
 const tree=ts.createSourceFile(path,fs.readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);
 const helpers=['escapeRegex','isSafeSortField','parseSort','parseDateRange'].map(name=>{
  const declaration=tree.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text===name);assert.ok(declaration,name);return declaration.getText(tree);
 }).join('\n');
 const app=require('express')();app.set('query parser','extended');const parse=app.get('query parser fn');
 const cases=[];
 for(const kind of ['repos','users','conferences']) {
  const statement=tree.statements.find(s=>ts.isExpressionStatement(s)&&ts.isCallExpression(s.expression)&&s.expression.expression.getText(tree)==='router.get'&&s.expression.arguments[0]?.text===`/${kind}`);
  assert.ok(statement,kind);
  const handler=statement.expression.arguments[1];
  const code=ts.transpileModule(`${helpers}\nmodule.exports=${handler.getText(tree)}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const queries=[{},...['ready','error','expired','removed','preparing'].map(flag=>({[flag]:'true'})),{ready:'true',preparing:'true',expired:'true',removed:'true',error:'true'},{ready:'false',status:'archived'},{owner:'exists'},{owner:'missing'},{owner:'missing',search:'private',conference:'ignored',ready:'true'},{conference:'conf'},{search:'Alice'},{search:'a-b, c# [x].*'},{search:'line\n\t\uFEFF\u0085'},{dateFrom:'2030-01-01',dateTo:'2031-01-01'},{dateFrom:'invalid',dateTo:'2030-02-03T01:02:03.456Z'},{role:'admin',status:'active'},{search:'test',owner:'exists',conference:'conf',ready:'true',error:'true',dateFrom:'2029-01-01'}];
  const inputs=queries.map(query=>({query}));
  for(const rawQuery of ['ready[]=true','ready=true&ready=false','ready[0]=true','ready[x]=true','ready[toString]=true','error[]=true&preparing[]=true&removed[]=true&expired[]=true','search[]=Alice','search=Alice&search=Bob','search[x]=Alice','search[toString]=Alice','search=','search=%F0%9F%98%80','role[]=admin','role=admin&role=user','role[x]=admin','role=admin','search[]=x&owner=missing','search=x&ready[toString]=true']) inputs.push({rawQuery,query:parse(rawQuery)});
  for(const input of inputs) {
   const {query}=input;
   const chain={countDocuments:async()=>0,exec:async()=>[],then:resolve=>resolve([])};
   for(const name of ['skip','sort','limit','lean'])chain[name]=()=>chain;
   const model={find:()=>chain,aggregate:async()=>[],findOne:async()=>query.owner==='exists'?{_id:'owner-id'}:null};
   const mod={exports:{}};
   vm.runInNewContext(code,{module:mod,Date,AnonymizedRepositoryModel:model,UserModel:model,ConferenceModel:model});
   let output;
   try {
    await mod.exports({query},{json:value=>{output=value;}});
    assert.ok(output);
    cases.push({kind,...input,expected:output.query,missingOwner:kind==='repos'&&query.owner==='missing'});
   } catch {cases.push({kind,...input,error:true});}
  }
 }
 const target='backend/internal/server/testdata/admin-filters.json';const output=JSON.stringify(cases,null,2)+'\n';
 if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),output,'TypeScript admin filters changed');else fs.writeFileSync(target,output);
 console.log(`${cases.length} TypeScript admin filter contracts ${process.argv.includes('--check')?'verified':'generated'}`);
})().catch(error=>{console.error(error);process.exitCode=1});
