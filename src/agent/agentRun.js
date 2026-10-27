'use strict';

const { EventEmitter } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { randomUUID } = require('node:crypto');
const { validateCommand, formatCommand, CommandRejectedError } = require('../domain/commands');
const { cloneState } = require('../domain/environment');
const { withTimeout, TimeoutError } = require('../errors');

/**
 * One execution of the ReAct (reason -> act -> observe) loop.
 *
 * Safety gates, in order, for every step proposed by the planner:
 *   1. allowlist + argument schema + precondition (`validateCommand`);
 *   2. human approval for destructive tools (or for every tool, depending
 *      on the approval policy), with an approval timeout that counts as a
 *      rejection;
 *   3. dry-run: by default the command runs against a *copy* of the
 *      environment, so nothing real changes;
 *   4. timeouts on planning, on each command and on the whole run;
 *   5. a hard limit on the number of steps.
 * Every decision is written to the audit trail.
 *
 * @typedef {'dry-run' | 'execute'} RunMode
 * @typedef {'running' | 'awaiting_approval' | 'completed' | 'failed' | 'rejected' | 'cancelled' | 'timed_out'} RunStatus
 * @typedef {{ seq: number, type: string, data: unknown }} RunEvent
 * @typedef {{ maxSteps: number, stepDelayMs: number, plannerTimeoutMs: number, commandTimeoutMs: number, approvalTimeoutMs: number, runTimeoutMs: number, approvalPolicy: 'destructive' | 'all' }} RunLimits
 * @typedef {import('../domain/ruleBasedPlanner').Planner} Planner
 * @typedef {import('../domain/ruleBasedPlanner').Observation} Observation
 * @typedef {import('../domain/environmentStore').EnvironmentStore} EnvironmentStore
 * @typedef {import('../audit/auditLog').AuditLog} AuditLog
 */

const TERMINAL = new Set(['completed', 'failed', 'rejected', 'cancelled', 'timed_out']);
const MAX_EVENTS = 500;

class RunAbortedError extends Error {
  /** @param {RunStatus} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.name = 'RunAbortedError';
    this.status = status;
  }
}

class AgentRun extends EventEmitter {
  /**
   * @param {{ mode: RunMode, planner: Planner, store: EnvironmentStore, audit: AuditLog, limits: RunLimits, requestedBy?: string }} options
   */
  constructor({ mode, planner, store, audit, limits, requestedBy }) {
    super();
    this.id = randomUUID();
    this.mode = mode;
    this.planner = planner;
    this.store = store;
    this.audit = audit;
    this.limits = limits;
    this.requestedBy = requestedBy;
    /** @type {RunStatus} */
    this.status = 'running';
    this.createdAt = new Date().toISOString();
    /** @type {string | null} */
    this.finishedAt = null;
    /** @type {RunEvent[]} */
    this.events = [];
    this.seq = 0;
    /** @type {Observation[]} */
    this.history = [];
    /** @type {{ id: string, command: import('../domain/commands').Command, resolve: (d: { approved: boolean, operator?: string }) => void, timer: NodeJS.Timeout } | null} */
    this.pending = null;
    this.abort = new AbortController();
    /** Working copy used in dry-run mode. */
    this.shadow = mode === 'dry-run' ? store.get() : null;
    this.setMaxListeners(50);
  }

  get finished() {
    return TERMINAL.has(this.status);
  }

  summary() {
    return {
      id: this.id,
      mode: this.mode,
      planner: this.planner.name,
      status: this.status,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt,
      pendingAction: this.pending ? { id: this.pending.id, command: formatCommand(this.pending.command) } : null,
      steps: this.history.length,
    };
  }

  /**
   * @param {string} type
   * @param {unknown} data
   */
  emitEvent(type, data) {
    const event = { seq: ++this.seq, type, data };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.emit('event', event);
  }

  /** @param {'system' | 'thought' | 'action' | 'observation'} kind @param {string} text */
  log(kind, text) {
    this.emitEvent('message', { type: kind, text });
  }

  currentState() {
    return this.shadow ? cloneState(this.shadow) : this.store.get();
  }

  /** @param {import('../domain/environment').EnvironmentState} state */
  commitState(state) {
    if (this.shadow) this.shadow = cloneState(state);
    else this.store.set(state);
  }

  /** Starts the loop in the background. Resolves when the run is finished. */
  start() {
    this.audit.record('run.started', {
      runId: this.id,
      mode: this.mode,
      planner: this.planner.name,
      requestedBy: this.requestedBy,
    });
    const runTimer = setTimeout(
      () => this.cancel('timed_out', `Run exceeded ${this.limits.runTimeoutMs}ms`),
      this.limits.runTimeoutMs,
    );
    this.done = this.loop()
      .catch((err) => this.finish(err instanceof RunAbortedError ? err.status : 'failed', err.message))
      .finally(() => clearTimeout(runTimer));
    return this.done;
  }

