const fs=require('node:fs');const vm=require('node:vm');const assert=require('node:assert/strict');const ts=require('typescript');
const path='src/core/User.ts';const tree=ts.createSourceFile(path,fs.readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);
const cls=tree.statements.find(s=>ts.isClassDeclaration(s)&&s.name?.text==='User');const method=cls.members.find(s=>ts.isMethodDeclaration(s)&&s.name.getText(tree)==='repositoryMembership');assert.ok(method);
const code=ts.transpileModule(`module.exports=function() ${method.body.getText(tree)}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;const mod={exports:{}};vm.runInNewContext(code,{module:mod});
const cases=[];
for(const username of [undefined,'','alice'])for(const github of [undefined,null,'','12345']) {
 const user={_id:'local-owner',username,externalIDs:{github}};
 cases.push({user,expected:mod.exports.call({id:user._id,username:user.username,model:user})});
}
const output=JSON.stringify(cases,null,2)+'\n';const target='backend/internal/server/testdata/user-membership.json';
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),output,'TypeScript membership changed');else fs.writeFileSync(target,output);
console.log(`${cases.length} TypeScript membership contracts ${process.argv.includes('--check')?'verified':'generated'}`);
