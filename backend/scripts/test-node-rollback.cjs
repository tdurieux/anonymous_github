'use strict';
// Run on stdin inside the rollback image, with no network or application secrets.
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const zstd = require('@mongodb-js/zstd');
(async () => {
  const original = Buffer.from('rollback native dependency check');
  assert.deepEqual(await zstd.decompress(await zstd.compress(original, 3)), original);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE smoke(value TEXT)');
    db.prepare('INSERT INTO smoke(value) VALUES (?)').run('round trip');
    assert.equal(db.prepare('SELECT value FROM smoke').get().value, 'round trip');
  } finally { db.close(); }
  console.log('PASS: rollback native Zstandard and SQLite round trips');
})().catch(error => { console.error(error); process.exitCode = 1; });
