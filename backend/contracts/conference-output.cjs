const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const path = 'src/core/Conference.ts';
const tree = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = tree.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === 'Conference');
const method = declaration.members.find(s => ts.isMethodDeclaration(s) && s.name.getText(tree) === 'toJSON');
assert.ok(method);
const now = '2030-03-01T12:34:56.789Z';
class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } }
const code = ts.transpileModule(`module.exports = function() ${method.body.getText(tree)}`, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
const moduleObject = {exports: {}};
vm.runInNewContext(code, {module: moduleObject, Date: FixedDate});
const cases = [];
const histories = [
 [{addDate:'0000-01-01T00:00:00.000Z', removeDate:'0001-01-01T00:00:00.000Z'}],
 [{addDate:'0000-01-01T00:00:00.000Z'}],
 [{addDate:'1969-01-01T00:00:00.000Z', removeDate:'1970-01-01T00:00:00.000Z'}],
 [],
 [{addDate:'2030-01-01T00:00:00.000Z'}],
 [{addDate:'2030-01-01T01:23:45.678Z', removeDate:'2030-02-02T03:04:05.006Z'}],
 [{addDate:'2031-01-01T00:00:00.000Z'}],
 [{addDate:'2030-02-01T00:00:00.000Z', removeDate:'2029-01-01T00:00:00.000Z'}],
 [{addDate:'1000-01-01T00:00:00.000Z'}],
 [{addDate:'2030-01-01T00:00:00.000Z', removeDate:null}],
 [{addDate:'2030-01-01T00:00:00.000Z', removeDate:'2031-01-01T00:00:00.000Z'}],
 [{addDate:'2030-01-01T00:00:00.000Z', removeDate:'2030-01-02T00:00:00.000Z'}, {addDate:'2030-01-03T00:00:00.001Z'}, {addDate:'2029-12-31T23:59:59.999Z'}],
];
for (const rate of [0, 0.5, 3, 0.123456789, null, undefined]) {
 for (const endDate of ['0001-01-01T00:00:00.000Z','2030-01-15T00:00:00.000Z', now, '2031-01-01T00:00:00.000Z']) {
  histories.forEach((history, i) => {
   const record = {conferenceID:'billing', name:'Conference', status:'ready', startDate:'2029-01-01T00:00:00.000Z', endDate, plan:{pricePerRepository:rate, quota:{size:500}}, billing:{name:'Chair',email:'chair@example.test'}, options:{image:true,link:false}, url:'https://conference.example.test', owners:['private-owner'], private:'must-not-appear', repositories:structuredClone(history)};
   const model = structuredClone(record);
   model.startDate = new Date(model.startDate); model.endDate = new Date(model.endDate);
   model.repositories.forEach(r => { r.addDate = new Date(r.addDate); if (r.removeDate) r.removeDate = new Date(r.removeDate); });
   const expected = moduleObject.exports.call({_data:model});
   cases.push({name:`rate=${rate}/end=${endDate}/history=${i}`, record, expected});
  });
 }
}
const output = JSON.stringify({now, cases}, null, 2) + '\n';
const target = 'backend/internal/server/testdata/conference-output.json';
if (process.argv.includes('--check')) assert.equal(fs.readFileSync(target, 'utf8'), output, 'TypeScript conference output changed');
else fs.writeFileSync(target, output);
console.log(`${cases.length} TypeScript conference output contracts ${process.argv.includes('--check') ? 'verified' : 'generated'}`);
