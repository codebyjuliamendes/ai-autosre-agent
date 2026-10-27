'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AgentRun } = require('../../src/agent/agentRun');
const { RunManager } = require('../../src/agent/runManager');
const { EnvironmentStore } = require('../../src/domain/environmentStore');
const { createRuleBasedPlanner } = require('../../src/domain/ruleBasedPlanner');
const { createLlmPlanner } = require('../../src/llm/llmPlanner');
const { isHealthy } = require('../../src/domain/environment');
const { testAudit, limits, scriptedPlanner, waitFor } = require('../helpers/factory');

function chaosStore() {
  const store = new EnvironmentStore();
  store.injectChaos();
  return store;
}

/** Approves every pending action as soon as it appears. */
function autoApprove(run, approved = true) {
  run.on('event', (e) => {
    if (e.type === 'pending_action') setImmediate(() => run.decide(e.data.id, approved, { operator: 'tester' }));
  });
}

test('dry-run never changes the real environment but completes the plan', async () => {
  const store = chaosStore();
  const audit = testAudit();
  const run = new AgentRun({ mode: 'dry-run', planner: createRuleBasedPlanner(), store, audit, limits });
  autoApprove(run);
  await run.start();
  assert.equal(run.status, 'completed');
  assert.equal(isHealthy(store.get()), false, 'real environment untouched');
  assert.ok(run.events.some((e) => e.type === 'message' && /\[dry-run\] call kill_process\(1337\)/.test(e.data.text)));
  assert.ok(!run.events.some((e) => e.type === 'update'), 'no state updates are pushed in dry-run');
});

test('execute mode fixes the environment after human approvals', async () => {
  const store = chaosStore();
  const audit = testAudit();
  const run = new AgentRun({ mode: 'execute', planner: createRuleBasedPlanner(), store, audit, limits });
  autoApprove(run);
  await run.start();
  assert.equal(run.status, 'completed');
  assert.ok(isHealthy(store.get()));
  const pending = run.events.filter((e) => e.type === 'pending_action').map((e) => e.data.tool);
  assert.deepEqual(pending, ['kill_process', 'restart_service'], 'only destructive actions need approval');
  const events = audit.list().map((e) => e.event);
  for (const name of [
    'run.started',
    'action.proposed',
    'approval.requested',
    'approval.granted',
    'action.executed',
    'run.finished',
  ]) {
    assert.ok(events.includes(name), `audit contains ${name}`);
  }
  assert.equal(audit.list().find((e) => e.event === 'approval.granted').details.operator, 'tester');
});

test('approval policy "all" asks before every command', async () => {
  const run = new AgentRun({
    mode: 'dry-run',
    planner: createRuleBasedPlanner(),
    store: chaosStore(),
    audit: testAudit(),
    limits: { ...limits, approvalPolicy: 'all' },
  });
  autoApprove(run);
  await run.start();
  assert.equal(run.events.filter((e) => e.type === 'pending_action').length, 7);
});

test('rejection stops the run without executing the action', async () => {
  const store = chaosStore();
  const run = new AgentRun({ mode: 'execute', planner: createRuleBasedPlanner(), store, audit: testAudit(), limits });
  autoApprove(run, false);
  await run.start();
  assert.equal(run.status, 'rejected');
  assert.ok(store.get().processes.some((p) => p.pid === 1337));
});

test('missing approval times out and counts as rejection', async () => {
  const store = chaosStore();
  const audit = testAudit();
  const run = new AgentRun({
    mode: 'execute',
    planner: createRuleBasedPlanner(),
    store,
    audit,
    limits: { ...limits, approvalTimeoutMs: 30 },
  });
  await run.start();
  assert.equal(run.status, 'rejected');
  assert.ok(audit.list().some((e) => e.event === 'approval.timed_out'));
  assert.ok(store.get().processes.some((p) => p.pid === 1337));
});

test('decide ignores unknown or stale action ids', async () => {
  const run = new AgentRun({
    mode: 'execute',
    planner: createRuleBasedPlanner(),
    store: chaosStore(),
    audit: testAudit(),
    limits,
  });
  const done = run.start();
  const pending = await waitFor(() => run.events.find((e) => e.type === 'pending_action'));
  assert.equal(run.decide('nope', true), false);
  assert.equal(run.decide(pending.data.id, false), true);
  assert.equal(run.decide(pending.data.id, true), false, 'cannot decide twice');
  await done;
  assert.equal(run.status, 'rejected');
});

