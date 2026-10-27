'use strict';

const pino = require('pino');
const { loadConfig } = require('../../src/config');
const { buildContainer } = require('../../src/main');
const { AuditLog } = require('../../src/audit/auditLog');

const silentLogger = pino({ level: 'silent' });

/** @param {Record<string, string>} [overrides] */
function testConfig(overrides = {}) {
  return loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', AGENT_STEP_DELAY_MS: '0', ...overrides });
}

/** @param {{ env?: Record<string, string>, planner?: any }} [options] */
function buildTestApp({ env, planner } = {}) {
  return buildContainer({ config: testConfig(env), logger: silentLogger, planner });
}

function testAudit() {
  return new AuditLog({ logger: silentLogger });
}

const limits = {
  maxSteps: 12,
  stepDelayMs: 0,
  plannerTimeoutMs: 1000,
  commandTimeoutMs: 1000,
  approvalTimeoutMs: 1000,
  runTimeoutMs: 5000,
  approvalPolicy: /** @type {'destructive'} */ ('destructive'),
};

/** Planner that replays a fixed list of steps (stands in for a mocked LLM). */
function scriptedPlanner(steps, name = 'scripted') {
  let i = 0;
  return {
    name,
    async nextStep() {
      const step = steps[Math.min(i, steps.length - 1)];
      i++;
      return typeof step === 'function' ? step() : step;
    },
  };
}

/** Waits until `predicate()` is truthy. */
async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

module.exports = { silentLogger, testConfig, buildTestApp, testAudit, limits, scriptedPlanner, waitFor };
