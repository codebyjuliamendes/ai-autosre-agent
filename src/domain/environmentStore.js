'use strict';

const env = require('./environment');

/**
 * Holds the single in-memory simulated environment.
 * Always hands out copies so callers cannot mutate the stored state.
 */
class EnvironmentStore {
  constructor() {
    /** @type {import('./environment').EnvironmentState} */
    this.state = env.nominalState();
  }

  get() {
    return env.cloneState(this.state);
  }

  /** @param {import('./environment').EnvironmentState} state */
  set(state) {
    this.state = env.cloneState(state);
  }

  reset() {
    this.state = env.nominalState();
    return this.get();
  }

  injectChaos() {
    this.state = env.chaosState();
    return this.get();
  }
}

module.exports = { EnvironmentStore };
