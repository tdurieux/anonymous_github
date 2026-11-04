const fs=require('node:fs'),assert=require('node:assert/strict'),ts=require('typescript');
async function main(){
 const cases=[];
 for(const [kind,file,field] of [['gist','Gist','gist'],['pr','PullRequest','pullRequest']]){
  const source=ts.createSourceFile(file+'.ts',fs.readFileSync(`src/core/${file}.ts`,'utf8'),ts.ScriptTarget.Latest,true);
  const cls=source.statements.find(ts.isClassDeclaration),method=cls.members.find(m=>m.name?.getText(source)==='resetSate');assert.ok(method?.body);
  const stub={updateOne:()=>({exec:async()=>{}})};
  const clear=new Function('AnonymizedGistModel','AnonymizedPullRequestModel',ts.transpile('async function clear(status, statusMessage) '+method.body.getText(source)+'\nreturn clear;',{target:ts.ScriptTarget.ES2020}))(stub,stub);
  const rich={creationDate:'2020-01-01T00:00:00.000Z',updatedDate:'2026-01-02T03:04:05.000Z',providerMetadata:{revision:'opaque:1'},comments:[{author:'Private author',body:'Private comment'}]};
  const specific=kind==='gist'?{description:'Private description',ownerLogin:'Private owner',files:[{filename:'private',content:'Private file'}],isPublic:true}:{body:'Private body',title:'Private title',diff:'Private diff',baseRepositoryFullName:'private/base',headRepositoryFullName:'private/head',state:'open',draft:true,merged:true,mergedDate:'2025-01-01T00:00:00.000Z'};
  for(const input of [{},{...rich,...specific},{...rich,...specific,isPublic:false,mergedDate:null},{...rich,...specific,creationDate:null,updatedDate:null}]){
   const model={_id:'fixture',[field]:structuredClone(input)};await clear.call({_model:model});cases.push({kind,input,expected:model[field]});
  }
 }
 const path='backend/internal/server/testdata/document-cleanup.json',output=JSON.stringify(cases,null,2)+'\n';if(process.argv.includes('--check'))assert.equal(fs.readFileSync(path,'utf8'),output);else fs.writeFileSync(path,output);console.log(`${cases.length} actual TypeScript document cleanup contracts verified`);
}
main().catch(error=>{console.error(error);process.exitCode=1});
