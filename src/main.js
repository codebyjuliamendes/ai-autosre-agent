'use strict';

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { EnvironmentStore } = require('./domain/environmentStore');
const { createRuleBasedPlanner } = require('./domain/ruleBasedPlanner');
const { createLlmPlanner } = require('./llm/llmPlanner');
const { createOpenAiCompatibleClient } = require('./llm/openAiCompatibleClient');
const { AuditLog } = require('./audit/auditLog');
const { RunManager } = require('./agent/runManager');
const { createApp } = require('./http/app');

const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Composition root: wires dependencies together.
 * @param {{ config: import('./config').Config, logger: import('pino').Logger, planner?: import('./domain/ruleBasedPlanner').Planner }} options
 */
function buildContainer({ config, logger, planner }) {
  const store = new EnvironmentStore();
  const audit = new AuditLog({ logger: logger.child({ component: 'audit' }), filePath: config.agent.auditLogFile });
  const chosenPlanner =
    planner ??
    (config.llm.provider === 'openai-compatible'
      ? createLlmPlanner({ client: createOpenAiCompatibleClient(config.llm) })
      : createRuleBasedPlanner());
  const runs = new RunManager({
    planner: chosenPlanner,
    store,
    audit,
    limits: config.agent.limits,
    allowExecute: config.agent.allowExecute,
  });
  const { app, beginShutdown } = createApp({ config, logger, store, runs, audit, plannerName: chosenPlanner.name });
  return { app, beginShutdown, store, audit, runs, planner: chosenPlanner };
}

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Logger is not configured yet: fail fast with a clear message.
    process.stderr.write(`${/** @type {Error} */ (err).message}\n`);
    process.exit(1);
  }
  const logger = createLogger({ level: config.logLevel });
  const { app, beginShutdown, audit, runs, planner } = buildContainer({ config, logger });

  if (!config.operatorToken) {
    logger.warn(
      'OPERATOR_TOKEN is not set: write endpoints and approvals are open to anyone who can reach the server.',
    );
  }
  if (config.llm.provider !== 'none' && !config.llm.apiKey) {
    logger.warn('LLM_PROVIDER is set but LLM_API_KEY is empty (fine for local endpoints such as Ollama).');
  }

  const server = app.listen(config.port, config.host);
  server.once('listening', () => {
    logger.info(
      { port: config.port, planner: planner.name, defaultMode: config.agent.defaultMode },
      'AutoSRE listening',
    );
  });
  server.on('error', (err) => {
    logger.fatal({ err }, 'HTTP server error');
    process.exit(1);
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 0; // SSE streams are long-lived; idle protection comes from heartbeats and run timeouts.

  let stopping = false;
  /** @param {string} signal */
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    beginShutdown();
    await runs.cancelActive(`Server shutting down (${signal})`);
    server.close(async (err) => {
      await audit.close();
      if (err) logger.error({ err }, 'error while closing server');
      process.exit(err ? 1 : 0);
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled rejection'));
}

module.exports = { buildContainer, main };
