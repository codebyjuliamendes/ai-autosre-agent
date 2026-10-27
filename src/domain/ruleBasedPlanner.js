'use strict';

/**
 * Deterministic, explainable planner used by default (no LLM needed).
 *
 * It only reasons over the observations it has collected (like an LLM agent
 * would): it never peeks at the environment state directly.
 */

/**
 * @typedef {import('./commands').Command} Command
 * @typedef {Object} Observation
 * @property {Command} command
 * @property {string} output
 *
 * @typedef {Object} PlannerStep
 * @property {string} thought
 * @property {boolean} done
 * @property {Command} [command]
 *
 * @typedef {Object} PlannerInput
 * @property {Observation[]} history
 * @property {AbortSignal} [signal]
 *
 * @typedef {Object} Planner
 * @property {string} name
 * @property {(input: PlannerInput) => Promise<PlannerStep>} nextStep
 */

const SUSPICIOUS_PROCESS = /(miner|xmrig|crypto)/i;

/**
 * @param {Observation[]} history
 * @param {string} tool
 */
function lastOf(history, tool) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].command.tool === tool) return history[i];
  }
  return undefined;
}

/**
 * @param {string} text
 * @returns {any}
 */
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * @param {Observation[]} history
 * @returns {PlannerStep}
 */
function decide(history) {
  const health = lastOf(history, 'verify_health');
  const healthy = health ? health.output.startsWith('HTTP 200') : undefined;

  if (!health) {
    return {
      thought: 'First, I should check whether the service is healthy.',
      done: false,
      command: cmd('verify_health'),
    };
  }
  if (healthy && history.length === 1) {
    return { thought: 'The service is healthy. There is no incident to resolve.', done: true };
  }

  if (!lastOf(history, 'read_log')) {
    return {
      thought: 'The server is returning errors. I should check the nginx error log.',
      done: false,
      command: cmd('read_log', { file: 'nginx_error.log' }),
    };
  }

  const killed = new Set(history.filter((o) => o.command.tool === 'kill_process').map((o) => o.command.args.pid));
  const procs = lastOf(history, 'list_processes');
  if (!procs) {
    return { thought: 'I should inspect the running processes.', done: false, command: cmd('list_processes') };
  }
  /** @type {Array<{pid: number, name: string}>} */
  const processes = Array.isArray(safeJson(procs.output)) ? safeJson(procs.output) : [];
  const rogue = processes.find((p) => SUSPICIOUS_PROCESS.test(p.name) && !killed.has(p.pid));
  if (rogue) {
    return {
      thought: `A rogue process "${rogue.name}" (PID ${rogue.pid}) is consuming resources. It should be killed.`,
      done: false,
      command: cmd('kill_process', { pid: rogue.pid }),
    };
  }

  const restarted = new Set(
    history.filter((o) => o.command.tool === 'restart_service').map((o) => o.command.args.name),
  );
  const servicesObs = lastOf(history, 'list_services');
  if (!servicesObs) {
    return { thought: 'I should check which services are down.', done: false, command: cmd('list_services') };
  }
  const services = safeJson(servicesObs.output) || {};
  const stopped = Object.keys(services).find((name) => services[name] !== 'running' && !restarted.has(name));
  if (stopped) {
    return {
      thought: `The "${stopped}" service is stopped. I need to restart it.`,
      done: false,
      command: cmd('restart_service', { name: stopped }),
    };
  }

  if (history[history.length - 1].command.tool !== 'verify_health') {
    return {
      thought: 'Remediation applied. I should verify health again.',
      done: false,
      command: cmd('verify_health'),
    };
  }
  if (healthy) return { thought: 'Health check passed. Incident resolved.', done: true };
  return {
    thought: 'Health is still failing and I have no further safe remediation. Escalating to a human.',
    done: true,
  };
}

/**
 * @param {string} tool
 * @param {Record<string, unknown>} [args]
 * @returns {Command}
 */
function cmd(tool, args = {}) {
  return { tool, args };
}

/** @returns {Planner} */
function createRuleBasedPlanner() {
  return {
    name: 'rule-based',
    nextStep: async ({ history }) => decide(history),
  };
}

module.exports = { createRuleBasedPlanner, decide };
