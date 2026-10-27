'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../../src/domain/environment');

test('nominal state is healthy with derived cpu', () => {
  const s = env.nominalState();
  assert.equal(s.status, env.HEALTHY_STATUS);
  assert.equal(s.cpu, 10);
  assert.ok(env.isHealthy(s));
});

test('chaos state is unhealthy, high cpu and postgres stopped', () => {
  const s = env.chaosState();
  assert.equal(s.status, env.UNHEALTHY_STATUS);
  assert.equal(s.cpu, 99);
  assert.equal(s.services.postgres, 'stopped');
  assert.ok(s.processes.some((p) => p.pid === 1337));
});

test('killProcess is pure and recomputes cpu', () => {
  const before = env.chaosState();
  const after = env.killProcess(before, 1337);
  assert.ok(
    before.processes.some((p) => p.pid === 1337),
    'input not mutated',
  );
  assert.ok(!after.processes.some((p) => p.pid === 1337));
  assert.equal(after.cpu, 8);
});

test('killing a service process marks the service as stopped', () => {
  const after = env.killProcess(env.nominalState(), 5432);
  assert.equal(after.services.postgres, 'stopped');
  assert.equal(after.status, env.UNHEALTHY_STATUS);
});

test('restartService never duplicates the service process', () => {
  const once = env.restartService(env.nominalState(), 'postgres');
  const twice = env.restartService(once, 'postgres');
  assert.equal(twice.processes.filter((p) => p.pid === 5432).length, 1);
});

test('restarting postgres after chaos restores health and clears the error log', () => {
  const s = env.restartService(env.killProcess(env.chaosState(), 1337), 'postgres');
  assert.ok(env.isHealthy(s));
  assert.equal(s.cpu, 10);
  assert.equal(s.logs['nginx_error.log'], '');
});
