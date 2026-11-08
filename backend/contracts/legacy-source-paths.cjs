const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const ts=require('typescript');
const source='src/core/source/GitHubStream.ts';
const tree=ts.createSourceFile(source,fs.readFileSync(source,'utf8'),ts.ScriptTarget.Latest,true);
let generation,cachePath;
function visit(node){
 if(ts.isVariableDeclaration(node)&&node.initializer){
  const name=node.name.getText(tree),value=node.initializer.getText(tree);
  if(name==='generation'&&value.includes('this.data.cacheRevision'))generation=value;
  if(name==='cachePath'&&value.includes('contentGenerationPrefix'))cachePath=value;
 }
 ts.forEachChild(node,visit);
}
visit(tree);assert.ok(generation&&cachePath);
const helper={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/core/content-generation.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:helper.exports,require});
const fixture={exports:{}};
const code=ts.transpileModule(`module.exports=function(expected,filePath){const generation=${generation};return ${cachePath}}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInNewContext(code,{module:fixture,createHash,contentGenerationPrefix:helper.exports.contentGenerationPrefix});
const rows=[];
for(const treeGeneration of [undefined,'generation:one','<>&\u2028\\u2028']){
 for(const anonymizeDate of [undefined,'2026-01-02T03:04:05.006Z']){
  for(const contentCacheRevision of [undefined,null,'revision:two']){
   const record={treeGeneration,anonymizeDate,contentCacheRevision};
   const commit='opaque:<>&\u2029',revision='blob:one',path='nested/Alice.txt';
   const cacheGeneration=`${treeGeneration||'legacy'}:${anonymizeDate?new Date(anonymizeDate).toISOString():''}`;
   const expected=fixture.exports.call({data:{commit,cacheGeneration,cacheRevision:contentCacheRevision}},{sha:revision},path);
   rows.push({record,commit,revision,path,expected});
  }
 }
}
const target='backend/internal/server/testdata/legacy-source-paths.json';
const serialized=JSON.stringify(rows,null,2)+'\n';
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),serialized);else fs.writeFileSync(target,serialized);
console.log(`${rows.length} TypeScript legacy source path contracts ${process.argv.includes('--check')?'verified':'generated'}`);
