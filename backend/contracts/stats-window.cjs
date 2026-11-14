const fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm'),assert=require('node:assert/strict');
function parse(path){return ts.createSourceFile(path,fs.readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true)}
function find(node,predicate){if(predicate(node))return node;let result;ts.forEachChild(node,child=>{result ||= find(child,predicate)});return result}
const index=parse('src/server/index.ts'),stats=parse('src/server/dailyStatsSnapshot.ts');
const call=find(index,n=>ts.isCallExpression(n)&&n.expression.getText(index)==='getStatsHistory');
const count=find(stats,n=>ts.isVariableDeclaration(n)&&n.name.getText(stats)==='count').initializer.getText(stats);
const sandbox={};vm.createContext(sandbox);vm.runInContext(`function select(req){const days=${call.arguments[0].getText(index)};return ${count};}`,sandbox);
const cases=[undefined,'','0','-0','-1','-20','-0x10','-0x0','-+2','- 2','1','30','365','999','4.5','2e2','0x10','0b10','12suffix','  +23 ','+ 23','Infinity','NaN',['7','30'],['','7'],'\ufeff-2','\u00852','999999999999999999999999999999999'].map(input=>({input:input??null,expected:sandbox.select({query:{days:input}})}));
const target='backend/internal/server/testdata/stats-window.json',output=JSON.stringify(cases,null,2)+'\n';
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),output);else fs.writeFileSync(target,output);
console.log(`${cases.length} TypeScript statistics window contracts ${process.argv.includes('--check')?'verified':'generated'}`);
