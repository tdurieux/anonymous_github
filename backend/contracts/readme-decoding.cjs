const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = 'src/core/source/GitHubRepository.ts';
const tree = ts.createSourceFile(source, fs.readFileSync(source, 'utf8'), ts.ScriptTarget.Latest, true);
let expression;
function visit(node) {
 if (ts.isVariableDeclaration(node) && node.name.getText(tree)==='readme' && node.initializer?.getText(tree).includes('Buffer.from')) expression=node.initializer.getText(tree);
 ts.forEachChild(node,visit);
}
visit(tree);assert.ok(expression);
const code=ts.transpileModule(`module.exports=(ghRes)=>${expression}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const moduleFixture={exports:{}};
vm.runInNewContext(code,{module:moduleFixture,Buffer});
const cases=[];
function add(name,data) {
 const row={name,data};
 try { row.expected=moduleFixture.exports({data}); } catch { row.error='readme_not_available'; }
 cases.push(row);
}
for(const encoding of ['base64','BASE64','base64url']) for(const content of ['', 'a', 'ab', 'abc', 'abcd', 'SGVsbG8=', 'SG Vs\nbG8\r\t=', 'SG!V@sb#G8=', 'SGVsbG8====junk', '=SGVsbG8', 'SGV=sbG8', '-_8', '////', 'YWJjZA', 'YWJjZA\u0141', 'YWJjZA💡']) add(`${encoding}:${JSON.stringify(content)}`,{encoding,content});
for(const bytes of [[0x80],[0xc0,0xaf],[0xe2,0x82],[0xe2,0x28,0xa1],[0xf0,0x9f,0x92],[0xed,0xa0,0x80],[0xf4,0x90,0x80,0x80],[0xef,0xbb,0xbf,65],[0xff,0xfe,0x61,0],[0,65,0xff]]) add(`utf8:${bytes}`,{encoding:'base64',content:Buffer.from(bytes).toString('base64')});
for(const encoding of ['utf8','utf-8','UTF8','ascii','latin1','binary','ucs2','ucs-2','utf16le','utf-16le','hex','unknown','utf8 ','',null,42]) for(const content of ['Hello é😀','61ff62','616']) add(`${encoding}:${content}`,{encoding,content});
for(const content of [null,42,true,[],[65,66,255],[257,-1,1.9,null,true,'258','0x43'],{type:'Buffer',data:[65,0,255]},{length:3,0:65,1:66},{length:'3',0:65},[{toString:null}],[[257]],{length:1,0:{toString:0}},{}]) add(`content:${JSON.stringify(content)}`,{content,encoding:'base64'});
for(const content of ['\u0136\u0131','61\u0136\u0131','fFz1','61 62']) add(`hex narrowing:${content}`,{encoding:'hex',content});
add('missing content',{encoding:'base64'});add('missing encoding',{content:'Hello é😀'});
const target='backend/internal/server/testdata/readme-decoding.json';
const serialized=JSON.stringify(cases,null,2)+'\n';
if(process.argv.includes('--check')) assert.equal(fs.readFileSync(target,'utf8'),serialized);
else fs.writeFileSync(target,serialized);
console.log(`${cases.length} TypeScript README decoding contracts ${process.argv.includes('--check')?'verified':'generated'}`);
