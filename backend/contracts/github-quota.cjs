const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
function source(path) { return ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true); }
const contextPath = 'src/core/github-token-context.ts';
const contextCode = ts.transpileModule(fs.readFileSync(contextPath, 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
const exportsObject = {};
vm.runInNewContext(contextCode, {exports: exportsObject, require});
const utilityTree = source('src/core/GitHubUtils.ts');
let prefix;
function findPrefix(node) {
 if (ts.isVariableDeclaration(node) && node.name.getText(utilityTree) === 'REDIS_GATE_PREFIX') {
  assert.ok(ts.isStringLiteral(node.initializer)); prefix = node.initializer.text;
 }
 ts.forEachChild(node, findPrefix);
}
findPrefix(utilityTree); assert.equal(typeof prefix, 'string');
const appTree = source('src/core/github-app.ts');
const templates = [];
function findScope(node) {
 if (ts.isPropertyAssignment(node) && node.name.getText(appTree) === 'quotaKey') templates.push(node.initializer.getText(appTree));
 ts.forEachChild(node, findScope);
}
findScope(appTree);
const installation = templates.find(text => text.includes('installation:'));
const appUser = templates.find(text => text.includes('app-user:'));
assert.ok(installation && appUser);
const cases = [];
for (const [index, token] of ['', 'synthetic-oauth', 'ghp_synthetic', 'github_pat_synthetic', 'synthetic-ü-🔑'].entries()) {
 cases.push({name: `token-${index}`, token, scope: '', expected: [prefix + exportsObject.githubQuotaKey(token)]});
}
for (const id of [1, 42, 9007199254740991]) {
 const token = `synthetic-installation-${id}`;
 const fallback = prefix + exportsObject.githubQuotaKey(token);
 const quotaKey = vm.runInNewContext(installation, {binding: {installationId: id}});
 exportsObject.registerGitHubToken(token, {quotaKey});
 cases.push({name: `installation-${id}`, token, scope: `installation:123:${id}`, expected: [fallback, prefix + exportsObject.githubQuotaKey(token)]});
}
for (const ownerId of ['000000000000000000000001', 'abcdefabcdefabcdefabcdef']) {
 const token = `synthetic-app-user-${ownerId}`;
 const fallback = prefix + exportsObject.githubQuotaKey(token);
 const quotaKey = vm.runInNewContext(appUser, {ownerId});
 exportsObject.registerGitHubToken(token, {quotaKey});
 cases.push({name: `app-user-${ownerId}`, token, scope: quotaKey, expected: [fallback, prefix + exportsObject.githubQuotaKey(token)]});
}
const target = 'backend/internal/server/testdata/github-quota.json';
const output = JSON.stringify(cases, null, 2) + '\n';
if (process.argv.includes('--check')) assert.equal(fs.readFileSync(target, 'utf8'), output, 'TypeScript quota keys changed');
else fs.writeFileSync(target, output);
console.log(`${cases.length} TypeScript quota-key contracts ${process.argv.includes('--check') ? 'verified' : 'generated'}`);
