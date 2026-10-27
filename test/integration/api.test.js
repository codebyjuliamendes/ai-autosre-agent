'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildTestApp, waitFor } = require('../helpers/factory');

describe('HTTP API', () => {
  test('health, readiness and security headers', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/healthz').expect(200);
    assert.deepEqual(res.body, { status: 'ok' });
    await request(app).get('/readyz').expect(200);
    const page = await request(app).get('/').expect(200);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['x-powered-by'], undefined);
    assert.doesNotMatch(page.text, /cdn\.tailwindcss|unpkg\.com/, 'no third-party scripts');
  });

  test('readiness fails once shutdown begins', async () => {
    const { app, beginShutdown } = buildTestApp();
    beginShutdown();
    await request(app).get('/readyz').expect(503);
  });

  test('api docs are served locally', async () => {
    const { app } = buildTestApp();
    await request(app)
      .get('/api-docs')
      .expect(200)
      .expect(/swagger-ui-bundle\.js/);
    await request(app).get('/vendor/swagger-ui/swagger-ui-bundle.js').expect(200);
    const spec = await request(app).get('/swagger.json').expect(200);
    assert.ok(spec.body.paths['/api/agent/runs']);
  });

  test('state, chaos and reset', async () => {
    const { app } = buildTestApp();
    const chaos = await request(app).post('/api/chaos').expect(200);
    assert.equal(chaos.body.state.cpu, 99);
    assert.equal((await request(app).get('/api/state')).body.services.postgres, 'stopped');
    const reset = await request(app).post('/api/reset').expect(200);
    assert.equal(reset.body.state.status, '200 OK');
  });

  test('public config exposes safe defaults', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/config').expect(200);
    assert.deepEqual(res.body, {
      planner: 'rule-based',
      defaultMode: 'dry-run',
      allowExecute: true,
      approvalPolicy: 'destructive',
      approvalTimeoutMs: 120000,
      authRequired: false,
    });
  });

  test('unknown API routes return JSON 404, legacy GET /api/agent returns 410', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/nope').expect(404);
    assert.equal(res.body.error.code, 'not_found');
    await request(app).get('/api/agent').expect(410);
    await request(app).get('/api/agent/runs/00000000-0000-4000-8000-000000000000').expect(404);
  });

  test('execute run with approvals over HTTP', async () => {
    const { app, runs } = buildTestApp();
    await request(app).post('/api/chaos').expect(200);
    const started = await request(app).post('/api/agent/runs').send({ mode: 'execute' }).expect(201);
    assert.equal(started.body.mode, 'execute');
    assert.match(started.headers.location, /\/api\/agent\/runs\//);
    const id = started.body.id;

    await request(app).post('/api/agent/runs').send({}).expect(409);

    for (let i = 0; i < 2; i++) {
      await waitFor(() => runs.get(id).pending);
      const actionId = runs.get(id).pending.id;
      // String "false" used to be truthy and approved the action: now it is a validation error.
      const bad = await request(app)
        .post(`/api/agent/runs/${id}/approve`)
        .send({ actionId, approved: 'false' })
        .expect(400);
      assert.equal(bad.body.error.code, 'validation_error');
      await request(app)
        .post(`/api/agent/runs/${id}/approve`)
        .send({ actionId, approved: true, operator: 'julia' })
        .expect(200);
      await request(app).post(`/api/agent/runs/${id}/approve`).send({ actionId, approved: true }).expect(409);
    }
    await runs.get(id).done;
    const summary = await request(app).get(`/api/agent/runs/${id}`).expect(200);
    assert.equal(summary.body.status, 'completed');
    assert.equal((await request(app).get('/api/state')).body.status, '200 OK');

    const audit = await request(app).get(`/api/audit?runId=${id}`).expect(200);
    assert.ok(audit.body.entries.some((e) => e.event === 'approval.granted' && e.details.operator === 'julia'));
  });

  test('default mode is dry-run and leaves the environment untouched', async () => {
    const { app, runs } = buildTestApp();
    await request(app).post('/api/chaos').expect(200);
    const { body } = await request(app).post('/api/agent/runs').expect(201);
    assert.equal(body.mode, 'dry-run');
    const run = runs.get(body.id);
    while (!run.finished) {
      const pending = await waitFor(() => run.pending || run.finished);
      if (pending !== true) run.decide(pending.id, true);
    }
    await run.done;
    assert.equal(run.status, 'completed');
    assert.equal((await request(app).get('/api/state')).body.status, '500 Internal Server Error');
  });

  test('execute can be disabled by configuration', async () => {
    const { app } = buildTestApp({ env: { AGENT_ALLOW_EXECUTE: 'false' } });
    const res = await request(app).post('/api/agent/runs').send({ mode: 'execute' }).expect(403);
    assert.equal(res.body.error.code, 'execute_disabled');
  });

  test('chaos cancels the active run', async () => {
    const { app, runs } = buildTestApp();
    await request(app).post('/api/chaos');
    const { body } = await request(app).post('/api/agent/runs').send({ mode: 'execute' }).expect(201);
    await waitFor(() => runs.get(body.id).pending);
    await request(app).post('/api/chaos').expect(200);
    assert.equal(runs.get(body.id).status, 'cancelled');
    await request(app).post('/api/agent/runs').expect(201);
    await runs.cancelActive('cleanup');
  });

  test('cancel endpoint', async () => {
    const { app, runs } = buildTestApp();
    await request(app).post('/api/chaos');
    const { body } = await request(app).post('/api/agent/runs').expect(201);
    await waitFor(() => runs.get(body.id).pending);
    const res = await request(app).post(`/api/agent/runs/${body.id}/cancel`).expect(200);
    assert.equal(res.body.status, 'cancelled');
  });

  test('legacy approve endpoint validates its body', async () => {
    const { app, runs } = buildTestApp();
    await request(app).post('/api/chaos');
    const { body } = await request(app).post('/api/agent/runs').expect(201);
    const pending = await waitFor(() => runs.get(body.id).pending);
    await request(app).post('/api/agent/approve').send({ id: pending.id, approved: 1 }).expect(400);
    await request(app).post('/api/agent/approve').send({ id: pending.id, approved: false }).expect(200);
    await runs.get(body.id).done;
    assert.equal(runs.get(body.id).status, 'rejected');
  });

  test('rejects malformed and oversized bodies', async () => {
    const { app } = buildTestApp();
    await request(app).post('/api/agent/runs').set('Content-Type', 'application/json').send('{bad').expect(400);
    await request(app).post('/api/agent/runs').send({ mode: 'yolo' }).expect(400);
    await request(app).post('/api/agent/runs').send({ mode: 'dry-run', extra: 1 }).expect(400);
    await request(app)
      .post('/api/agent/runs')
      .send({ mode: 'x'.repeat(20_000) })
      .expect(413);
  });
});

