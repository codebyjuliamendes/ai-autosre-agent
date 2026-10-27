'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet').default;
const cors = require('cors');
const compression = require('compression');
const { rateLimit } = require('express-rate-limit');
const { pinoHttp } = require('pino-http');
const { z } = require('zod');
const { AppError } = require('../errors');
const { requireOperator, errorHandler } = require('./middleware');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const SWAGGER_UI_DIR = path.dirname(require.resolve('swagger-ui-dist/package.json'));
const HEARTBEAT_MS = 15_000;

const startRunBody = z.object({ mode: z.enum(['dry-run', 'execute']).optional() }).strict();
const approveBody = z
  .object({
    actionId: z.string().uuid(),
    approved: z.boolean(),
    operator: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
const legacyApproveBody = z.object({ id: z.string().uuid(), approved: z.boolean() }).strict();
const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  runId: z.string().uuid().optional(),
});

/**
 * @typedef {Object} AppDeps
 * @property {import('../config').Config} config
 * @property {import('pino').Logger} logger
 * @property {import('../domain/environmentStore').EnvironmentStore} store
 * @property {import('../agent/runManager').RunManager} runs
 * @property {import('../audit/auditLog').AuditLog} audit
 * @property {string} plannerName
 */

/**
 * Builds the Express application. No side effects (no listen), so tests can
 * drive it with supertest.
 * @param {AppDeps} deps
 */
function createApp({ config, logger, store, runs, audit, plannerName }) {
  const app = express();
  /** Open SSE responses, closed on shutdown. */
  const streams = new Set();
  const state = { shuttingDown: false };

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(
    pinoHttp({
      logger,
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url, remoteAddress: req.remoteAddress }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'font-src': ["'self'"],
          'object-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          // Would break asset loading when served over plain HTTP (e.g. cluster-internal); TLS is the ingress' job.
          'upgrade-insecure-requests': null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false }));
  app.use(
    compression({
      // Compression buffers output, which would hold back Server-Sent Events.
      filter: (req, res) =>
        !String(res.getHeader('Content-Type') || '').includes('text/event-stream') && compression.filter(req, res),
    }),
  );
  app.use(express.json({ limit: '10kb' }));

  const operator = requireOperator(config.operatorToken);
  const writeLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    limit: config.rateLimit.max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError(429, 'rate_limited', 'Too many requests, try again later.')),
  });

  // --- Health ---------------------------------------------------------------
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', (_req, res) => {
    if (state.shuttingDown) return res.status(503).json({ status: 'shutting_down' });
    return res.json({ status: 'ready' });
  });

  // --- Static UI and API docs ------------------------------------------------
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: config.env === 'production' ? '1h' : 0 }));
  app.use('/vendor/swagger-ui', express.static(SWAGGER_UI_DIR, { index: false, maxAge: '1d' }));
  app.get('/api-docs', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'api-docs.html')));

  // --- API -------------------------------------------------------------------
  const api = express.Router();

  api.get('/config', (_req, res) => {
    res.json({
      planner: plannerName,
      defaultMode: config.agent.defaultMode,
      allowExecute: config.agent.allowExecute,
      approvalPolicy: config.agent.limits.approvalPolicy,
      approvalTimeoutMs: config.agent.limits.approvalTimeoutMs,
      authRequired: Boolean(config.operatorToken),
    });
  });

  api.get('/state', (_req, res) => res.json(store.get()));

  api.post('/reset', writeLimiter, operator, async (req, res) => {
    await runs.cancelActive('Environment reset by operator');
    audit.record('environment.reset', { ip: req.ip });
    res.json({ message: 'State reset successfully', state: store.reset() });
  });

  api.post('/chaos', writeLimiter, operator, async (req, res) => {
    await runs.cancelActive('Chaos injected by operator');
    audit.record('environment.chaos_injected', { ip: req.ip });
    res.json({ message: 'Chaos injected!', state: store.injectChaos() });
  });

  api.post('/agent/runs', writeLimiter, operator, (req, res) => {
    const body = startRunBody.parse(req.body ?? {});
    const run = runs.start({ mode: body.mode ?? config.agent.defaultMode, requestedBy: req.ip });
    res.status(201).location(`/api/agent/runs/${run.id}`).json(run.summary());
  });

  /** @param {string} id */
  const findRun = (id) => {
    const run = runs.get(id);
    if (!run) throw new AppError(404, 'run_not_found', 'Agent run not found.');
    return run;
  };

  api.get('/agent/runs/:id', (req, res) => res.json(findRun(String(req.params.id)).summary()));

  api.get('/agent/runs/:id/events', (req, res) => {
    const run = findRun(String(req.params.id));
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    /** @param {import('../agent/agentRun').RunEvent} event */
    const write = (event) => {
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      if (event.type === 'end') close();
    };
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);
    heartbeat.unref();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      run.off('event', write);
      streams.delete(close);
      res.end();
    };
    streams.add(close);
    req.on('close', close);

    const lastId = Number(req.get('last-event-id') || 0);
    for (const event of run.events) {
      if (event.seq > lastId) write(event);
      if (closed) return;
    }
    run.on('event', write);
  });

  api.post('/agent/runs/:id/approve', writeLimiter, operator, (req, res) => {
    const run = findRun(String(req.params.id));
    const body = approveBody.parse(req.body);
    if (!run.decide(body.actionId, body.approved, { operator: body.operator, ip: req.ip })) {
      throw new AppError(409, 'no_pending_action', 'No such pending action or already resolved.');
    }
    res.json({ success: true, run: run.summary() });
  });

  api.post('/agent/runs/:id/cancel', writeLimiter, operator, async (req, res) => {
    const run = findRun(String(req.params.id));
    if (!run.finished) {
      audit.record('run.cancel_requested', { runId: run.id, ip: req.ip });
      run.cancel('cancelled', 'Cancelled by operator');
      await run.done;
    }
    res.json(run.summary());
  });

  // Backwards compatible approval endpoint (v3 UI): acts on the active run.
  api.post('/agent/approve', writeLimiter, operator, (req, res) => {
    const body = legacyApproveBody.parse(req.body);
    const run = runs.active;
    if (!run || !run.decide(body.id, body.approved, { ip: req.ip })) {
      throw new AppError(400, 'no_pending_action', 'No such pending action or already resolved.');
    }
    res.json({ success: true });
  });

  // The v3 `GET /api/agent` started a run from a GET request; that is unsafe
  // (prefetchers/crawlers could trigger it), so it is gone.
  api.get('/agent', () => {
    throw new AppError(410, 'gone', 'Use POST /api/agent/runs and GET /api/agent/runs/:id/events.');
  });

  api.get('/audit', operator, (req, res) => {
    const query = auditQuery.parse(req.query);
    res.json({ entries: audit.list(query) });
  });

  api.use(() => {
    throw new AppError(404, 'not_found', 'Route not found.');
  });

  app.use('/api', api);
  app.use(errorHandler(logger));

  /** Marks the app as not ready and closes open event streams. */
  function beginShutdown() {
    state.shuttingDown = true;
    for (const close of [...streams]) close();
  }

  return { app, beginShutdown };
}

module.exports = { createApp };
