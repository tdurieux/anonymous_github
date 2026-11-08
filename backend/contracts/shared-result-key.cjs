const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');const ts=require('typescript');
const file='src/core/cached-response.ts',tree=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
const fn=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='decisionKey');assert.ok(fn);
const configTree=ts.createSourceFile('src/config.ts',fs.readFileSync('src/config.ts','utf8'),ts.ScriptTarget.Latest,true);
let extensions;function visit(n){if(ts.isPropertyAssignment(n)&&n.name.getText(configTree)==='additionalExtensions')extensions=vm.runInNewContext(n.initializer.getText(configTree));ts.forEachChild(n,visit);}visit(configTree);assert.ok(extensions);
const config={additionalExtensions:extensions},fixture={exports:{}};
vm.runInNewContext(ts.transpileModule(fn.getText(tree),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:fixture.exports,config,createHash});
const rows=[];
for(const terms of [[],['Alice'],['é<>&\u2028','\\u2028']])for(const urls of [[],['https://forge.test/nested/project']])for(const revision of [undefined,'reset:two']){
 const record={repoId:'anonymous-one',treeGeneration:'generation',anonymizeDate:'2026-01-02T03:04:05.006Z',contentCacheRevision:revision};
 const row={path:'nested',name:'Alice.txt'};
 const options={terms,image:false,link:true,repoId:record.repoId,repoName:'team/subgroup/project',branchName:'main',sourceURLs:urls};
 const serialized={filePath:'nested/Alice.txt',cacheGeneration:'generation:2026-01-02T03:04:05.006Z',terms,cacheRevision:revision,image:false,link:true,repoId:options.repoId,repoName:options.repoName,branchName:options.branchName,sourceURLs:urls};
 const digest='sha256-'+'a'.repeat(64),mask='XX<>&\u2029',hostname='anonymous.test';
 config.ANONYMIZATION_MASK=mask;config.APP_HOSTNAME=hostname;
 rows.push({record,row,options,digest,mask,hostname,expected:fixture.exports.decisionKey(digest,serialized)});
}
const target='backend/internal/server/testdata/shared-result-key.json',data=JSON.stringify(rows,null,2)+'\n';
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),data);else fs.writeFileSync(target,data);
console.log(`${rows.length} TypeScript shared result key contracts ${process.argv.includes('--check')?'verified':'generated'}`);
