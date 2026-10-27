'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pino = require('pino');
const { AuditLog } = require('../../src/audit/auditLog');

const logger = pino({ level: 'silent' });

test('records ordered entries and filters by run', () => {
  const audit = new AuditLog({ logger, now: () => new Date('2026-01-01T00:00:00Z') });
  audit.record('a', { runId: 'r1', x: 1 });
  audit.record('b', { runId: 'r2' });
  audit.record('c', { runId: 'r1' });
  assert.deepEqual(
    audit.list({ runId: 'r1' }).map((e) => e.event),
    ['a', 'c'],
  );
  const [first] = audit.list();
  assert.equal(first.seq, 1);
  assert.equal(first.ts, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(first.details, { x: 1 });
});

test('ring buffer is bounded', () => {
  const audit = new AuditLog({ logger, maxEntries: 3 });
  for (let i = 0; i < 5; i++) audit.record(`e${i}`);
  assert.deepEqual(
    audit.list().map((e) => e.event),
    ['e2', 'e3', 'e4'],
  );
});

test('appends JSON lines to the audit file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  const file = path.join(dir, 'nested', 'audit.jsonl');
  const audit = new AuditLog({ logger, filePath: file });
  audit.record('one', { runId: 'r' });
  audit.record('two');
  await audit.close();
  const lines = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => l.event),
    ['one', 'two'],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
