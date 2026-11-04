const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {Readable} = require('node:stream');
const ts = require('typescript');
const source = 'src/core/source/GitHubStream.ts';
const tree = ts.createSourceFile(source, fs.readFileSync(source, 'utf8'), ts.ScriptTarget.Latest, true);
let expression;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree)==='verify' && node.initializer?.getText(tree).includes('invalid_blob_hash')) expression=node.initializer.getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree); assert.ok(expression);
const code=ts.transpileModule(`module.exports=function(expected){return ${expression}}`, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const fixture={exports:{}};
vm.runInNewContext(code,{module:fixture,Buffer,createHash,setTimeout,clearTimeout});
const git = value => createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest('hex');
const payload='verified LFS bytes';
const proof={gitSha:git(payload),sha256:createHash('sha256').update(payload).digest('hex'),size:Buffer.byteLength(payload)};
const header='version https://git-lfs.github.com/spec/v1\n';
const oid=`oid sha256:${proof.sha256}`;
const size=`size ${proof.size}`;
const pointer=header+oid+'\n'+size+'\n';
const inputs=[
  ['ordinary', '', proof.gitSha], ['lfs',pointer], ['no final newline',pointer.trimEnd()],
  ['wrong pointer hash',pointer,'0'.repeat(40)], ['wrong oid',pointer.replace(proof.sha256,'0'.repeat(64))],
  ['wrong size',pointer.replace(size,'size 1')], ['wrong version',pointer.replace('/v1','/v2')],
  ['missing oid',header+size], ['missing size',header+oid], ['uppercase oid',pointer.replace(proof.sha256,proof.sha256.toUpperCase())],
  ['negative size',pointer.replace(size,'size -1')], ['plus size',pointer.replace(size,'size +18')],
  ['leading zeros',pointer.replace(size,'size 000'+proof.size)], ['space after size',pointer.replace(size,size+' ')],
  ['duplicate oid',pointer+'oid sha256:'+'0'.repeat(64)+'\n'], ['duplicate size',pointer+'size 1\n'],
  ['CRLF header',pointer.replaceAll('\n','\r\n')], ['CRLF fields',header+oid+'\r\n'+size+'\r\n'],
  ['unicode line separator',header+oid+'\u2028'+size+'\u2029'], ['extra fields',pointer+'ext-example hello\n'],
  ['at limit',pointer+'x'.repeat(1024-Buffer.byteLength(pointer))], ['over limit',pointer+'x'.repeat(1025-Buffer.byteLength(pointer))],
  ['oversize integer',pointer.replace(size,'size 999999999999999999999999999999')]
];
(async()=>{
 const rows=[];
 for (const [name,pointer,revision=git(pointer)] of inputs) {
   const row={name,pointer,revision,proof};
   let fetched=0;
   const verify=fixture.exports.call({data:{getToken:async()=> 'synthetic'},downloadFile:()=>{fetched++;return Readable.from([Buffer.from(pointer)]);}}, {sha:revision});
   try { row.expected=await verify(proof); } catch(error) { row.error=error.message; }
   row.fetched=fetched;rows.push(row);
 }
 const target='backend/internal/server/testdata/content-verification.json';
 const serialized=JSON.stringify(rows,null,2)+'\n';
 if(process.argv.includes('--check')) assert.equal(fs.readFileSync(target,'utf8'),serialized);
 else fs.writeFileSync(target,serialized);
 console.log(`${rows.length} TypeScript content verification contracts ${process.argv.includes('--check')?'verified':'generated'}`);
})().catch(error=>{console.error(error);process.exitCode=1;});
