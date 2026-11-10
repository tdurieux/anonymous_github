const { strict: assert } = require('node:assert');
const { promises: fs } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const express = require('express');
require('ts-node/register/transpile-only');
const config = require('../src/config').default;
const { sharedBlobCache, closeBlobCaches } = require('../src/core/blob-cache');
const { probeStreamerCache } = require('../src/core/streamer-cache-probe');
const GitHubStream = require('../src/core/source/GitHubStream').default;
const streamer = require('../src/streamer/route').default;
const localAccess = require('../src/core/cached-repository-access');
const File = require('../src/core/AnonymizedFile').default;
const { AnonymizeTransformer } = require('../src/core/anonymize-utils');
const got = require('got');
const body = Buffer.from('Public README with Alice\n');
const sha = createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
const consume = async stream => { let text = ''; for await (const chunk of stream) text += chunk; return text; };

describe('cached file streamer probe', function () {
  this.timeout(10000);
  let root, old, server, url;
  beforeEach(async () => {
    old = { ...config }; closeBlobCaches();
    root = await fs.mkdtemp(join(tmpdir(), 'cached-probe-'));
    Object.assign(config, { STORAGE: 'filesystem', FOLDER: root, SHARED_CACHE_ENABLED: true,
      SHARED_CACHE_PATH: join(root, 'cache'), SHARED_CACHE_BYTES: 16 * 1024 ** 2,
      SHARED_CACHE_RESULT_BYTES: 8 * 1024 ** 2, SHARED_CACHE_MAX_FILE_BYTES: 1024 ** 2,
      SHARED_CACHE_FREE_BYTES: 0, BILLING_ENABLED: false });
    const app = express(); app.use(express.json()); app.use('/api', streamer);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    url = `http://127.0.0.1:${server.address().port}/api`;
  });
  afterEach(async () => {
    await new Promise(resolve => server.close(resolve)); closeBlobCaches(); Object.assign(config, old);
    await fs.rm(root, { recursive: true, force: true });
  });
  const payload = () => ({ repoFullName: 'owner/private', repoId: 'anon', sha, size: body.length,
    filePath: 'README.md', anonymizerOptions: { terms: ['Alice'], filePath: 'README.md' } });
  async function seed() {
    const stream = await sharedBlobCache().getOrFill(`git-${sha}`, async () => Readable.from(body), async () => `git-${sha}`, body.length);
    await consume(stream);
  }
  it('returns a cache miss without credentials, downloads, or GitHub calls', async () => {
    const source = new GitHubStream({ getToken: () => { throw new Error('credential access'); } });
    source.downloadWithFallback = () => { throw new Error('upstream access'); };
    await assert.rejects(source.getFileContentCache('README.md', 'anon', () => ({ sha, size: body.length }), true), /cache_miss/);
    assert.equal(await probeStreamerCache(url, payload(), {}), undefined);
  });
  it('serves a hit through the real streamer and anonymizes it without GitHub', async () => {
    await seed();
    const fetch = global.fetch;
    global.fetch = () => { throw new Error('unexpected GitHub call'); };
    try {
      const result = await probeStreamerCache(url, payload(), {});
      assert.equal(result.response.statusCode, 200);
      const text = await consume(result.stream);
      assert.ok(text.includes('Public README'));
      assert.ok(!text.includes('Alice'));
    } finally { global.fetch = fetch; }
  });
  it('falls back to normal admission for larger billed LFS payloads', async () => {
    await seed(); config.BILLING_ENABLED = true;
    assert.equal(await probeStreamerCache(url, { ...payload(), size: 1 }, {}), undefined);
  });
  it('does not disguise validation failures as cache misses', async () => {
    await assert.rejects(probeStreamerCache(url, { ...payload(), filePath: '../secret' }, {}), error => error.response.statusCode === 400);
  });
  it('rejects a generation change even when the blob is cached', async () => {
    await seed();
    const db = require('../src/server/database');
    const Model = require('../src/core/model/anonymizedRepositories/anonymizedRepositories.model').default;
    const connected = db.isConnected, find = Model.findOne;
    db.isConnected = true;
    Model.findOne = () => ({ select: () => ({ lean: () => ({ exec: async () => ({ status: 'ready', treeGeneration: 'new' }) }) }) });
    try {
      const source = new GitHubStream({ cacheGeneration: 'old:', getToken: () => { throw new Error('GitHub called'); } });
      await assert.rejects(source.getFileContentCache('README.md', 'anon', () => ({ sha, size: body.length }), true), /repository_changed/);
    } finally { db.isConnected = connected; Model.findOne = find; }
  });
  it('cancels a pending probe when the browser disconnects', async () => {
    const app = express();
    let closed;
    const disconnected = new Promise(resolve => { closed = resolve; });
    app.post('/', (_req, res) => { res.once('close', closed); });
    const pending = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const cancel = new AbortController();
    try {
      const result = probeStreamerCache(`http://127.0.0.1:${pending.address().port}`, payload(), {}, cancel.signal);
      global.setTimeout(() => cancel.abort(), 50);
      await assert.rejects(result, /response_cancelled/);
      await disconnected;
    } finally { await new Promise(resolve => pending.close(resolve)); }
  });
  for (const hit of [true, false]) it(`API send ${hit ? 'hit skips' : 'miss performs'} GitHub authorization`, async () => {
    if (hit) await seed();
    config.STREAMER_ENTRYPOINT = url.replace(/api$/, '');
    const check = localAccess.canReadCachedRepository;
    localAccess.canReadCachedRepository = async () => true;
    let tokenCalls = 0;
    const app = express();
    app.get('/', async (_req, res) => {
      const file = new File({ repository: {
        repoId: 'anon', options: { terms: ['Alice'] }, model: { source: { repositoryName: 'owner/private' } },
        getToken: async () => { tokenCalls++; throw new Error('GitHub unavailable'); },
        generateAnonymizeTransformer: filePath => new AnonymizeTransformer({ terms: ['Alice'], filePath }),
      }, anonymizedPath: 'README.md' });
      file._file = { name: 'README.md', path: '', sha, size: body.length };
      try { await file.send(res); } catch (error) { res.status(503).send(error.message); }
    });
    const api = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const response = await got(`http://127.0.0.1:${api.address().port}`, { throwHttpErrors: false, retry: 0 });
      assert.equal(response.statusCode, hit ? 200 : 503);
      assert.equal(tokenCalls, hit ? 0 : 1);
      if (hit) assert.ok(!response.body.includes('Alice'));
    } finally { localAccess.canReadCachedRepository = check; await new Promise(resolve => api.close(resolve)); }
  });
});

