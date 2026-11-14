const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
process.env.SESSION_SECRET ||= 'synthetic-blob-index';
require('ts-node/register/transpile-only');
const config = require('../../src/config').default;
config.CACHE_MONITORING_ENABLED = false;
const {BlobCache} = require('../../src/core/blob-cache');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'go-blob-schema-'));
let cache;
try {
  cache = new BlobCache({root, budget: 65536, maxObject: 4096});
  const rows = cache.db.prepare(`SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name`).all();
  assert.ok(rows.some(row => row.name === 'summary'));
  const sql = '-- Generated from src/core/blob-cache.ts by backend/contracts/blob-index.cjs.\n' + rows.map(row =>
    row.sql.replace(/^CREATE (TABLE|INDEX|TRIGGER) (?!IF NOT EXISTS)/, 'CREATE $1 IF NOT EXISTS ') + ';').join('\n') + '\n';
  const target = 'backend/internal/blobcache/schema.sql';
  if (process.argv.includes('--check')) assert.equal(fs.readFileSync(target, 'utf8'), sql, 'TypeScript cache schema changed');
  else fs.writeFileSync(target, sql);
  console.log(`${rows.length} TypeScript cache schema objects verified`);
} finally { cache?.close(); fs.rmSync(root, {recursive: true, force: true}); }
