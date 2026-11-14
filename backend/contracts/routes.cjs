// Extract mounted API routes from the actual TypeScript AST, without importing
// server modules or opening database connections.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const modules = new Map();
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const join = (a,b) => ('/'+a+'/'+b).replace(/\/+/g,'/').replace(/\/$/,'') || '/';
function sourceFile(file) {
 file=path.normalize(file);
 if(modules.has(file)) return modules.get(file);
 const tree=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 const m={file,tree,imports:new Map(),aliases:new Map(),roots:new Set(),exports:new Map(),calls:[]};
 modules.set(file,m);
 for(const node of tree.statements) {
  if(ts.isImportDeclaration(node) && node.importClause && node.moduleSpecifier.text.startsWith('.')) {
   const base=path.resolve(path.dirname(file),node.moduleSpecifier.text);
   const target=fs.existsSync(base+'.ts')?base+'.ts':path.join(base,'index.ts');
   if(node.importClause.name) m.imports.set(node.importClause.name.text,{file:target,symbol:'default'});
   const bindings=node.importClause.namedBindings;
   if(bindings && ts.isNamedImports(bindings)) for(const item of bindings.elements) m.imports.set(item.name.text,{file:target,symbol:(item.propertyName||item.name).text});
  }
  if(ts.isExportAssignment(node)) m.exports.set('default',node.expression);
 }
 function walk(node) {
  if(ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
   const name=node.name.text,value=node.initializer;
   if(ts.isIdentifier(value) || ts.isPropertyAccessExpression(value)) m.aliases.set(name,value);
   if(ts.isCallExpression(value) && (value.expression.getText(tree)==='express.Router' || value.expression.getText(tree)==='express')) m.roots.add(name);
  }
  if(ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) m.calls.push(node);
  ts.forEachChild(node,walk);
 }
 walk(tree);
 m.calls.sort((a,b)=>a.expression.name.pos-b.expression.name.pos);
 return m;
}
function resolve(m,expression,seen=new Set()) {
 if(ts.isIdentifier(expression)) {
  const name=expression.text,key=m.file+':'+name;
  if(seen.has(key)) throw new Error('cyclic router alias '+key);
  seen.add(key);
  if(m.aliases.has(name)) return resolve(m,m.aliases.get(name),seen);
  if(m.imports.has(name)) {
   const ref=m.imports.get(name),other=sourceFile(ref.file);
   if(other.exports.has(ref.symbol)) return resolve(other,other.exports.get(ref.symbol),seen);
   return resolve(other,ts.factory.createIdentifier(ref.symbol),seen);
  }
  return {module:m,symbol:name};
 }
 if(ts.isObjectLiteralExpression(expression)) return {module:m,object:expression};
 if(ts.isPropertyAccessExpression(expression)) {
  const object=resolve(m,expression.expression,seen);
  if(object?.object) {
   const property=object.object.properties.find(p=>p.name?.getText(object.module.tree)===expression.name.text);
   if(property) return resolve(object.module,ts.isShorthandPropertyAssignment(property)?property.name:property.initializer,seen);
  }
 }
 return null;
}
function receiver(m,expression) {
 if(ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
  const result=receiver(m,expression.expression.expression);
  if(expression.expression.name.text==='route') result.routePath=literal(expression.arguments[0],m);
  return result;
 }
 return {root:resolve(m,expression)};
}
function literal(node,m) {
 assert.ok(node && (ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)),`nonliteral API route in ${m.file}: ${node?.getText(m.tree)}`);
 return node.text;
}
const output=[];
function mounted(m,symbol,prefix,stack=[]) {
 const key=m.file+':'+symbol+':'+prefix;
 assert.ok(!stack.includes(key),'cyclic router mount');
 for(const call of m.calls) {
  const property=call.expression;
  const target=receiver(m,property.expression);
  if(!target.root || target.root.module!==m || target.root.symbol!==symbol) continue;
  const verb=property.name.text;
  if(verb==='use') {
   if(!call.arguments[0] || !ts.isStringLiteral(call.arguments[0])) continue;
   const subpath=join(prefix,call.arguments[0].text);
   for(const argument of call.arguments.slice(1)) {
    const imported=resolve(m,argument);
    if(imported?.module.roots.has(imported.symbol)) mounted(imported.module,imported.symbol,subpath,[...stack,key]);
   }
  } else if(methods.has(verb)) {
   const argument=target.routePath===undefined?call.arguments[0]:null;
   // The main entry also serves SPA/static routes. Those are covered by the
   // file/browser tests, rather than represented as API handler registrations.
   if(argument && ts.isRegularExpressionLiteral(argument)) {
    assert.equal(symbol,'app','API regex route needs an explicit contract');
    continue;
   }
   const routePath=join(prefix,target.routePath===undefined?literal(argument,m):target.routePath);
   if(!/^\/(api|github|w)(\/|$)/.test(routePath)) continue;
   const line=m.tree.getLineAndCharacterOfPosition(property.name.getStart(m.tree)).line+1;
   output.push({method:verb.toUpperCase(),path:routePath,source:path.relative(process.cwd(),m.file),line,verification:'first matching Go handler; behavior verified separately'});
  }
 }
}
const entry=sourceFile(path.resolve('src/server/index.ts'));
mounted(entry,'app','');
assert.ok(output.length>90,'route extraction lost mounted routers');
const target='backend/contracts/routes.json';
const serialized=JSON.stringify(output,null,2)+'\n';
if(process.argv.includes('--check')) assert.equal(fs.readFileSync(target,'utf8'),serialized,'TypeScript route inventory changed; regenerate and verify Go dispatch');
else fs.writeFileSync(target,serialized);
console.log(`${output.length} mounted TypeScript API routes ${process.argv.includes('--check')?'verified':'generated'}`);
