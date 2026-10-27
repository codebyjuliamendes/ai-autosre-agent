'use strict';

const pino = require('pino');

/**
 * Structured JSON logger. Credentials are redacted from request logs.
 * @param {{ level: string }} options
 */
function createLogger({ level }) {
  return pino({
    level,
    base: { service: 'ai-autosre-agent' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization'],
      censor: '[REDACTED]',
    },
  });
}

module.exports = { createLogger };
