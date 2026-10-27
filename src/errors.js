'use strict';

/** Error with an HTTP status and a stable machine-readable code. */
class AppError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

class TimeoutError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Rejects with TimeoutError if `promise` does not settle within `ms`.
 * @template T
 * @param {Promise<T> | (() => Promise<T>)} work
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(work, ms, label) {
  const promise = typeof work === 'function' ? Promise.resolve().then(work) : work;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
  });
  return /** @type {Promise<T>} */ (Promise.race([promise, timeout]).finally(() => clearTimeout(timer)));
}

module.exports = { AppError, TimeoutError, withTimeout };
