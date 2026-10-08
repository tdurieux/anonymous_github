const { expect } = require("chai");
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const { URL } = require("url");
const path = require("path");
const { setTimeout: delay } = require("timers/promises");
const bundles = ["core.min.js", "vendor.min.js"].map(name => fs.readFileSync(path.join(__dirname, "../public/script", name), "utf8"));
const token = "3".repeat(64);
const fragment = `clientId=${"1".repeat(32)}&intentId=${"2".repeat(32)}&token=${token}`;
const csrf = "a".repeat(64);
const preview = () => ({ ticket: 'private-ticket', repositoryName: 'Synthetic repository', policy: { version: 1, access: 'restricted-review', retainUntil: '2099-01-01T00:00:00Z' }, expiresAt: new Date(Date.now() + 60000).toISOString() });
async function browser(overrides = {}, hash = fragment) {
  const errors = [], requests = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', error => errors.push(error.message));
  vc.on('error', error => errors.push(String(error)));
  const dom = new JSDOM('<!doctype html><html><head><meta name="review-consent-page" content="1"></head><body><div id="app"></div></body></html>', { url: 'https://anonymous.example.test/review-link#' + hash, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.HTMLCanvasElement.prototype.getContext = () => null;
  w.fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    const request = { pathname, ...options, payload: options.body ? JSON.parse(options.body) : null };
    requests.push(request);
    let data;
    if (overrides[pathname]) data = await overrides[pathname](request);
    else if (pathname === '/api/user') data = { username: 'owner' };
    else if (pathname === '/api/review-consent/csrf') data = { csrf };
    else if (pathname === '/api/review-consent/preview') data = preview();
    else if (pathname === '/api/review-consent/confirm') data = { requestId: request.payload.requestId, confirmedAt: new Date().toISOString() };
    else data = [];
    const status = data?.__status || 200;
    return { ok: status < 400, status, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(data?.__status ? data.body : data) };
  };
  bundles.forEach(bundle => w.eval(bundle));
  const app = w.anonymousApp;
  await app.router.isReady(); await delay(30);
  const document = w.document;
  const click = async selector => { document.querySelector(selector).click(); await delay(30); };
  return { w, app, document, errors, requests, click,
    async preview() { const input = document.querySelector('#review-repository'); input.value = 'synthetic-repo'; input.dispatchEvent(new w.Event('input', { bubbles: true })); await click('button[type=submit]'); },
    async accept() { for (const input of document.querySelectorAll('input[type=checkbox]')) { input.click(); } await delay(5); },
    close() { app.app.unmount(); w.close(); },
  };
}
describe('review consent browser page', function () {
  this.timeout(10000);
  let b;
  afterEach(() => b?.close());
  it('scrubs the fragment before requests and keeps secrets out of rendered state and storage', async function () {
    b = await browser();
    expect(b.w.location.href).equal('https://anonymous.example.test/review-link');
    expect(JSON.stringify(b.w.history.state)).not.include(token);
    await b.preview();
    expect(b.document.body.textContent).include('Synthetic repository');
    expect(b.document.documentElement.outerHTML).not.include(token).not.include('private-ticket');
    expect(Object.keys(b.w.localStorage)).deep.equal(['darkMode']);
    expect(JSON.stringify(b.w.localStorage)).not.include(token).not.include('private-ticket');
    expect(b.w.sessionStorage.length).equal(0);
    expect(b.document.querySelector('.app-header')).equal(null);
    expect(b.requests.find(r => r.pathname.endsWith('/preview')).payload.intent.token).equal(token);
    expect(b.errors).deep.equal([]);
  });
  it('requires both approvals and preserves the confirmation identity after response loss', async function () {
    let attempts = 0;
    b = await browser({ '/api/review-consent/confirm': request => { if (++attempts === 1) throw new Error('lost response'); return { requestId: request.payload.requestId, confirmedAt: new Date().toISOString() }; } });
    await b.preview();
    expect(b.document.querySelector('button[type=button]').disabled).equal(true);
    await b.accept(); await b.click('button[type=button]');
    expect(b.document.body.textContent).include('Retry confirmation');
    expect(b.document.querySelector('#review-repository').disabled).equal(true);
    await b.click('button[type=button]');
    const writes = b.requests.filter(r => r.pathname.endsWith('/confirm'));
    expect(writes).length(2); expect(writes[0].payload).deep.equal(writes[1].payload);
    expect(b.document.body.textContent).include('Consent recorded. Artifact linking is not complete.');
  });
  it('does not send a preview after departure during the CSRF request', async function () {
    let resolve;
    b = await browser({ '/api/review-consent/csrf': () => new Promise(yes => { resolve = yes; }) });
    await b.preview(); b.app.app.unmount(); resolve({ csrf }); await delay(30);
    expect(b.requests.filter(r => r.pathname.endsWith('/preview'))).length(0);
    expect(b.requests.find(r => r.pathname.endsWith('/csrf')).signal.aborted).equal(true);
  });
  it('discards a late preview after account change', async function () {
    let resolve;
    b = await browser({ '/api/review-consent/preview': () => new Promise(yes => { resolve = yes; }) });
    await b.preview(); b.app.state.user = { username: 'someone-else' }; await delay(5); resolve(preview()); await delay(30);
    expect(b.document.body.textContent).include('Your account changed');
    expect(b.document.body.textContent).not.include('Synthetic repository');
  });
  it('rejects duplicate or missing fragment fields without making consent requests', async function () {
    b = await browser({}, fragment + '&token=' + token); await b.preview();
    expect(b.document.body.textContent).include('missing or invalid');
    expect(b.requests.some(r => r.pathname.startsWith('/api/review-consent'))).equal(false);
    expect(b.w.location.hash).equal('');
  });
  it('shows unavailable endpoints and keeps the intent request ID on preview retry', async function () {
    let attempts = 0;
    b = await browser({ '/api/review-consent/preview': () => ++attempts === 1 ? { __status: 404, body: {} } : preview() });
    await b.preview(); expect(b.document.body.textContent).include('not available'); await b.preview();
    const requests = b.requests.filter(r => r.pathname.endsWith('/preview'));
    expect(requests[0].payload.intent.requestId).equal(requests[1].payload.intent.requestId);
  });
  it('does not approve an expired preview', async function () {
    b = await browser({ '/api/review-consent/preview': () => ({ ...preview(), expiresAt: new Date(Date.now() + 1000).toISOString() }) });
    await b.preview(); await b.accept(); await delay(1050); await b.click('button[type=button]');
    expect(b.requests.some(r => r.pathname.endsWith('/confirm'))).equal(false);
    expect(b.document.body.textContent).include('preview expired');
  });
  it('requires sign-in without retaining the handoff in browser storage', async function () {
    b = await browser({ '/api/user': () => null });
    expect(b.document.querySelector('#review-repository')).equal(null);
    expect(b.document.body.textContent).include('Sign in first');
    expect(b.w.location.hash).equal('');
    expect(b.w.sessionStorage.length).equal(0);
    expect(b.requests.some(r => r.pathname.startsWith('/api/review-consent'))).equal(false);
  });
  it('rejects malformed policy previews and mismatched confirmation receipts', async function () {
    let attempts = 0;
    b = await browser({
      '/api/review-consent/preview': () => ++attempts === 1 ? { ...preview(), policy: { ...preview().policy, access: 'unsupported' } } : preview(),
      '/api/review-consent/confirm': () => ({ requestId: 'wrong', confirmedAt: new Date().toISOString() }),
    });
    await b.preview(); expect(b.document.querySelector('input[type=checkbox]')).equal(null);
    await b.preview(); await b.accept(); await b.click('button[type=button]');
    expect(b.document.body.textContent).include('confirmation was not verified');
    expect(b.document.body.textContent).not.include('Consent recorded.');
  });

  it('posts a completion only to the configured callback without placing secrets in URLs or storage', async function () {
    const completion={contract:'4open.artifacts/1',clientId:'1'.repeat(32),intentId:'2'.repeat(32),code:'9'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString()};
    const callbackUrl='https://review.example.test/api/v1/artifacts/callback';
    b=await browser({'/api/review-consent/csrf':()=>({csrf,handoffEnabled:true}),'/api/review-consent/handoff':()=>({completion,callbackUrl})});
    const submissions=[];b.w.HTMLFormElement.prototype.submit=function(){submissions.push({action:this.action,method:this.method,completion:JSON.parse(this.elements.namedItem('completion').value)});};
    await b.preview();await b.accept();await b.click('button[type=button]');
    expect(b.document.body.textContent).include('Continue to review to finish linking');
    await b.click('button[type=button]');
    expect(submissions).deep.equal([{action:callbackUrl,method:'post',completion}]);
    expect(b.w.location.href).equal('https://anonymous.example.test/review-link');
    expect(JSON.stringify(b.w.localStorage)).not.include(completion.code);expect(b.w.sessionStorage.length).equal(0);
    expect(b.document.documentElement.outerHTML).not.include(token).not.include('private-ticket');
    expect(b.requests.find(r=>r.pathname.endsWith('/handoff')).payload).deep.equal({ticket:'private-ticket'});
  });
  it('does not submit a late completion after account change', async function () {
    let resolve;
    b=await browser({'/api/review-consent/csrf':()=>({csrf,handoffEnabled:true}),'/api/review-consent/handoff':()=>new Promise(yes=>{resolve=yes;})});
    const submissions=[];b.w.HTMLFormElement.prototype.submit=function(){submissions.push(this.action);};
    await b.preview();await b.accept();await b.click('button[type=button]');await b.click('button[type=button]');
    b.app.state.user={username:'other'};await delay(5);
    resolve({completion:{contract:'4open.artifacts/1',clientId:'1'.repeat(32),intentId:'2'.repeat(32),code:'9'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString()},callbackUrl:'https://review.example.test/api/v1/artifacts/callback'});await delay(30);
    expect(submissions).length(0);expect(b.document.body.textContent).include('Your account changed');
    expect(b.document.querySelector('#review-repository').value).equal('');
  });
  it('rejects a wrong-intent completion or an unsafe callback destination', async function () {
    let wrongScope=true;
    b=await browser({'/api/review-consent/csrf':()=>({csrf,handoffEnabled:true}),'/api/review-consent/handoff':()=>({completion:{contract:'4open.artifacts/1',clientId:'1'.repeat(32),intentId:wrongScope?'f'.repeat(32):'2'.repeat(32),code:'9'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString()},callbackUrl:wrongScope?'https://review.example.test/api/v1/artifacts/callback':'javascript:alert(1)'})});
    const submissions=[];b.w.HTMLFormElement.prototype.submit=function(){submissions.push(this.action);};
    await b.preview();await b.accept();await b.click('button[type=button]');await b.click('button[type=button]');
    expect(submissions).length(0);wrongScope=false;await b.click('button[type=button]');expect(submissions).length(0);
    expect(b.document.body.textContent).include('return to review could not be prepared');
  });

});
