const {Readable} = require('node:stream');
const assert = require('node:assert/strict');
process.env.SESSION_SECRET = 'synthetic-blob-index';
require('ts-node/register/transpile-only');
const config = require('../../src/config').default;
config.CACHE_MONITORING_ENABLED = false;
const {BlobCache} = require('../../src/core/blob-cache');
(async () => {
  const [mode, root] = process.argv.slice(2);
  assert.ok(['seed', 'seed-legacy', 'seed-readers', 'seed-maintenance', 'maintain', 'crash-publisher', 'refill', 'evict', 'inspect', 'mutate', 'read-go', 'wait-go'].includes(mode));
  const cache = new BlobCache({root, budget: 65536, maxObject: 4096, gzip: true});
  try {
    if (mode.startsWith('seed')) {
      const stream = await cache.getOrFill('node-alias', async () => Readable.from('shared payload\n'.repeat(150)));
      for await (const _chunk of stream) {}
      await new Promise(resolve => setImmediate(resolve));
      cache.saveDecision('node-decision', 'source-digest', false);
      cache.db.prepare('INSERT INTO fills VALUES(?,?,?,?)').run('pending-key', 'pending-token', Date.now()+3600000, 13312);
      cache.db.prepare('INSERT INTO readers VALUES(?,?,?)').run('reader-token', stream.cachedBlob.record.digest, Date.now()+3600000);
      cache.db.prepare('INSERT INTO publications VALUES(?,?,?)').run('pending-token', stream.cachedBlob.record.digest, 'pending.raw');
    }
    if (mode === 'seed-readers' || mode === 'seed-maintenance') {
      cache.db.exec('DELETE FROM readers; DELETE FROM fills; DELETE FROM publications;');
      const identity = await cache.getOrFill('node-identity', async () => Readable.from('identity payload'), async proof => `git-${proof.gitSha}`);
      for await (const _chunk of identity) {}
      await new Promise(resolve => setImmediate(resolve));
    }
    if (mode === 'seed-maintenance') {
      const third = await cache.getOrFill('node-third', async () => Readable.from('third payload'));
      for await (const _chunk of third) {}
      await new Promise(resolve => setImmediate(resolve));
      cache.db.exec(`UPDATE blobs SET accessed=CASE
        WHEN digest=(SELECT digest FROM aliases WHERE key='node-alias') THEN 1
        WHEN digest=(SELECT digest FROM aliases WHERE key='node-identity') THEN 2 ELSE 3 END`);
    }
    if (mode === 'crash-publisher') {
      const {fork} = require('node:child_process');
      const path = require('node:path');
      const worker = fork(path.join(__dirname, '../../test/fixtures/shared-cache-worker.js'), [], {
        env: {...process.env, NODE_ENV: 'test', BLOB_TEST_OPTIONS: JSON.stringify(cache.options), BLOB_TEST_CRASH_AFTER_RENAME: '1'},
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      });
      let timeout;
      try {
        await new Promise((resolve, reject) => {
          let stderr = '';
          timeout = setTimeout(() => reject(Error('publisher timeout')), 15000);
          worker.stderr.on('data', chunk => { stderr=(stderr+chunk).slice(-4000); });
          worker.on('error', reject);
          worker.on('exit', code => reject(Error('publisher exited '+code+': '+stderr)));
          worker.on('message', message => {
            if (message === 'ready') worker.send('start');
            if (message.renamed) resolve();
            if (message.error) reject(Error(message.error));
          });
        });
        const exited = new Promise(resolve => worker.once('exit', resolve));
        worker.kill('SIGKILL'); await exited;
        assert.ok(cache.stats().reservedBytes > 0);
        assert.equal(cache.stats().blobs, 0);
        assert.equal(cache.db.prepare('SELECT COUNT(*) n FROM publications').get().n, 1);
        cache.db.exec('UPDATE fills SET expires=1');
      } finally { clearTimeout(timeout); worker.kill(); }
    }
    if (mode === 'refill') {
      const stream = await cache.getOrFill('multiprocess', async () => Readable.from('recovered'));
      let body = ''; for await (const chunk of stream) body += chunk;
      assert.equal(body, 'recovered');
      await new Promise(resolve => setImmediate(resolve));
    }
    if (mode === 'wait-go') {
      const metric = cache.metric.bind(cache);
      let signalled = false;
      cache.metric = (event, ...args) => {
        metric(event, ...args);
        if (event === 'fill_wait' && !signalled) {
          signalled = true; process.stdout.write('waiting\n');
        }
      };
      const stream = await cache.getOrFill('shared-process-key', async () => { throw Error('duplicate Node producer'); });
      let body = ''; for await (const chunk of stream) body += chunk;
      assert.equal(body, 'one cross-process producer');
      assert.ok(signalled, 'Node never waited for the Go fill');
      await new Promise(resolve => setImmediate(resolve));
    }
    if (mode === 'read-go') {
      for (const [key, expected, encoding] of [
        ['go-identity', 'identity from Go', 'identity'],
        ['go-gzip', 'Go gzip payload\n'.repeat(150), 'gzip']
      ]) {
        const stream = await cache.getOrFill(key, async () => { throw Error('unexpected Node producer'); });
        assert.equal(stream.cachedBlob.record.encoding, encoding);
        let body = ''; for await (const chunk of stream) body += chunk;
        assert.equal(body, expected);
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(cache.stats().activeReaders, 0);
      assert.equal(cache.stats().reservedBytes, 0);
    }
    if (mode === 'maintain') { cache.options.budget=4096; await cache.maintain(); }
    if (mode === 'evict') { cache.options.budget = 1; await cache.maintain(); }
    if (mode === 'mutate') cache.saveDecision('go-decision', 'node-replaced', false);
    const summary = cache.db.prepare('SELECT * FROM summary WHERE id=1').get();
    const expected = cache.db.prepare(`SELECT COUNT(*) blobs,COALESCE(SUM(size),0) originalBytes,COALESCE(SUM(stored),0) storedBytes,
      COALESCE(SUM(allocated),0) allocatedBytes,(SELECT COUNT(*) FROM readers) activeReaders,(SELECT COUNT(*) FROM decisions) decisions,
      (SELECT COUNT(*) FROM aliases) aliases,(SELECT COUNT(*) FROM history) history,(SELECT COALESCE(SUM(reserved),0) FROM fills) reservedBytes FROM blobs`).get();
    for (const [key, value] of Object.entries(expected)) assert.equal(summary[key], value, key);
    const result = {stats: cache.stats(), decision: cache.decision('go-decision') || null};
    if (mode === 'seed-legacy') {
      for (const {name} of cache.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'summary_%'").all()) cache.db.exec(`DROP TRIGGER ${name}`);
      cache.db.exec('DROP TABLE summary; DROP TRIGGER blob_added; DROP TRIGGER blob_removed; DROP TABLE totals;');
    }
    console.log(JSON.stringify(result));
  } finally { cache.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
