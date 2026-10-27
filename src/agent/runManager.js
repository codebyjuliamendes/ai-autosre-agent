'use strict';

const { AgentRun } = require('./agentRun');
const { AppError } = require('../errors');

const MAX_RETAINED_RUNS = 20;

/**
 * Owns agent runs. There is a single environment, so only one run may be
 * active at a time; finished runs are kept (bounded) so clients can replay
 * their event stream.
 */
class RunManager {
  /**
   * @param {{ planner: import('../domain/ruleBasedPlanner').Planner, store: import('../domain/environmentStore').EnvironmentStore, audit: import('../audit/auditLog').AuditLog, limits: import('./agentRun').RunLimits, allowExecute: boolean }} deps
   */
  constructor({ planner, store, audit, limits, allowExecute }) {
    this.planner = planner;
    this.store = store;
    this.audit = audit;
    this.limits = limits;
    this.allowExecute = allowExecute;
    /** @type {Map<string, AgentRun>} */
    this.runs = new Map();
    /** @type {AgentRun | null} */
    this.active = null;
  }

  /**
   * @param {{ mode: import('./agentRun').RunMode, requestedBy?: string }} options
   * @returns {AgentRun}
   */
  start({ mode, requestedBy }) {
    if (mode === 'execute' && !this.allowExecute) {
      throw new AppError(
        403,
        'execute_disabled',
        'Execute mode is disabled on this server (AGENT_ALLOW_EXECUTE=false).',
      );
    }
    if (this.active && !this.active.finished) {
      throw new AppError(409, 'run_in_progress', 'An agent run is already in progress.');
    }
    const run = new AgentRun({
      mode,
      planner: this.planner,
      store: this.store,
      audit: this.audit,
      limits: this.limits,
      requestedBy,
    });
    this.runs.set(run.id, run);
    while (this.runs.size > MAX_RETAINED_RUNS) {
      const oldest = this.runs.keys().next().value;
      if (oldest === undefined) break;
      this.runs.delete(oldest);
    }
    this.active = run;
    run.start().finally(() => {
      if (this.active === run) this.active = null;
    });
    return run;
  }

  /** @param {string} id */
  get(id) {
    return this.runs.get(id);
  }

  /** @param {string} reason */
  cancelActive(reason) {
    const run = this.active;
    if (run && !run.finished) {
      run.cancel('cancelled', reason);
      return run.done;
    }
    return Promise.resolve();
  }
}

module.exports = { RunManager };
