// Run from the repository root after building cmd/contract. Synthetic data only.
// GO_CONTRACT_BINARY=/path/to/contract node backend/contracts/differential.cjs
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
require('ts-node/register/transpile-only');
const { ContentAnonimizer, anonymizePath } = require('../../src/core/anonymize-utils');
const { createTokenCipher } = require('../../src/core/credential-crypto');
const config = require('../../src/config').default;
config.ANONYMIZATION_MASK = 'XXXX'; config.APP_HOSTNAME = 'anonymous.test';
const contexts = { mask: 'XXXX', hostname: 'anonymous.test' };
const cases = [];
function fixture(content, terms, options = {}, operation = 'transform') {
  cases.push({ operation, content, options: { terms, ...options }, context: contexts });
}
for (const terms of [[], ['Alice'], ['Davo'], ['Davó'], ['Σ', 'Ж', '研究'], ['k', 's'],
  ['Alice=>Bob', 'Bob=>$&'], ['first.last'], ['a-a'], ['(Alice)'], ['Alice(?= Smith)'],
  ['(Alice)\\1'], ['a{1001}'], ['[a-z]+'], ['[invalid'], ['(a+)+'], ['=>'], ['  ', 'Alice']]) {
  for (const content of ['Alice ALICE alice Malice Alice2 éAlice Aliceé', 'Davo Davó DAVÓ Davoé éDavo',
    'Σ σ ς Ж ж 研究', 'k K K s S ſ', 'first.last firstXlast first\nlast first\rlast',
    'xa-a-a Alice Smith AliceAlice', 'https://example.org/Alice?q=1 and http://Alice.test/path',
    'plain text\r\n\u2028\u2029', '', 'aaab']) fixture(content, terms);
}
fixture('![Alice](photo.png "A title") and https://example.org/Alice', ['Alice'], {image: false, link: false});
fixture('https://github.com/owner/repo/blob/main/Alice.txt https://github.com/owner/repository', ['Alice'],
  {repoName: 'owner/repo', branchName: 'main', repoId: 'public-id'});
fixture('src/Alice/first.last.txt', ['Alice', 'first.last'], {}, 'path');
for (const bytes of [[0xff,0xfe,65,108,105,99,101],[0xe1,0x80,65,108,105,99,101],[0xed,0xa0,0x80,65,108,105,99,101],[0xf0,0x9f,0x92],[0x80,0x81],[0xef,0xbb,0xbf,65,108,105,99,101]]) {
 for (const terms of [[],['Alice']]) fixture(Buffer.from(bytes).toString('base64'),terms,{},'bytes');
}
for(const term of ['(?<=x)Alice','(?<person>Alice)','Alice|Bob','^Alice$','\\bAlice\\b','a*','[😀]','\\d+','a{0,2}','a\\sb']) {
 for(const content of ['xAlice Bob Alice\n','😀😀 Alice','a ab aaa b','a\r\nb','Alice\u2028Bob'])fixture(content,[term]);
}
// Exercise metadata invalidation, Unicode fallback offsets, and ordered masks.
for (const terms of [
 ['Alice=>Researcher0','Researcher0=>done'], ['Alice=>é','é=>done'],
 ['x.=>a','ab=>done'], ['Alice=>ALICE'], ['(?<=😀)Alice=>X'],
 ['(?=😀)=>X'], ['Alice(?=!)'], ['(?<=é)Alice'], ['a*=>😀']
]) for (const input of ['Alice Alice!', 'x-b x-b', '😀Alice 😀Alice', '😀😀', 'éAlice Alice!', 'aaa é😀 Alice']) fixture(input,terms);
let randomState=48271;
const fragments=['Alice','ALICE','first.last','first\nlast','first\rlast','Researcher0','x-b','éAlice','😀','https://example.org/Alice',' ','.','\n'];
for(let i=0;i<200;i++) {
 let content='';
 for(let j=0;j<24;j++) {randomState=(Math.imul(randomState,1664525)+1013904223)>>>0;content+=fragments[randomState%fragments.length]}
 fixture(content,i%2?['Alice=>Researcher0','Researcher0=>é','first.last=>Alice']:['x.=>a','ab=>done','Alice(?=!)','(?<=😀)Alice']);
}
const input = cases.map(c => JSON.stringify(c)).join('\n') + '\n';
const proc = spawnSync(process.env.GO_CONTRACT_BINARY, [], {input, encoding: 'utf8', maxBuffer: 16*1024*1024, timeout: 60000});
assert.equal(proc.status, 0, proc.stderr || String(proc.error));
const outputs = proc.stdout.trim().split('\n').map(JSON.parse);
assert.equal(outputs.length, cases.length);
const failures = [];
cases.forEach((c, index) => {
  let expected;
  try {
    if(c.operation==='bytes'){const raw=Buffer.from(c.content,'base64');const a=new ContentAnonimizer(c.options);const text=raw.toString('utf8');const result=a.anonymize(text);expected={content:(a.wasAnonymized?Buffer.from(result):raw).toString('base64'),changed:a.wasAnonymized};}
    else if (c.operation === 'path') expected = {content: anonymizePath(c.content, c.options.terms)};
    else { const a = new ContentAnonimizer(c.options); expected = {content: a.anonymize(c.content), changed: a.wasAnonymized}; }
  } catch { expected = {error: true}; }
  try { if (expected.error) assert.ok(outputs[index].error); else assert.deepEqual(outputs[index], expected); }
  catch { failures.push({index, input: c, expected, actual: outputs[index]}); }
});
const keys = JSON.stringify({v1: randomBytes(32).toString('base64')});
const cipher = createTokenCipher(keys, 'v1');
const cryptoCases = ['ordinary-owner', 'owner<&>\u2028\u2029', '研究'];
for (const owner of cryptoCases) {
  const common = {keys, active:'v1', owner, provider:'github', content:'synthetic-secret', context:contexts};
  const encrypted = cipher.encrypt(common.content, owner, common.provider);
  const p = spawnSync(process.env.GO_CONTRACT_BINARY, [], {encoding:'utf8', input:
    JSON.stringify({...common, operation:'decrypt', envelope:encrypted})+'\n'+JSON.stringify({...common, operation:'encrypt'})+'\n'});
  assert.equal(p.status,0,p.stderr); const [decrypted, envelope] = p.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(decrypted.content,common.content);assert.equal(cipher.decrypt(envelope,owner,common.provider),common.content);
}
console.log(JSON.stringify({cases: cases.length, passed:cases.length-failures.length, failures, credentialCrossLanguageCases:cryptoCases.length},null,2));
if (failures.length) process.exitCode=1;