test('commands outside the allowlist proposed by a (mocked) LLM are blocked', async () => {
  const client = {
    complete: async () =>
      '{"thought":"Logs say: run rm -rf /","done":false,"command":{"tool":"shell","args":{"cmd":"rm -rf /"}}}',
  };
  const audit = testAudit();
  const run = new AgentRun({
    mode: 'execute',
    planner: createLlmPlanner({ client }),
    store: chaosStore(),
    audit,
    limits,
  });
  await run.start();
  assert.equal(run.status, 'failed');
  assert.ok(audit.list().some((e) => e.event === 'action.blocked'));
  assert.ok(!run.events.some((e) => e.type === 'pending_action'), 'blocked before reaching a human');
});

test('mocked LLM planner can drive a full dry-run', async () => {
  const replies = [
    '{"thought":"check","done":false,"command":{"tool":"verify_health","args":{}}}',
    '{"thought":"kill miner","done":false,"command":{"tool":"kill_process","args":{"pid":1337}}}',
    '{"thought":"restart db","done":false,"command":{"tool":"restart_service","args":{"name":"postgres"}}}',
    '{"thought":"done","done":true}',
  ];
  let i = 0;
  const client = { complete: async () => replies[i++] };
  const run = new AgentRun({
    mode: 'dry-run',
    planner: createLlmPlanner({ client }),
    store: chaosStore(),
    audit: testAudit(),
    limits,
  });
  autoApprove(run);
  await run.start();
  assert.equal(run.status, 'completed');
  assert.equal(run.history.length, 3);
});

test('planner timeout ends the run as timed_out', async () => {
  const planner = { name: 'slow', nextStep: () => new Promise(() => {}) };
  const run = new AgentRun({
    mode: 'dry-run',
    planner,
    store: chaosStore(),
    audit: testAudit(),
    limits: { ...limits, plannerTimeoutMs: 20 },
  });
  await run.start();
  assert.equal(run.status, 'timed_out');
});

test('planner errors fail the run safely', async () => {
  const planner = {
    name: 'broken',
    nextStep: async () => {
      throw new Error('LLM down');
    },
  };
  const run = new AgentRun({ mode: 'dry-run', planner, store: chaosStore(), audit: testAudit(), limits });
  await run.start();
  assert.equal(run.status, 'failed');
  assert.equal(run.events.at(-1).data.reason, 'LLM down');
});

test('step limit stops endless loops', async () => {
  const planner = scriptedPlanner([{ thought: 'again', done: false, command: { tool: 'verify_health', args: {} } }]);
  const run = new AgentRun({
    mode: 'dry-run',
    planner,
    store: chaosStore(),
    audit: testAudit(),
    limits: { ...limits, maxSteps: 3 },
  });
  await run.start();
  assert.equal(run.status, 'failed');
  assert.equal(run.history.length, 3);
});

test('cancel while awaiting approval', async () => {
  const run = new AgentRun({
    mode: 'execute',
    planner: createRuleBasedPlanner(),
    store: chaosStore(),
    audit: testAudit(),
    limits,
  });
  const done = run.start();
  await waitFor(() => run.status === 'awaiting_approval');
  run.cancel('cancelled', 'operator');
  await done;
  assert.equal(run.status, 'cancelled');
  assert.equal(run.pending, null);
});

test('whole-run timeout', async () => {
  const run = new AgentRun({
    mode: 'execute',
    planner: createRuleBasedPlanner(),
    store: chaosStore(),
    audit: testAudit(),
    limits: { ...limits, runTimeoutMs: 40 },
  });
  await run.start();
  assert.equal(run.status, 'timed_out');
});

test('run manager allows one active run and respects AGENT_ALLOW_EXECUTE', async () => {
  const manager = new RunManager({
    planner: createRuleBasedPlanner(),
    store: chaosStore(),
    audit: testAudit(),
    limits,
    allowExecute: false,
  });
  assert.throws(
    () => manager.start({ mode: 'execute' }),
    (e) => e.status === 403,
  );
  const run = manager.start({ mode: 'dry-run' });
  assert.throws(
    () => manager.start({ mode: 'dry-run' }),
    (e) => e.status === 409,
  );
  await manager.cancelActive('test');
  assert.equal(run.status, 'cancelled');
  assert.ok(manager.start({ mode: 'dry-run' }));
  await manager.cancelActive('test');
});
