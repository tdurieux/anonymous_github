const { setTimeout } = require("node:timers");
const { expect } = require('chai');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
require('ts-node/register/transpile-only');
const { logRecord } = require('../src/core/log-record');
const { logContext, jobTrace } = require('../src/core/log-context');
const { loggedJob } = require('../src/queue/log-job');

describe('structured logging privacy and context', () => {
  it('keeps the production summary compatible with JSON and legacy records', () => {
    const { logSummary, observeLine } = require('../scripts/check-production-logs');
    const summary = logSummary();
    observeLine(summary, JSON.stringify(logRecord('info', 'requests', ['request', {ms: 1, status: 503, outcome: 'completed'}])));
    observeLine(summary, JSON.stringify(logRecord('error', 'process', ['process fatal error'])));
    observeLine(summary, '2026-01-01T00:00:00Z WARN [requests] request {"ms":2,"status":429,"outcome":"completed"}');
    expect(summary).to.include({completed: 2, completed5xx: 1, fatalErrors: 1, errors: 1, warnings: 1, rateLimited: 1});
  });
  it('omits arbitrary text, private identities, request bodies and nested secrets', () => {
    const secret = 'private-owner/private-repository?state=secret';
    const record = logRecord('error', 'upstream', [secret, {
      message: secret, url: secret, headers: { authorization: secret }, repoId: secret,
      requestBody: secret, status: 502, code: 'ETIMEDOUT', stages: { upstream: 42, [secret]: 1 },
    }]);
    expect(JSON.stringify(record)).not.to.include(secret);
    expect(record).to.include({ status: 502, errorCode: 'ETIMEDOUT', stage_upstream_ms: 42 });
    expect(record).to.have.keys('timestamp', 'severity', 'service', 'instance', 'release', 'event', 'message', 'module', 'status', 'errorCode', 'stage_upstream_ms');
  });
  it('keeps concurrent request contexts separate and propagates an opaque job trace', async () => {
    const ids = [randomUUID(), randomUUID()];
    const rows = await Promise.all(ids.map((requestId, i) => logContext.run({ requestId }, async () => {
      await new Promise(resolve => setTimeout(resolve, 10 - i));
      const trace = jobTrace();
      expect(trace.requestId).to.equal(requestId);
      expect(trace.logJobId).not.to.equal(requestId);
      return logRecord('info', 'fixture', ['request']);
    })));
    expect(rows.map(row => row.requestId)).to.deep.equal(ids);
    expect(logRecord('info', 'fixture', ['request'])).not.to.have.property('requestId');
  });
  it('sets sandbox job context and preserves success/failure semantics', async () => {
    const requestId = randomUUID(), jobId = randomUUID();
    const processor = loggedJob('download', async () => {
      expect(logContext.getStore()).to.deep.equal({ service: 'worker', requestId, jobId, attempt: 3 });
      throw new Error('fixture failure');
    });
    try { await processor({ data: { repoId: 'private-id', requestId, logJobId: jobId }, attemptsMade: 2 }); }
    catch (error) { expect(error.message).to.equal('fixture failure'); return; }
    throw new Error('job failure was swallowed');
  });
  it('rejects injected correlation IDs and non-finite measurements', () => {
    const row = logRecord('warn', 'fixture', ['request', { requestId: 'bad\nsecret', jobId: 'private', ms: Infinity, status: NaN }]);
    expect(row).not.to.have.any.keys('requestId', 'jobId', 'ms', 'status');
  });
  it('survives a reader closing stdout', async function () {
    this.timeout(10000);
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', `
      const { createLogger, getDroppedOutput } = require('./src/core/logger');
      const logger = createLogger('process');
      process.on('message', () => {
        logger.info('process heartbeat');
        setTimeout(() => { logger.info('process heartbeat'); process.send(getDroppedOutput()); process.disconnect(); }, 50);
      });
      process.send('ready');
    `], { env: { ...process.env, LOG_REDIS_MIRROR: 'off' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let drops, fallback = "";
    child.stderr.on("data", chunk => { fallback += chunk; });
    child.on('message', message => {
      if (message === 'ready') { child.stdout.destroy(); child.send('write'); }
      else drops = message;
    });
    const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    expect(code).to.equal(0);
    expect(drops).to.be.greaterThan(0);
    expect(fallback).to.include('"event":"process_heartbeat"');
  });
  it('preserves admin error codes and expected-error ring suppression', () => {
    const child = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', `
      const redis = require('redis');
      let pushes = 0; const fields = [];
      const tx = {lPush() {pushes++; return tx;}, lTrim() {return tx;},
        hIncrBy(key, field) { fields.push(field); return tx; }, expire() {return tx;}, exec() {return Promise.resolve([]);} };
      redis.createClient = () => ({isReady:true, isOpen:true, on() {}, connect() {return Promise.resolve();}, multi() {return tx;}});
      require('./src/core/logger').createLogger('route').warn('repository_not_ready', {message:'repository_not_ready', httpStatus:409});
      if (pushes !== 0 || !fields.includes('cb:warn:repository_not_ready')) process.exitCode = 1;
    `], {env: {...process.env, LOG_REDIS_MIRROR: 'on'}, encoding: 'utf8', timeout: 10000});
    expect(child.status, child.stderr).to.equal(0);
  });
  it('writes JSON without Redis and bounds a blocked stdout pipe', () => {
    const child = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', `
      const { createLogger, getDroppedOutput } = require('./src/core/logger');
      const logger = createLogger('fixture');
      logger.info('request', {status: 200, requestBody: 'secret-fixture'});
      Object.defineProperty(process.stdout, 'writableLength', {value: 300000});
      for (let i = 0; i < 10000; i++) logger.warn('request', {status: 429});
      if (getDroppedOutput() !== 10000) process.exitCode = 1;
    `], { cwd: process.cwd(), env: { ...process.env, LOG_REDIS_MIRROR: 'off' }, encoding: 'utf8', timeout: 10000 });
    expect(child.status, child.stderr).to.equal(0);
    const lines = child.stdout.trim().split('\n');
    expect(lines).to.have.length(1);
    expect(JSON.parse(lines[0])).to.include({ event: 'request_completed', status: 200 });
    expect(child.stdout).not.to.include('secret-fixture');
  });
});
