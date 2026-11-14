// Exercise the real route update functions and Mongoose schemas without a database.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
process.env.SESSION_SECRET ||= 'synthetic-option-contract';
require('ts-node/register/transpile-only');
const mongoose = require('mongoose');
const {ContentAnonimizer} = require('../../src/core/anonymize-utils');
require('../../src/config').default.ANONYMIZATION_MASK = 'XXXX';
const cases = [];
for (const [kind, route, helper, modelName] of [
  ['repo', 'repository', 'updateRepoModel', 'anonymizedRepositories'],
  ['gist', 'gist', 'updateGistModel', 'anonymizedGists'],
  ['pr', 'pullRequest', 'updatePullRequestModel', 'anonymizedPullRequests'],
]) {
  const path = `src/server/routes/${route}-private.ts`;
  const tree = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === helper);
  assert.ok(declaration, helper);
  const code = ts.transpileModule(`${declaration.getText(tree)};module.exports=${helper}`, {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  }).outputText;
  const module = {exports: {}};
  vm.runInNewContext(code, {module, Date, normalizePreserveFiles: require("../../src/core/preserve-files").normalizePreserveFiles});
  const schema = require(`../../src/core/model/${modelName}/${modelName}.schema.ts`).default;
  const Model = mongoose.model(`options_contract_${kind}`, schema);
  const add = (name, options, terms = ['Alice', '']) => {
    const body = {source: {branch: 'main', commit: 'abc'}, terms, options};
    const document = new Model();
    module.exports(document, body);
    assert.equal(document.validateSync(), undefined, name);
    const expected = document.toObject().options;
    const input = 'Alice 0 1 -42 true false 0.000001 1e-7 100000000000000000000 1e+21 keep';
    const engine = new ContentAnonimizer({terms: expected.terms, image: true, link: true});
    cases.push({name: `${kind}/${name}`, kind, body, expected, input, output: engine.anonymize(input)});
  };
  add('empty', {});
  for (const [index, terms] of [
    [1, true, false, -42, 0],
    [1e-6, 1e-7, 1e20, 1e21],
    ['', false, 'Alice'],
    [-0, 1.25, 9007199254740992],
  ].entries()) add(`scalar-terms-${index}`, {}, terms);
  for (const value of [true, false]) {
    const all = Object.fromEntries(['update','image','pdf','notebook','link','page','title','body','comments','content','origin','username','date','diff','unknown'].map(key => [key, value]));
    add(`all-${value}`, {...all, expirationMode: 'never', pageSource: {branch: 'docs', path: '/site', private: 'discard'}});
  }
  for (const value of [null, 0, 1, '0', '1', 'true', 'false', 'yes', 'no']) {
    const flags = Object.fromEntries(['update','image','pdf','notebook','link','page','title','body','comments','content','origin','username','date','diff'].map(key => [key, value]));
    add(`boolean-coercion-${JSON.stringify(value)}`, flags);
  }
  for (const value of [null, '', false, 0, true, 1, -1.5, 1700000000123, '2026-06-01T12:30:00.000Z', '0001-01-01', 'March 1 2026', '2026-02-29', '2026-02-28T24:00:00Z', ['2026','3','1'], ['2026-03-01'], '2026-03-01T01:00:00+02:00']) add(`expiration-${value}`, {expirationDate: value});
  for (const value of ['', 'TRUE', 'False', ' yes ', 2, -1, [], {}]) {
    const body = {source: {branch: 'main', commit: 'abc'}, terms: ['Alice'], options: {image: value}};
    const document = new Model();
    module.exports(document, body);
    assert.ok(document.validateSync(), `unexpected accepted boolean ${JSON.stringify(value)}`);
    cases.push({name: `${kind}/invalid-boolean-${JSON.stringify(value)}`, kind, body, rejected: true});
  }
  add('page-source', {pageSource: {branch: 'docs', path: '/', arbitrary: 'discard'}});
  add('irrelevant-invalid-options', kind === 'repo' ? {diff: 'invalid', content: 123} : {page: 'invalid', pdf: 123});
}
const target = 'backend/internal/server/testdata/options.json';
const output = JSON.stringify(cases, null, 2) + '\n';
if (process.argv.includes('--check')) assert.equal(fs.readFileSync(target, 'utf8'), output, 'TypeScript option contract changed');
else fs.writeFileSync(target, output);
console.log(`${cases.length} TypeScript option contracts ${process.argv.includes('--check') ? 'verified' : 'generated'}`);
