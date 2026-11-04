// Run the actual TypeScript form validator with a fixed clock.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const path = 'src/server/routes/conference.ts';
const tree = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
const validator = tree.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'validateConferenceForm');
const plans = tree.statements.find(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => d.name.getText(tree) === 'plans'));
assert.ok(validator && plans);
const now = '2030-01-01T00:00:00.000Z';
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } }
class AnonymousError extends Error { constructor(code, options) { super(code); this.status = options.httpStatus; } }
const code = ts.transpileModule(`${plans.getText(tree)}\n${validator.getText(tree)}\nmodule.exports = validateConferenceForm;`, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
const moduleObject = {exports: {}};
vm.runInNewContext(code, {module: moduleObject, AnonymousError, Date: FixedDate});
const base = {name: 'Conference', conferenceID: 'conference-test', startDate: '2031-01-01', endDate: '2031-02-01', plan: {planID: 'free_conference'}};
const cases = [];
function add(name, change) {
 const body = structuredClone(base); change(body);
 let expected = null;
 try { moduleObject.exports(body); }
 catch (e) { expected = e instanceof AnonymousError ? {code:e.message,status:e.status} : {code:'internal_error',status:500}; }
 cases.push({name, body, expected});
}
add('valid', () => {});
for (const field of ['name', 'conferenceID', 'startDate', 'endDate']) {
 for (const value of [null, '', false, 0]) add(`${field}/${JSON.stringify(value)}`, b => { b[field] = value; });
 add(`${field}/missing`, b => { delete b[field]; });
}
add('precedence/all', b => { for (const field of ['name', 'conferenceID', 'startDate', 'endDate']) delete b[field]; });
add('start after end', b => { b.startDate = '2032-01-01'; });
add('end in past', b => { b.startDate = '2020-01-01'; b.endDate = '2021-01-01'; });
add('end equals now', b => { b.startDate = '2029-01-01'; b.endDate = now; });
add('unknown plan', b => { b.plan.planID = 'unknown'; });
for (const planID of ['premium_conference', 'unlimited_conference']) {
 const billing = {name: 'Chair', email: 'chair@example.test', address: 'Address', city: 'City', zip: '000', country: 'Country'};
 add(`${planID}/valid`, b => { b.plan.planID = planID; b.billing = billing; });
 add(`${planID}/missing billing`, b => { b.plan.planID = planID; });
 add(`${planID}/empty billing`, b => { b.plan.planID = planID; b.billing = {}; });
 for (const field of Object.keys(billing)) {
  for (const value of [null, '', false, 0, ' ']) add(`${planID}/${field}/${JSON.stringify(value)}`, b => { b.plan.planID = planID; b.billing = {...billing, [field]: value}; });
 }
}
for(const field of ['startDate','endDate'])for(const value of ['March 1 2031','2031-02-30','0001-01-01','2031-01-01T24:00:00Z','invalid',{}, {toString:'bad'},[],['2031','1','1'],1,1924992000000,true,8640000000000001])add(`${field}/date/${JSON.stringify(value)}`,b=>{b[field]=value});
add('invalid start before expired end',b=>{b.startDate='invalid';b.endDate='2020-01-01'});
add('coercion before plan',b=>{b.startDate={toString:'bad'};b.plan.planID='invalid'});
add('invalid date after plan',b=>{b.startDate='invalid';b.plan.planID='invalid'});
const target = 'backend/internal/server/testdata/conferences.json';
const output = JSON.stringify({now, cases}, null, 2) + '\n';
if (process.argv.includes('--check')) assert.equal(fs.readFileSync(target, 'utf8'), output, 'TypeScript conference validation changed');
else fs.writeFileSync(target, output);
console.log(`${cases.length} TypeScript conference form contracts ${process.argv.includes('--check') ? 'verified' : 'generated'}`);
