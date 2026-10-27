'use strict';

const { timingSafeEqual, createHash } = require('node:crypto');
const { ZodError } = require('zod');
const { AppError } = require('../errors');

/**
 * Requires `Authorization: Bearer <OPERATOR_TOKEN>` when a token is configured.
 * Without a token the API is open (local demo mode); the server logs a warning at boot.
 * @param {string | undefined} token
 * @returns {import('express').RequestHandler}
 */
function requireOperator(token) {
  if (!token) return (_req, _res, next) => next();
  const expected = createHash('sha256').update(token).digest();
  return (req, _res, next) => {
    const header = req.get('authorization') || '';
    const match = /^Bearer (.+)$/.exec(header);
    const given = createHash('sha256')
      .update(match ? match[1] : '')
      .digest();
    if (!match || !timingSafeEqual(given, expected)) {
      return next(new AppError(401, 'unauthorized', 'A valid operator token is required.'));
    }
    return next();
  };
}

/**
 * @param {import('pino').Logger} logger
 * @returns {import('express').ErrorRequestHandler}
 */
function errorHandler(logger) {
  return (err, req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'validation_error',
          message: 'Invalid request.',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
      return;
    }
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
      const status = err.type === 'entity.too.large' ? 413 : 400;
      res.status(status).json({ error: { code: err.type, message: 'Invalid request body.' } });
      return;
    }
    (req.log || logger).error({ err }, 'unhandled error');
    res.status(500).json({ error: { code: 'internal_error', message: 'Internal Server Error' } });
  };
}

module.exports = { requireOperator, errorHandler };
