'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateCommand, formatCommand, CommandRejectedError, TOOLS } = require('../../src/domain/commands');
const { chaosState, nominalState } = require('../../src/domain/environment');

const rejects = (raw, state, pattern) =>
  assert.throws(
    () => validateCommand(raw, state),
    (err) => err instanceof CommandRejectedError && pattern.test(err.message),
  );

test('accepts allowlisted commands with valid args', () => {
  const { command, definition } = validateCommand({ tool: 'kill_process', args: { pid: 1337 } }, chaosState());
  assert.deepEqual(command, { tool: 'kill_process', args: { pid: 1337 } });
  assert.equal(definition.destructive, true);
});

test('defaults args to an empty object', () => {
  const { command } = validateCommand({ tool: 'list_processes' }, chaosState());
  assert.deepEqual(command.args, {});
});

test('rejects tools outside the allowlist', () => {
  rejects({ tool: 'exec', args: { cmd: 'rm -rf /' } }, chaosState(), /not in the allowlist/);
  rejects({ tool: '__proto__', args: {} }, chaosState(), /not in the allowlist/);
  rejects({ tool: 'constructor', args: {} }, chaosState(), /not in the allowlist/);
});

test('rejects malformed commands and unexpected args', () => {
  rejects('kill_process(1337)', chaosState(), /Malformed/);
  rejects({ tool: 'kill_process', args: { pid: '1337' } }, chaosState(), /Invalid arguments/);
  rejects({ tool: 'kill_process', args: { pid: 1337, force: true } }, chaosState(), /Invalid arguments/);
  rejects({ tool: 'list_processes', args: { x: 1 } }, chaosState(), /Invalid arguments/);
  rejects({ tool: 'verify_health', args: {}, extra: 1 }, chaosState(), /Malformed/);
});

test('protects critical processes and checks existence', () => {
  rejects({ tool: 'kill_process', args: { pid: 1 } }, chaosState(), /protected/);
  rejects({ tool: 'kill_process', args: { pid: 1337 } }, nominalState(), /No process/);
  rejects({ tool: 'restart_service', args: { name: 'redis' } }, chaosState(), /Unknown service/);
  rejects({ tool: 'read_log', args: { file: '../../etc/passwd' } }, chaosState(), /Unknown log/);
  rejects({ tool: 'read_log', args: { file: 'toString' } }, chaosState(), /Unknown log/);
});

test('only kill_process and restart_service are destructive', () => {
  const destructive = Object.entries(TOOLS)
    .filter(([, t]) => t.destructive)
    .map(([n]) => n)
    .sort();
  assert.deepEqual(destructive, ['kill_process', 'restart_service']);
});

test('formatCommand renders a readable call', () => {
  assert.equal(formatCommand({ tool: 'read_log', args: { file: 'syslog' } }), 'read_log("syslog")');
  assert.equal(formatCommand({ tool: 'kill_process', args: { pid: 1337 } }), 'kill_process(1337)');
  assert.equal(formatCommand({ tool: 'verify_health', args: {} }), 'verify_health()');
});
