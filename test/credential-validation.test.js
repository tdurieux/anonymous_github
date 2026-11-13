const { expect } = require('chai');
require('ts-node/register/transpile-only');
const { CredentialValidation } = require('../src/core/credential-validation');
const { checkToken } = require('../src/core/GitHubUtils');
const { registerGitHubToken } = require('../src/core/github-token-context');
const failure = status => Object.assign(new Error('upstream'), { status });
const success = etag => ({ headers: etag ? { etag } : {} });

describe('conditional credential validation', () => {
  it('shares only overlapping checks, and revalidates subsequent calls', async () => {
    const cache = new CredentialValidation();
    let release, calls = 0;
    const request = () => { calls++; return new Promise(resolve => { release = resolve; }); };
    const checks = Array.from({ length: 20 }, () => cache.check('one', request));
    expect(calls).to.equal(1);
    release(success('"one"'));
    await Promise.all(checks);
    await cache.check('one', async etag => { expect(etag).to.equal('"one"'); calls++; throw failure(304); });
    expect(calls).to.equal(2);
  });

  it('does not reuse validation across credentials or retain failures', async () => {
    const cache = new CredentialValidation();
    await cache.check('old', async () => success('"old"'));
    await cache.check('rotated', async etag => { expect(etag).to.equal(undefined); return success('"new"'); });
    for (const status of [401, 403, 429, 500, 503, undefined]) {
      const error = failure(status);
      try { await cache.check('old', async () => { throw error; }); throw new Error('accepted'); }
      catch (caught) { expect(caught).to.equal(error); }
      await cache.check('old', async etag => { expect(etag).to.equal(undefined); return success('"old"'); });
    }
  });

  it('rejects unsolicited 304s and removes validators when absent in a new success', async () => {
    const cache = new CredentialValidation();
    const error = failure(304);
    try { await cache.check('new', async () => { throw error; }); throw new Error('accepted'); }
    catch (caught) { expect(caught).to.equal(error); }
    await cache.check('new', async () => success('"etag"'));
    await cache.check('new', async () => success());
    await cache.check('new', async etag => { expect(etag).to.equal(undefined); return success(); });
  });

  it('bounds validators and tracked in-flight requests', async () => {
    const cache = new CredentialValidation(1);
    let release;
    const first = cache.check('first', () => new Promise(resolve => { release = resolve; }));
    await cache.check('second', async () => success('"second"'));
    expect(cache.pending.size).to.equal(1);
    release(success('"first"'));
    await first;
    expect(cache.validators.size).to.equal(1);
    await cache.check('second', async etag => { expect(etag).to.equal(undefined); return success(); });
    expect(cache.pending.size).to.equal(0);
  });

  it('uses authenticated conditional requests through Octokit and detects revocation', async () => {
    const originalFetch = global.fetch;
    const requests = [];
    let status = 200;
    global.fetch = async (url, options) => {
      requests.push({ url, headers: options.headers });
      return new global.Response(status === 304 ? null : JSON.stringify(status === 200 ? { id: 1 } : { message: 'Bad credentials' }), {
        status, headers: { 'content-type': 'application/json', etag: '"user-v1"' }
      });
    };
    try {
      const token = 'test-conditional-credential';
      expect(await checkToken(token)).to.equal(true);
      status = 304;
      expect(await checkToken(token)).to.equal(true);
      expect(requests[1].headers['if-none-match']).to.equal('"user-v1"');
      expect(requests[1].headers.authorization).to.equal(`token ${token}`);
      status = 401;
      expect(await checkToken(token)).to.equal(false);
      expect(await checkToken(token)).to.equal(false);
      expect(requests).to.have.length(3);
      status = 200;
      expect(await checkToken(token + '-rotated')).to.equal(true);
      expect(requests[3].headers['if-none-match']).to.equal(undefined);
      expect(requests.every(request => request.url === 'https://api.github.com/user')).to.equal(true);
    } finally { global.fetch = originalFetch; }
  });

  it('validates installation credentials against their own endpoint', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async (url, options) => {
      expect(url).to.equal('https://api.github.com/installation/repositories');
      expect(options.headers.authorization).to.equal('token ghs_conditional-test');
      calls++;
      if (calls === 2) expect(options.headers['if-none-match']).to.equal('"installation"');
      return new global.Response(calls === 2 ? null : '{"repositories":[]}', {
        status: calls === 2 ? 304 : 200,
        headers: { 'content-type': 'application/json', etag: '"installation"' }
      });
    };
    try {
      expect(await checkToken('ghs_conditional-test')).to.equal(true);
      expect(await checkToken('ghs_conditional-test')).to.equal(true);
    } finally { global.fetch = originalFetch; }
  });

  it('keeps repository-specific managed renewal independent for every call', async () => {
    let calls = 0;
    const token = 'public-read:conditional-validation-test';
    registerGitHubToken(token, { quotaKey: 'shared', publicRepository: 'owner/repo', renew: async () => { calls++; return 'renewed'; } });
    await Promise.all([checkToken(token), checkToken(token)]);
    expect(calls).to.equal(2);
    registerGitHubToken(token, { quotaKey: 'shared', publicRepository: 'owner/repo', renew: async () => { throw failure(401); } });
    expect(await checkToken(token)).to.equal(false);
  });
});
