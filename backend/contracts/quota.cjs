const fs=require('node:fs');const vm=require('node:vm');const assert=require('node:assert/strict');const ts=require('typescript');
const path='src/server/routes/user.ts';const tree=ts.createSourceFile(path,fs.readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);
const route=tree.statements.find(s=>ts.isExpressionStatement(s)&&ts.isCallExpression(s.expression)&&s.expression.expression.getText(tree)==='router.get'&&s.expression.arguments[0]?.text==='/quota');
let condition;
function visit(node){if(ts.isIfStatement(node)&&node.expression.getText(tree).startsWith('cached &&'))condition=node.expression.getText(tree);ts.forEachChild(node,visit)}
visit(route);assert.ok(condition);
const mod={exports:{}};vm.runInNewContext(`module.exports=(r)=>{const cached=r.size;return !!(${condition})}`,{module:mod});
const now='2030-01-01T00:00:00.000Z';const cases=[];
for(const size of [undefined,null,{}, {storage:0,file:0},{storage:0,file:1},{storage:9,file:2},{file:2},{storage:null,file:2},{storage:0,file:-1},{storage:0}])for(const sizeComputedAt of [undefined,null,'',now]){const row={size,sizeComputedAt};cases.push({row,expected:mod.exports(row)})}
const userPath='src/core/User.ts';const userTree=ts.createSourceFile(userPath,fs.readFileSync(userPath,'utf8'),ts.ScriptTarget.Latest,true);
const cls=userTree.statements.find(s=>ts.isClassDeclaration(s)&&s.name?.text==='User');const method=cls.members.find(s=>ts.isMethodDeclaration(s)&&s.name.getText(userTree)==='quotaRepositories');assert.ok(method);
class FixedDate extends Date{constructor(...args){super(...(args.length?args:[now]))}}
const model={find:filter=>({select:()=>({lean:()=>({exec:async()=>filter})})})};const oracle={exports:{}};
vm.runInNewContext(ts.transpileModule(`module.exports=async function() ${method.body.getText(userTree)}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{module:oracle,Date:FixedDate,AnonymizedRepositoryModel:model});
(async()=>{
 const filter=await oracle.exports.call({id:'owner'});
 const output=JSON.stringify({now,filter,cases},null,2)+'\n';const target='backend/internal/server/testdata/quota.json';
 if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),output,'TypeScript quota contract changed');else fs.writeFileSync(target,output);
 console.log(`${cases.length} TypeScript quota cache contracts and selection filter ${process.argv.includes('--check')?'verified':'generated'}`);
})().catch(error=>{console.error(error);process.exitCode=1});
