const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
(async () => {
 const path = 'src/core/github-app.ts';
 const tree = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
 const declaration = tree.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'exchangeAppToken');
 assert.ok(declaration);
 const code = ts.transpileModule(declaration.getText(tree), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
 const base = {access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, refresh_token_expires_in: 7200};
 const inputs = [{name: 'valid', tokens: base, status: 200}, {name: 'fractional', tokens: {...base, expires_in: 0.25}, status: 200}];
 for (const field of ['access_token', 'refresh_token']) for (const value of ['', null, 1, true, [], {}]) inputs.push({name: `${field}/${JSON.stringify(value)}`, tokens: {...base, [field]: value}, status: 200});
 for (const field of ['expires_in', 'refresh_token_expires_in']) for (const value of [null, 0, -1, '3600', true, [], {}]) inputs.push({name: `${field}/${JSON.stringify(value)}`, tokens: {...base, [field]: value}, status: 200});
 for (const status of [400, 401, 403, 429, 500]) inputs.push({name: `http/${status}`, tokens: base, status});
 for (const input of inputs) {
  const oracle = {};
  vm.runInNewContext(code, {exports: oracle, config: {}, AbortSignal,
   appError: (code = 'github_app_reconnect_required', httpStatus = 401) => Object.assign(new Error(code), {httpStatus}),
   fetch: async () => ({status: input.status, ok: input.status >= 200 && input.status < 300, json: async () => input.tokens}),
  });
  input.expected = null;
  try { await oracle.exchangeAppToken({}); } catch (error) { input.expected = {code: error.message, status: error.httpStatus}; }
 }
 const target = 'backend/internal/server/testdata/oauth-tokens.json';
 const output = JSON.stringify(inputs, null, 2) + '\n';
 if (process.argv.includes('--check')) assert.equal(fs.readFileSync(target, 'utf8'), output, 'TypeScript OAuth token contract changed');
 else fs.writeFileSync(target, output);
 console.log(`${inputs.length} TypeScript OAuth token contracts ${process.argv.includes('--check') ? 'verified' : 'generated'}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