  async loop() {
    this.log('system', `AutoSRE agent started (planner: ${this.planner.name}, mode: ${this.mode}).`);
    if (this.mode === 'dry-run') {
      this.log('system', 'DRY-RUN: commands are simulated on a copy of the environment; nothing real will change.');
    }

    for (let step = 0; step < this.limits.maxSteps; step++) {
      await this.pause();
      const plan = await this.guard(
        withTimeout(
          () => this.planner.nextStep({ history: this.history, signal: this.abort.signal }),
          this.limits.plannerTimeoutMs,
          'Planner',
        ),
      );
      this.log('thought', plan.thought);
      if (plan.done) return this.finish('completed', plan.thought);

      let validated;
      try {
        validated = validateCommand(plan.command, this.currentState());
      } catch (err) {
        const reason = err instanceof CommandRejectedError ? err.message : 'Invalid command.';
        this.audit.record('action.blocked', { runId: this.id, proposed: plan.command, reason });
        this.log('system', `Blocked by guardrails: ${reason}`);
        return this.finish('failed', `Blocked by guardrails: ${reason}`);
      }
      const { command, definition } = validated;
      const display = formatCommand(command);
      this.audit.record('action.proposed', { runId: this.id, command, destructive: definition.destructive });

      if (definition.destructive || this.limits.approvalPolicy === 'all') {
        const decision = await this.requestApproval(command, definition.destructive);
        if (!decision.approved) {
          this.log('system', `Action rejected: ${display}. Agent stopping.`);
          return this.finish('rejected', `Action rejected: ${display}`);
        }
        // The environment may have changed while waiting for a human: check the precondition again.
        try {
          validateCommand(command, this.currentState());
        } catch (err) {
          const reason = err instanceof CommandRejectedError ? err.message : 'Invalid command.';
          this.audit.record('action.blocked', { runId: this.id, proposed: command, reason, afterApproval: true });
          return this.finish('failed', `Blocked by guardrails after approval: ${reason}`);
        }
      }

      this.log('action', `${this.mode === 'dry-run' ? '[dry-run] ' : ''}call ${display}`);
      const before = this.currentState();
      const result = await this.guard(
        withTimeout(
          async () => definition.run(before, command.args),
          this.limits.commandTimeoutMs,
          `Command ${display}`,
        ),
      );
      this.throwIfAborted();
      this.commitState(result.state);
      this.history.push({ command, output: result.output });
      this.audit.record('action.executed', {
        runId: this.id,
        command,
        mode: this.mode,
        output: result.output.slice(0, 500),
      });
      this.log('observation', result.output);
      if (this.mode === 'execute') this.emitEvent('update', this.store.get());
    }
    this.log('system', `Step limit (${this.limits.maxSteps}) reached. Escalating to a human.`);
    return this.finish('failed', 'Step limit reached');
  }

  /**
   * Races `promise` against cancellation of the run.
   * @template T
   * @param {Promise<T>} promise
   * @returns {Promise<T>}
   */
  guard(promise) {
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(this.abort.signal.reason);
      if (this.abort.signal.aborted) return onAbort();
      this.abort.signal.addEventListener('abort', onAbort, { once: true });
      promise
        .then(resolve, (err) =>
          reject(err instanceof TimeoutError ? new RunAbortedError('timed_out', err.message) : err),
        )
        .finally(() => this.abort.signal.removeEventListener('abort', onAbort));
    });
  }

  /** Small delay between steps so a human can follow the stream. */
  async pause() {
    this.throwIfAborted();
    if (this.limits.stepDelayMs > 0) {
      await sleep(this.limits.stepDelayMs, undefined, { signal: this.abort.signal }).catch(() => {});
    }
    this.throwIfAborted();
  }

  throwIfAborted() {
    if (this.abort.signal.aborted) throw this.abort.signal.reason;
  }

  /**
   * @param {import('../domain/commands').Command} command
   * @param {boolean} destructive
   * @returns {Promise<{ approved: boolean, operator?: string }>}
   */
  requestApproval(command, destructive) {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + this.limits.approvalTimeoutMs).toISOString();
    this.status = 'awaiting_approval';
    this.audit.record('approval.requested', { runId: this.id, actionId: id, command, destructive });
    return this.guard(
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.audit.record('approval.timed_out', { runId: this.id, actionId: id, command });
          this.log('system', `No decision within ${this.limits.approvalTimeoutMs / 1000}s: treated as rejection.`);
          this.settleApproval({ approved: false });
        }, this.limits.approvalTimeoutMs);
        this.pending = { id, command, resolve, timer };
        this.emitEvent('pending_action', {
          id,
          command: formatCommand(command),
          tool: command.tool,
          args: command.args,
          destructive,
          mode: this.mode,
          expiresAt,
        });
      }),
    );
  }

  /** @param {{ approved: boolean, operator?: string }} decision */
  settleApproval(decision) {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = null;
    if (!this.finished) this.status = 'running';
    this.emitEvent('action_resolved', { id: pending.id, approved: decision.approved });
    pending.resolve(decision);
  }

  /**
   * Records a human decision for the pending action.
   * @param {string} actionId
   * @param {boolean} approved
   * @param {{ operator?: string, ip?: string }} [meta]
   * @returns {boolean} false if there is no such pending action.
   */
  decide(actionId, approved, meta = {}) {
    if (!this.pending || this.pending.id !== actionId || this.finished) return false;
    this.audit.record(approved ? 'approval.granted' : 'approval.denied', {
      runId: this.id,
      actionId,
      command: this.pending.command,
      operator: meta.operator || 'anonymous',
      ip: meta.ip,
    });
    this.settleApproval({ approved, operator: meta.operator });
    return true;
  }

  /**
   * @param {RunStatus} status
   * @param {string} reason
   */
  cancel(status, reason) {
    if (this.finished || this.abort.signal.aborted) return;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
    this.abort.abort(new RunAbortedError(status, reason));
  }

  /**
   * @param {RunStatus} status
   * @param {string} reason
   */
  finish(status, reason) {
    if (this.finished) return;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending = null;
    }
    this.status = status;
    this.finishedAt = new Date().toISOString();
    this.audit.record('run.finished', { runId: this.id, status, reason });
    if (status !== 'completed') this.log('system', `Run ${status.replace('_', ' ')}: ${reason}`);
    else this.log('system', 'Agent finished.');
    this.emitEvent('end', { status, reason });
  }
}

module.exports = { AgentRun, RunAbortedError };
