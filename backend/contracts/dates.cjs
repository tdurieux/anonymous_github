// Native JavaScript Date JSON output, including extended years and range limits.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const values = [0, 1, -1, 1000, -1000, 1700000000123, -62167219200000,
  -62167219200001, 253402300800000, -8640000000000000, 8640000000000000,
  -8640000000000001, 8640000000000001];
let state = 42;
for (let i = 0; i < 200; i++) {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  values.push(Math.trunc((state / 2 ** 32 - 0.5) * 17280000000000000));
}
const cases = values.map(milliseconds => ({milliseconds, expected: new Date(milliseconds).toJSON()}));
const output = JSON.stringify(cases, null, 2) + '\n';
const target = 'backend/internal/server/testdata/dates.json';
if (process.argv.includes('--check')) assert.equal(fs.readFileSync(target, 'utf8'), output, 'JavaScript date contract changed');
else fs.writeFileSync(target, output);
console.log(`${cases.length} JavaScript date contracts ${process.argv.includes('--check') ? 'verified' : 'generated'}`);
