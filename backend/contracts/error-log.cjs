const fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm'),assert=require('node:assert/strict');
function parse(path){return ts.createSourceFile(path,fs.readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true)}
function find(node,predicate){if(predicate(node))return node;let result;ts.forEachChild(node,child=>{result ||= find(child,predicate)});return result}
const logger=parse('src/core/logger.ts'),admin=parse('src/server/routes/admin.ts');
const bucket=find(logger,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='bucketFor');
const max=find(logger,n=>ts.isVariableDeclaration(n)&&n.name.getText(logger)==='ERROR_LOG_MAX').initializer.getText(logger);
const noisy=find(logger,n=>ts.isVariableDeclaration(n)&&n.name.getText(logger)==='noisyCodes').initializer.getText(logger);
const route=find(admin,n=>ts.isCallExpression(n)&&n.expression.getText(admin)==='router.get'&&n.arguments[0]?.text==='/errors');
const variable=name=>find(route,n=>ts.isVariableDeclaration(n)&&n.name.getText(admin)===name).initializer.getText(admin);
const code=ts.transpileModule(`${bucket.getText(logger)}\nconst ERROR_LOG_MAX=${max};const noisy=${noisy};function pagination(req){const offset=${variable('offset')};const limit=${variable('limit')};return {offset,limit};}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const sandbox={};vm.createContext(sandbox);vm.runInContext(code,sandbox);
const result={max:vm.runInContext('ERROR_LOG_MAX',sandbox),classification:[],pagination:[],noisy:vm.runInContext('[...noisy]',sandbox)};
for(const level of ['warn','error'])for(const status of [0,200,399,400,401,403,404,409,429,499,500,503])result.classification.push({level,status,bucket:sandbox.bucketFor({httpStatus:status},level)});
for(const input of ['', '0','-1','-22','1','250','5000','5001','12suffix','1.5','1e3','0x10','+13',' 25 ','nonsense','9999999999999999'])result.pagination.push({input,...sandbox.pagination({query:{offset:input,limit:input}})});
// Go intentionally saturates offsets at JS's largest safe integer.
for(const row of result.pagination)row.offset=Math.min(Number.MAX_SAFE_INTEGER,row.offset);
const output=JSON.stringify(result,null,2)+'\n',target='backend/internal/server/testdata/error-log.json';
if(process.argv.includes('--check'))assert.equal(fs.readFileSync(target,'utf8'),output);else fs.writeFileSync(target,output);
console.log(`${result.classification.length+result.pagination.length} TypeScript error log contracts ${process.argv.includes('--check')?'verified':'generated'}`);
