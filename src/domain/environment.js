'use strict';

/**
 * Simulated server environment.
 *
 * Everything here is pure: functions receive a state and return a new one,
 * never mutating their input. This keeps the agent's "dry-run" mode trivial
 * (run against a clone) and makes the rules easy to unit test.
 */

/**
 * @typedef {Object} ProcessInfo
 * @property {number} pid
 * @property {string} name
 * @property {number} cpu - CPU share used by the process (percentage points)
 */

/**
 * @typedef {Object} EnvironmentState
 * @property {number} cpu - Total CPU usage percentage (0-100)
 * @property {string} status - HTTP status string reported by nginx
 * @property {ProcessInfo[]} processes
 * @property {Record<string, string>} logs - Log file name -> contents
 * @property {Record<string, 'running' | 'stopped'>} services
 */

/** CPU used by the kernel/idle overhead, added on top of the processes. */
const BASE_CPU = 5;

/** Processes started by each service when it is (re)started. */
const SERVICE_PROCESSES = Object.freeze({
  nginx: Object.freeze({ pid: 80, name: 'nginx', cpu: 2 }),
  postgres: Object.freeze({ pid: 5432, name: 'postgres', cpu: 2 }),
});

const HEALTHY_STATUS = '200 OK';
const UNHEALTHY_STATUS = '500 Internal Server Error';

/**
 * @param {ProcessInfo[]} processes
 * @returns {number}
 */
function computeCpu(processes) {
  const total = processes.reduce((sum, p) => sum + p.cpu, BASE_CPU);
  return Math.max(0, Math.min(100, total));
}

/**
 * @param {Record<string, string>} services
 * @returns {string}
 */
function computeStatus(services) {
  return Object.values(services).every((s) => s === 'running') ? HEALTHY_STATUS : UNHEALTHY_STATUS;
}

/**
 * Builds a consistent state, deriving `cpu` and `status` from the processes/services.
 * @param {Omit<EnvironmentState, 'cpu' | 'status'>} parts
 * @returns {EnvironmentState}
 */
function buildState({ processes, logs, services }) {
  return {
    cpu: computeCpu(processes),
    status: computeStatus(services),
    processes: processes.map((p) => ({ ...p })),
    logs: { ...logs },
    services: { ...services },
  };
}

/** @returns {EnvironmentState} */
function nominalState() {
  return buildState({
    processes: [{ pid: 1, name: 'init', cpu: 1 }, { ...SERVICE_PROCESSES.nginx }, { ...SERVICE_PROCESSES.postgres }],
    logs: { 'nginx_error.log': '', syslog: 'System nominal.' },
    services: { nginx: 'running', postgres: 'running' },
  });
}

/** @returns {EnvironmentState} */
function chaosState() {
  return buildState({
    processes: [
      { pid: 1, name: 'init', cpu: 1 },
      { ...SERVICE_PROCESSES.nginx },
      { pid: 1337, name: 'cryptominer_xmrig', cpu: 91 },
    ],
    logs: {
      'nginx_error.log':
        '[error] 80#80: *1 connect() to 127.0.0.1:5432 failed (Connection refused) - Database is unreachable.',
      syslog: 'High CPU usage detected on PID 1337.',
    },
    services: { nginx: 'running', postgres: 'stopped' },
  });
}

/**
 * @param {EnvironmentState} state
 * @returns {EnvironmentState}
 */
function cloneState(state) {
  return structuredClone(state);
}

/**
 * @param {EnvironmentState} state
 * @param {number} pid
 * @returns {EnvironmentState}
 */
function killProcess(state, pid) {
  const processes = state.processes.filter((p) => p.pid !== pid);
  // A service whose process was killed is no longer running.
  const services = { ...state.services };
  for (const [service, proc] of Object.entries(SERVICE_PROCESSES)) {
    if (proc.pid === pid && service in services) services[service] = 'stopped';
  }
  return buildState({ processes, logs: state.logs, services });
}

/**
 * Restarts a service: its process is (re)created exactly once.
 * @param {EnvironmentState} state
 * @param {string} service
 * @returns {EnvironmentState}
 */
function restartService(state, service) {
  const proc = SERVICE_PROCESSES[/** @type {keyof typeof SERVICE_PROCESSES} */ (service)];
  const processes = state.processes.filter((p) => !proc || p.pid !== proc.pid);
  if (proc) processes.push({ ...proc });
  /** @type {EnvironmentState['services']} */
  const services = { ...state.services, [service]: 'running' };
  const logs = { ...state.logs };
  if (computeStatus(services) === HEALTHY_STATUS) logs['nginx_error.log'] = '';
  return buildState({ processes, logs, services });
}

/**
 * @param {EnvironmentState} state
 * @returns {boolean}
 */
function isHealthy(state) {
  return state.status === HEALTHY_STATUS;
}

module.exports = {
  BASE_CPU,
  HEALTHY_STATUS,
  UNHEALTHY_STATUS,
  SERVICE_PROCESSES,
  nominalState,
  chaosState,
  cloneState,
  killProcess,
  restartService,
  isHealthy,
};
