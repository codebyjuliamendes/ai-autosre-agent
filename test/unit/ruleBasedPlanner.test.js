'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../../src/domain/ruleBasedPlanner');
const { validateCommand } = require('../../src/domain/commands');
const env = require('../../src/domain/environment');

/** Runs the planner against a state until it reports done, auto-approving everything. */
function simulate(initial, maxSteps = 20) {
  let state = initial;
  const history = [];
  for (let i = 0; i < maxSteps; i++) {
    const step = decide(history);
    if (step.done) return { state, history, final: step };
    const { command, definition } = validateCommand(step.command, state);
    const result = definition.run(state, command.args);
    state = result.state;
    history.push({ command, output: result.output });
  }
  throw new Error('planner did not finish');
}

test('resolves the chaos scenario end to end', () => {
  const { state, history, final } = simulate(env.chaosState());
  assert.ok(env.isHealthy(state));
  assert.match(final.thought, /resolved/i);
  assert.deepEqual(
    history.map((h) => h.command.tool),
    [
      'verify_health',
      'read_log',
      'list_processes',
      'kill_process',
      'list_services',
      'restart_service',
      'verify_health',
    ],
  );
});

test('does nothing destructive when the system is already healthy', () => {
  const { history, final } = simulate(env.nominalState());
  assert.deepEqual(
    history.map((h) => h.command.tool),
    ['verify_health'],
  );
  assert.match(final.thought, /no incident/i);
});

test('escalates when health keeps failing after remediation', () => {
  const history = [
    { command: { tool: 'verify_health', args: {} }, output: 'HTTP 500 - System failure.' },
    { command: { tool: 'read_log', args: { file: 'nginx_error.log' } }, output: 'x' },
    { command: { tool: 'list_processes', args: {} }, output: '[]' },
    { command: { tool: 'list_services', args: {} }, output: '{"nginx":"running"}' },
    { command: { tool: 'verify_health', args: {} }, output: 'HTTP 500 - System failure.' },
  ];
  const step = decide(history);
  assert.equal(step.done, true);
  assert.match(step.thought, /Escalating/);
});

test('tolerates garbage observations', () => {
  const history = [
    { command: { tool: 'verify_health', args: {} }, output: 'HTTP 500' },
    { command: { tool: 'read_log', args: { file: 'nginx_error.log' } }, output: 'x' },
    { command: { tool: 'list_processes', args: {} }, output: 'not json' },
  ];
  assert.equal(decide(history).command?.tool, 'list_services');
});