describe('local cached snapshot access', () => {
  const db = require('../src/server/database');
  const RepositoryModel = require('../src/core/model/anonymizedRepositories/anonymizedRepositories.model').default;
  const UserModel = require('../src/core/model/users/users.model').default;
  const CredentialModel = require('../src/core/model/credentials/credentials.model').default;
  let restores, current, user, grant, repository;
  const stub = (object, key, value) => { const old = object[key]; restores.push(() => { object[key] = old; }); object[key] = value; };
  beforeEach(() => {
    restores = [];
    current = { owner: 'owner', githubAccess: { kind: 'oauth', revision: 'r1' } };
    user = { status: 'active' }; grant = { revoked: false };
    repository = { model: { _id: 'repo', githubAccess: { ...current.githubAccess } }, owner: { id: 'owner' }, check: async () => {} };
    stub(db, 'isConnected', true);
    stub(RepositoryModel, 'findById', () => ({ select: () => ({ lean: async () => current }) }));
    stub(UserModel, 'findById', () => ({ select: () => ({ lean: async () => user }) }));
    stub(CredentialModel, 'findOne', () => ({ select: () => ({ lean: async () => grant }) }));
  });
  afterEach(() => { for (const restore of restores.reverse()) restore(); });
  it('allows OAuth snapshots without reading or refreshing a token', async () => {
    assert.equal(await localAccess.canReadCachedRepository(repository), true);
  });
  for (const change of ['owner', 'revision', 'deleted', 'banned', 'removed', 'revoked', 'expired']) {
    it(`rejects ${change} before using cached bytes`, async () => {
      if (change === 'owner') current.owner = 'other';
      if (change === 'revision') current.githubAccess.revision = 'new';
      if (change === 'deleted') current = null;
      if (change === 'banned' || change === 'removed') user.status = change;
      if (change === 'revoked') grant.revoked = true;
      if (change === 'expired') repository.check = async () => { throw new Error('repository_expired'); };
      await assert.rejects(localAccess.canReadCachedRepository(repository));
    });
  }
  it('retains remote authorization for App membership and visibility checks', async () => {
    stub(config, 'GITHUB_APP_ENABLED', true);
    current.githubAccess.kind = repository.model.githubAccess.kind = 'github-app';
    assert.equal(await localAccess.canReadCachedRepository(repository), false);
    grant.revoked = true;
    await assert.rejects(localAccess.canReadCachedRepository(repository), /not_authorized/);
  });
});
