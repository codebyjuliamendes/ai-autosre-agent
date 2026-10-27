'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Append-only audit trail of everything the agent proposes and does, and of
 * every human decision. Entries are:
 *   - kept in a bounded in-memory ring buffer (served by GET /api/audit);
 *   - written to the structured logger;
 *   - optionally appended as JSON Lines to AUDIT_LOG_FILE for durable storage.
 *
 * @typedef {Object} AuditEntry
 * @property {number} seq
 * @property {string} ts - ISO 8601 timestamp (UTC)
 * @property {string} event
 * @property {string} [runId]
 * @property {Record<string, unknown>} [details]
 */

class AuditLog {
  /**
   * @param {{ logger: import('pino').Logger, filePath?: string, maxEntries?: number, now?: () => Date }} options
   */
  constructor({ logger, filePath, maxEntries = 1000, now = () => new Date() }) {
    this.logger = logger;
    this.maxEntries = maxEntries;
    this.now = now;
    /** @type {AuditEntry[]} */
    this.entries = [];
    this.seq = 0;
    /** @type {fs.WriteStream | null} */
    this.stream = null;
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      this.stream = fs.createWriteStream(filePath, { flags: 'a', mode: 0o640 });
      this.stream.on('error', (err) => this.logger.error({ err }, 'audit file write failed'));
    }
  }

  /**
   * @param {string} event
   * @param {{ runId?: string } & Record<string, unknown>} [details]
   * @returns {AuditEntry}
   */
  record(event, details = {}) {
    const { runId, ...rest } = details;
    /** @type {AuditEntry} */
    const entry = { seq: ++this.seq, ts: this.now().toISOString(), event, ...(runId ? { runId } : {}), details: rest };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    this.logger.info({ audit: entry }, `audit: ${event}`);
    if (this.stream) this.stream.write(`${JSON.stringify(entry)}\n`);
    return entry;
  }

  /**
   * @param {{ limit?: number, runId?: string }} [filter]
   * @returns {AuditEntry[]}
   */
  list({ limit = 100, runId } = {}) {
    const items = runId ? this.entries.filter((e) => e.runId === runId) : this.entries;
    return items.slice(-limit);
  }

  /** @returns {Promise<void>} */
  close() {
    const { stream } = this;
    if (!stream) return Promise.resolve();
    this.stream = null;
    return new Promise((resolve) => stream.end(resolve));
  }
}

module.exports = { AuditLog };
