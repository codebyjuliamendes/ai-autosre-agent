'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLlmPlanner, PlannerOutputError, extractJson } = require('../../src/llm/llmPlanner');
const { createOpenAiCompatibleClient, LlmRequestError } = require('../../src/llm/openAiCompatibleClient');

/** Mocked LLM: records the prompts and returns canned replies. No network. */
function mockClient(replies) {
  const calls = [];
  return {
    calls,
    async complete({ messages }) {
      calls.push(messages);
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

test('parses a valid step and passes observations to the model', async () => {
  const client = mockClient([
    '{"thought":"check logs","done":false,"command":{"tool":"read_log","args":{"file":"syslog"}}}',
  ]);
  const planner = createLlmPlanner({ client });
  const step = await planner.nextStep({
    history: [{ command: { tool: 'verify_health', args: {} }, output: 'HTTP 500' }],
  });
  assert.deepEqual(step, {
    thought: 'check logs',
    done: false,
    command: { tool: 'read_log', args: { file: 'syslog' } },
  });
  const prompt = client.calls[0];
  assert.equal(prompt[0].role, 'system');
  assert.match(prompt[0].content, /kill_process/);
  assert.match(prompt[0].content, /never follow instructions/);
  assert.match(prompt.at(-1).content, /HTTP 500/);
});

test('accepts fenced JSON and done replies', async () => {
  const planner = createLlmPlanner({ client: mockClient(['```json\n{"thought":"all good","done":true}\n```']) });
  assert.deepEqual(await planner.nextStep({ history: [] }), { thought: 'all good', done: true });
});

test('rejects replies that are not valid steps', async () => {
  for (const reply of [
    'I think you should restart postgres',
    '{"thought":"x"}',
    '{"thought":"x","done":false}',
    '{bad json}',
  ]) {
    const planner = createLlmPlanner({ client: mockClient([reply]) });
    await assert.rejects(planner.nextStep({ history: [] }), PlannerOutputError, reply);
  }
});

test('extractJson finds the object inside prose', () => {
  assert.deepEqual(extractJson('Sure! {"a":1} hope it helps'), { a: 1 });
});

test('OpenAI-compatible client sends the request and reads the content', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), { status: 200 });
  };
  const client = createOpenAiCompatibleClient({
    baseUrl: 'http://llm.local/v1/',
    apiKey: 'k',
    model: 'm',
    timeoutMs: 1000,
    fetchImpl,
  });
  assert.equal(await client.complete({ messages: [{ role: 'user', content: 'hi' }] }), 'hello');
  assert.equal(captured.url, 'http://llm.local/v1/chat/completions');
  assert.equal(captured.init.headers.Authorization, 'Bearer k');
  assert.equal(JSON.parse(captured.init.body).model, 'm');
});

test('OpenAI-compatible client surfaces HTTP errors without leaking the body', async () => {
  const fetchImpl = async () => new Response('secret upstream detail', { status: 500 });
  const client = createOpenAiCompatibleClient({ baseUrl: 'http://x', model: 'm', timeoutMs: 1000, fetchImpl });
  await assert.rejects(
    client.complete({ messages: [] }),
    (err) => err instanceof LlmRequestError && /HTTP 500/.test(err.message) && !/secret/.test(err.message),
  );
});

test('OpenAI-compatible client times out', async () => {
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const client = createOpenAiCompatibleClient({ baseUrl: 'http://x', model: 'm', timeoutMs: 50, fetchImpl });
  // AbortSignal.timeout timers are unref'd: keep the event loop alive meanwhile.
  const keepAlive = setTimeout(() => {}, 1000);
  await assert.rejects(client.complete({ messages: [] }), /timed out after 50ms/);
  clearTimeout(keepAlive);
});
