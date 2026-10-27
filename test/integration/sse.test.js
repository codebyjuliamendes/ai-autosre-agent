'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildTestApp } = require('../helpers/factory');

/** Reads an SSE stream until it ends, calling onEvent for each parsed event. */
async function readStream(url, { headers = {}, onEvent = () => {} } = {}) {
  const res = await fetch(url, { headers });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.equal(res.headers.get('content-encoding'), null, 'SSE must not be compressed/buffered');
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (raw.startsWith(':')) continue;
      const fields = Object.fromEntries(
        raw.split('\n').map((l) => {
          const i = l.indexOf(': ');
          return [l.slice(0, i), l.slice(i + 2)];
        }),
      );
      const event = { id: Number(fields.id), type: fields.event, data: JSON.parse(fields.data) };
      events.push(event);
      await onEvent(event);
    }
  }
  return events;
}

async function withServer(fn) {
  const container = buildTestApp();
  const server = container.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, container);
  } finally {
    container.beginShutdown();
    await container.runs.cancelActive('test end');
    await new Promise((r) => server.close(r));
  }
}

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

test('streams a full run with human approvals and ends the stream', async () => {
  await withServer(async (base) => {
    await post(`${base}/api/chaos`);
    const run = await (await post(`${base}/api/agent/runs`, { mode: 'execute' })).json();
    const events = await readStream(`${base}/api/agent/runs/${run.id}/events`, {
      onEvent: async (e) => {
        if (e.type === 'pending_action') {
          const res = await post(`${base}/api/agent/runs/${run.id}/approve`, { actionId: e.data.id, approved: true });
          assert.equal(res.status, 200);
        }
      },
    });
    const types = events.map((e) => e.type);
    assert.equal(types.at(-1), 'end');
    assert.equal(events.at(-1).data.status, 'completed');
    assert.ok(types.includes('update'));
    assert.deepEqual(
      events.filter((e) => e.type === 'pending_action').map((e) => e.data.command),
      ['kill_process(1337)', 'restart_service("postgres")'],
    );
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.status, '200 OK');
  });
});

test('replays history and resumes with Last-Event-ID', async () => {
  await withServer(async (base, { runs }) => {
    await post(`${base}/api/chaos`);
    const run = await (await post(`${base}/api/agent/runs`)).json();
    runs.get(run.id).cancel('cancelled', 'stop');
    await runs.get(run.id).done;
    const all = await readStream(`${base}/api/agent/runs/${run.id}/events`);
    assert.equal(all.at(-1).type, 'end');
    const resumed = await readStream(`${base}/api/agent/runs/${run.id}/events`, {
      headers: { 'Last-Event-ID': String(all.at(-2).id) },
    });
    assert.deepEqual(
      resumed.map((e) => e.id),
      [all.at(-1).id],
    );
  });
});
