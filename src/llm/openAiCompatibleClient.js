'use strict';

/**
 * Minimal client for any OpenAI-compatible Chat Completions endpoint
 * (OpenAI, Azure OpenAI proxies, Ollama, vLLM, LM Studio, OpenRouter...).
 * Uses the global `fetch` of Node >= 20, with a hard timeout.
 *
 * @typedef {import('./llmPlanner').ChatMessage} ChatMessage
 * @typedef {import('./llmPlanner').LlmClient} LlmClient
 */

class LlmRequestError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'LlmRequestError';
  }
}

/**
 * @param {{ baseUrl: string, apiKey?: string, model: string, timeoutMs: number, fetchImpl?: typeof fetch }} options
 * @returns {LlmClient}
 */
function createOpenAiCompatibleClient({ baseUrl, apiKey, model, timeoutMs, fetchImpl = fetch }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return {
    async complete({ messages, signal }) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      /** @type {Record<string, string>} */
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, messages, temperature: 0 }),
          signal: combined,
        });
      } catch (err) {
        const reason = timeout.aborted ? `timed out after ${timeoutMs}ms` : /** @type {Error} */ (err).message;
        throw new LlmRequestError(`LLM request failed: ${reason}`);
      }
      if (!res.ok) throw new LlmRequestError(`LLM request failed with HTTP ${res.status}`);
      const body = /** @type {any} */ (await res.json().catch(() => null));
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new LlmRequestError('LLM response has no message content.');
      return content;
    },
  };
}

module.exports = { createOpenAiCompatibleClient, LlmRequestError };
