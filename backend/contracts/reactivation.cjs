const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
require('ts-node/register/transpile-only');
const {RepositoryStatus} = require('../../src/core/types');
const path = 'src/server/routes/repository-private.ts';
const tree = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
const name = 'shouldReactivateInactiveRepository';
const declaration = tree.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
assert.ok(declaration, name);
const code = ts.transpileModule(declaration.getText(tree), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
const oracle = {};
vm.runInNewContext(code, {exports: oracle, RepositoryStatus, Date});
const now = new Date('2026-01-01T00:00:00.000Z');
const cases = [];
for (const status of Object.values(RepositoryStatus)) {
 for (const [label, options] of [
  ['never', {expirationMode: 'never'}],
  ['future', {expirationMode: 'remove', expirationDate: new Date('2099-01-01T00:00:00.000Z')}],
  ['past', {expirationMode: 'remove', expirationDate: new Date('2000-01-01T00:00:00.000Z')}],
  ['missing', {}],
  ['empty', {expirationMode: 'remove', expirationDate: null}],
  ['boundary', {expirationMode: 'remove', expirationDate: now}],
 ]) {
  cases.push({name: `${status}/${label}`, status, options, now, expected: oracle[name]({status, options}, now)});
 }
}
const target = 'backend/internal/server/testdata/reactivation.json';
const output = JSON.stringify(cases, null, 2) + '\n';
if (process.argv.includes('--check')) assert.equal(fs.readFileSync(target, 'utf8'), output, 'TypeScript reactivation contract changed');
else fs.writeFileSync(target, output);
console.log(`${cases.length} TypeScript reactivation contracts ${process.argv.includes('--check') ? 'verified' : 'generated'}`);