describe('operator token', () => {
  const TOKEN = 'test-operator-token-123456';

  test('write endpoints and audit require the token when configured', async () => {
    const { app } = buildTestApp({ env: { OPERATOR_TOKEN: TOKEN } });
    await request(app).get('/api/state').expect(200);
    await request(app).post('/api/chaos').expect(401);
    await request(app).post('/api/chaos').set('Authorization', 'Bearer wrong').expect(401);
    await request(app).get('/api/audit').expect(401);
    await request(app).post('/api/agent/runs').expect(401);
    await request(app).post('/api/chaos').set('Authorization', `Bearer ${TOKEN}`).expect(200);
    await request(app).get('/api/audit').set('Authorization', `Bearer ${TOKEN}`).expect(200);
    assert.equal((await request(app).get('/api/config')).body.authRequired, true);
  });
});

describe('rate limiting', () => {
  test('write endpoints are rate limited', async () => {
    const { app } = buildTestApp({ env: { RATE_LIMIT_MAX: '2' } });
    await request(app).post('/api/reset').expect(200);
    await request(app).post('/api/reset').expect(200);
    const res = await request(app).post('/api/reset').expect(429);
    assert.equal(res.body.error.code, 'rate_limited');
    await request(app).get('/api/state').expect(200);
  });
});
