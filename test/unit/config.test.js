'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../../src/config');

test('safe defaults', () => {
  const c = loadConfig({});
  assert.equal(c.port, 4002);
  assert.equal(c.agent.defaultMode, 'dry-run');
  assert.equal(c.agent.limits.approvalPolicy, 'destructive');
  assert.equal(c.llm.provider, 'none');
  assert.equal(c.operatorToken, undefined);
  assert.deepEqual(c.corsOrigins, []);
});

test('empty strings count as unset', () => {
  assert.equal(loadConfig({ OPERATOR_TOKEN: '', PORT: '' }).port, 4002);
});

test('rejects invalid values with a clear message', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ AGENT_DEFAULT_MODE: 'yolo' }), /AGENT_DEFAULT_MODE/);
  assert.throws(() => loadConfig({ OPERATOR_TOKEN: 'short' }), /OPERATOR_TOKEN/);
  assert.throws(() => loadConfig({ AGENT_ALLOW_EXECUTE: 'maybe' }), /AGENT_ALLOW_EXECUTE/);
});

test('parses lists, booleans and trust proxy', () => {
  const c = loadConfig({
    CORS_ORIGINS: 'https://a.com, https://b.com',
    AGENT_ALLOW_EXECUTE: 'false',
    TRUST_PROXY: '1',
  });
  assert.deepEqual(c.corsOrigins, ['https://a.com', 'https://b.com']);
  assert.equal(c.agent.allowExecute, false);
  assert.equal(c.trustProxy, 1);
});
