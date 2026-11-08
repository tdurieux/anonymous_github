require('ts-node/register/transpile-only');
const { expect } = require('chai');
const { createReviewCallbacks } = require('../src/server/service/review-callbacks');
const entry = () => ({ clientId:'1'.repeat(32),callbackId:'2'.repeat(32),url:'https://review.example.test/api/v1/artifacts/callback' });
const raw = callbacks => JSON.stringify({version:1,callbacks});
describe('registered review callback destinations', () => {
 it('binds exact HTTPS destinations to both client and callback IDs', () => {
  const registry=createReviewCallbacks(raw([entry()]));
  expect(registry.resolve(entry().clientId,entry().callbackId)).equal(entry().url);
  expect(registry.resolve('3'.repeat(32),entry().callbackId)).equal(undefined);
  expect(registry.resolve(entry().clientId,'4'.repeat(32))).equal(undefined);
  expect(registry.formAction).equal("'self' "+entry().url);
 });
 it('rejects redirect parameters, URL credentials, aliases and unsafe CSP characters', () => {
  for(const url of ['http://review.example.test/callback','https://owner:secret@review.example.test/callback','https://review.example.test/callback?','https://review.example.test/callback#','https://review.example.test/callback?redirect=https://other.test','https://review.example.test/a/../callback','https://review.example.test/%63allback','https://review.example.test/callback/','https://review.example.test/callback\n','https://review.example.test/','https://review.example.test/callback;script-src']) expect(()=>createReviewCallbacks(raw([{...entry(),url}]))).to.throw('Invalid review callback registry');
 });
 it('rejects duplicate decoded configuration fields and bounded registry overflows', () => {
  for(const value of [raw([]),raw([entry(),entry()]),raw([{...entry(),extra:'x'}]),raw(Array.from({length:33},(_,i)=>({...entry(),callbackId:i.toString(16).padStart(32,'0')}))),raw([entry()]).replace('"version":1','"version":1,"ver\\u0073ion":1'),'{']) expect(()=>createReviewCallbacks(value)).to.throw('Invalid review callback registry');
  const entries=Array.from({length:4},(_,i)=>({...entry(),callbackId:String(i).repeat(32),url:'https://review.example.test/'+('x'.repeat(1100))+i}));
  expect(()=>createReviewCallbacks(raw(entries))).to.throw('Invalid review callback registry');
 });
});
