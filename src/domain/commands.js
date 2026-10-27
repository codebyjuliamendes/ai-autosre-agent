'use strict';

const { z } = require('zod');
const env = require('./environment');

/**
 * Allowlist of tools the agent may call.
 *
 * A command is data (`{ tool, args }`), never a string that gets evaluated.
 * Every command proposed by a planner (rule-based or LLM) goes through
 * `validateCommand` before it can be shown for approval or executed:
 *   1. the tool must be in this registry;
 *   2. the arguments must match the tool's strict schema;
 *   3. the tool's precondition must hold against the current state
 *      (e.g. you cannot kill PID 1 or restart a service that does not exist).
 */

/** Processes the agent must never kill, whatever a planner says. */
const PROTECTED_PIDS = Object.freeze(new Set([1]));
const PROTECTED_PROCESS_NAMES = Object.freeze(new Set(['init', 'systemd', 'sshd']));

class CommandRejectedError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'CommandRejectedError';
  }
}

/**
 * @typedef {import('./environment').EnvironmentState} EnvironmentState
 * @typedef {{ tool: string, args: Record<string, unknown> }} Command
 * @typedef {{ state: EnvironmentState, output: string }} CommandResult
 *
 * @typedef {Object} ToolDefinition
 * @property {string} description
 * @property {boolean} destructive - Changes the environment; always needs human approval.
 * @property {z.ZodType} schema - Strict schema for `args`.
 * @property {(state: EnvironmentState, args: any) => string | null} [precheck] - Returns a rejection reason.
 * @property {(state: EnvironmentState, args: any) => CommandResult} run
 */

const noArgs = z.object({}).strict();

/** @type {Readonly<Record<string, ToolDefinition>>} */
const TOOLS = Object.freeze({
  verify_health: {
    description: 'Check the HTTP status reported by nginx.',
    destructive: false,
    schema: noArgs,
    run: (state) => ({
      state,
      output: env.isHealthy(state) ? 'HTTP 200 OK - All systems nominal.' : `HTTP ${state.status} - System failure.`,
    }),
  },
  read_log: {
    description: 'Read a log file. args: { file: string }',
    destructive: false,
    schema: z.object({ file: z.string().min(1).max(64) }).strict(),
    precheck: (state, { file }) =>
      Object.prototype.hasOwnProperty.call(state.logs, file) ? null : `Unknown log file "${file}".`,
    run: (state, { file }) => ({ state, output: state.logs[file] || '(empty log)' }),
  },
  list_processes: {
    description: 'List running processes as JSON [{pid, name, cpu}].',
    destructive: false,
    schema: noArgs,
    run: (state) => ({ state, output: JSON.stringify(state.processes) }),
  },
  list_services: {
    description: 'List services and their status as JSON {name: status}.',
    destructive: false,
    schema: noArgs,
    run: (state) => ({ state, output: JSON.stringify(state.services) }),
  },
  kill_process: {
    description: 'Kill a process by PID. args: { pid: integer }',
    destructive: true,
    schema: z.object({ pid: z.number().int().positive().max(4_194_304) }).strict(),
    precheck: (state, { pid }) => {
      const proc = state.processes.find((p) => p.pid === pid);
      if (!proc) return `No process with PID ${pid}.`;
      if (PROTECTED_PIDS.has(pid) || PROTECTED_PROCESS_NAMES.has(proc.name)) {
        return `PID ${pid} (${proc.name}) is protected and cannot be killed.`;
      }
      return null;
    },
    run: (state, { pid }) => ({ state: env.killProcess(state, pid), output: `Process ${pid} killed successfully.` }),
  },
  restart_service: {
    description: 'Restart a known service. args: { name: string }',
    destructive: true,
    schema: z.object({ name: z.string().min(1).max(64) }).strict(),
    precheck: (state, { name }) =>
      Object.prototype.hasOwnProperty.call(state.services, name) ? null : `Unknown service "${name}".`,
    run: (state, { name }) => ({
      state: env.restartService(state, name),
      output: `Service ${name} restarted successfully.`,
    }),
  },
});

/**
 * Human readable representation, e.g. `kill_process(1337)` or `read_log("syslog")`.
 * @param {Command} command
 * @returns {string}
 */
function formatCommand(command) {
  const values = Object.values(command.args || {}).map((v) => JSON.stringify(v));
  return `${command.tool}(${values.join(', ')})`;
}

/**
 * Validates an untrusted command against the allowlist and the current state.
 * @param {unknown} raw
 * @param {EnvironmentState} state
 * @returns {{ command: Command, definition: ToolDefinition }}
 * @throws {CommandRejectedError}
 */
function validateCommand(raw, state) {
  const shape = z
    .object({ tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) })
    .strict()
    .safeParse(raw);
  if (!shape.success) throw new CommandRejectedError('Malformed command.');

  const { tool } = shape.data;
  if (!Object.prototype.hasOwnProperty.call(TOOLS, tool)) {
    throw new CommandRejectedError(`Tool "${tool}" is not in the allowlist.`);
  }
  const definition = TOOLS[tool];
  const args = definition.schema.safeParse(shape.data.args);
  if (!args.success) throw new CommandRejectedError(`Invalid arguments for ${tool}.`);

  const reason = definition.precheck ? definition.precheck(state, args.data) : null;
  if (reason) throw new CommandRejectedError(reason);

  return { command: { tool, args: /** @type {Record<string, unknown>} */ (args.data) }, definition };
}

module.exports = {
  TOOLS,
  PROTECTED_PIDS,
  PROTECTED_PROCESS_NAMES,
  CommandRejectedError,
  validateCommand,
  formatCommand,
};
