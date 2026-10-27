'use strict';

const { z } = require('zod');

const bool = (def) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const int = (def, min, max) => z.coerce.number().int().min(min).max(max).default(def);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: int(4002, 1, 65535),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.string().default('false'),
  CORS_ORIGINS: z.string().default(''),
  OPERATOR_TOKEN: z.string().min(16, 'OPERATOR_TOKEN must have at least 16 characters').optional(),
  RATE_LIMIT_WINDOW_MS: int(60_000, 1000, 3_600_000),
  RATE_LIMIT_MAX: int(30, 1, 10_000),

  AGENT_DEFAULT_MODE: z.enum(['dry-run', 'execute']).default('dry-run'),
  AGENT_ALLOW_EXECUTE: bool(true),
  AGENT_APPROVAL_POLICY: z.enum(['destructive', 'all']).default('destructive'),
  AGENT_MAX_STEPS: int(12, 1, 50),
  AGENT_STEP_DELAY_MS: int(400, 0, 10_000),
  AGENT_PLANNER_TIMEOUT_MS: int(20_000, 100, 120_000),
  AGENT_COMMAND_TIMEOUT_MS: int(5_000, 50, 60_000),
  AGENT_APPROVAL_TIMEOUT_MS: int(120_000, 1_000, 3_600_000),
  AGENT_RUN_TIMEOUT_MS: int(600_000, 1_000, 3_600_000),
  AUDIT_LOG_FILE: z.string().optional(),

  LLM_PROVIDER: z.enum(['none', 'openai-compatible']).default('none'),
  LLM_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('gpt-4o-mini'),
  LLM_TIMEOUT_MS: int(15_000, 500, 120_000),
});

/**
 * @typedef {ReturnType<typeof loadConfig>} Config
 */

/**
 * Parses and validates configuration from environment variables.
 * Empty strings are treated as "unset" so `.env` templates can leave values blank.
 * @param {NodeJS.ProcessEnv} [source]
 */
function loadConfig(source = process.env) {
  /** @type {Record<string, string>} */
  const cleaned = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') cleaned[key] = value;
  }
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  const c = parsed.data;
  return {
    env: c.NODE_ENV,
    port: c.PORT,
    host: c.HOST,
    logLevel: c.LOG_LEVEL,
    trustProxy: parseTrustProxy(c.TRUST_PROXY),
    corsOrigins: c.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    operatorToken: c.OPERATOR_TOKEN,
    rateLimit: { windowMs: c.RATE_LIMIT_WINDOW_MS, max: c.RATE_LIMIT_MAX },
    agent: {
      defaultMode: c.AGENT_DEFAULT_MODE,
      allowExecute: c.AGENT_ALLOW_EXECUTE,
      auditLogFile: c.AUDIT_LOG_FILE,
      limits: {
        maxSteps: c.AGENT_MAX_STEPS,
        stepDelayMs: c.AGENT_STEP_DELAY_MS,
        plannerTimeoutMs: c.AGENT_PLANNER_TIMEOUT_MS,
        commandTimeoutMs: c.AGENT_COMMAND_TIMEOUT_MS,
        approvalTimeoutMs: c.AGENT_APPROVAL_TIMEOUT_MS,
        runTimeoutMs: c.AGENT_RUN_TIMEOUT_MS,
        approvalPolicy: c.AGENT_APPROVAL_POLICY,
      },
    },
    llm: {
      provider: c.LLM_PROVIDER,
      baseUrl: c.LLM_BASE_URL,
      apiKey: c.LLM_API_KEY,
      model: c.LLM_MODEL,
      timeoutMs: c.LLM_TIMEOUT_MS,
    },
  };
}

/**
 * @param {string} value
 * @returns {boolean | number | string}
 */
function parseTrustProxy(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

module.exports = { loadConfig };
