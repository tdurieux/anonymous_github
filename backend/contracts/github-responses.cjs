const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
(async () => {
 const path = 'src/core/github-app.ts';
 const tree = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
 const declaration = tree.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'githubRequest');
 assert.ok(declaration);
 const code = ts.transpileModule(declaration.getText(tree), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
 const cases = [];
 for (const status of [200, 204, 301, 400, 401, 403, 404, 422, 429, 500, 503]) {
  for (const headers of [{}, {'retry-after': ''}, {'retry-after': '30'}, {'x-ratelimit-remaining': '0'}]) {
   const oracle = {};
   const input = {name: `${status}/${JSON.stringify(headers)}`, status, headers, expected: null};
   vm.runInNewContext(code, {exports: oracle, AbortSignal,
    appError: (code = 'github_app_reconnect_required', httpStatus = 403) => Object.assign(new Error(code), {httpStatus}),
    fetch: async () => ({status, ok: status >= 200 && status < 300, headers: new Headers(headers), json: async () => ({ok: true})}),
   });
   try { await oracle.githubRequest('/user', 'synthetic'); }
   catch (error) { input.expected = {code: error.message, status: error.httpStatus}; }
   cases.push(input);
  }
 }
 const target = 'backend/internal/server/testdata/github-responses.json';
 const output = JSON.stringify(cases, null, 2) + '\n';
 if (process.argv.includes('--check')) assert.equal(fs.readFileSync(target, 'utf8'), output, 'TypeScript GitHub response contract changed');
 else fs.writeFileSync(target, output);
 console.log(`${cases.length} TypeScript GitHub response contracts ${process.argv.includes('--check') ? 'verified' : 'generated'}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
