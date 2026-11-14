const fs = require('node:fs');
const assert = require('node:assert/strict');
const ts = require('typescript');
const file = 'src/queue/index.ts';
const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const queues = {downloadWorker: 'download', removeWorker: 'remove', cacheWorker: 'cache'};
const cases = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && queues[node.name.getText(tree)]) {
    const call = node.initializer;
    assert.ok(ts.isNewExpression(call) && call.expression.getText(tree) === 'Worker');
    const options = call.arguments[2];
    assert.ok(ts.isObjectLiteralExpression(options));
    const concurrency = options.properties.find(p => p.name?.getText(tree) === 'concurrency');
    assert.ok(concurrency && ts.isNumericLiteral(concurrency.initializer));
    cases.push({name: queues[node.name.getText(tree)], concurrency: Number(concurrency.initializer.text)});
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.equal(cases.length, 3);
cases.sort((a, b) => a.name.localeCompare(b.name));
const output = JSON.stringify(cases, null, 2) + '\n';
const target = 'backend/internal/server/testdata/worker-queues.json';
if (process.argv.includes('--check')) assert.equal(fs.readFileSync(target, 'utf8'), output, 'TypeScript worker configuration changed');
else fs.writeFileSync(target, output);
console.log('3 TypeScript worker queue capacities verified');
