'use strict';

// All dynamic content is rendered with textContent / DOM APIs (never innerHTML)
// so log lines, process names or LLM output cannot inject markup.
document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);
  const btnResolve = $('btn-resolve');
  const btnReset = $('btn-reset');
  const btnChaos = $('btn-chaos');
  const btnTheme = $('btn-theme');
  const btnAudit = $('btn-audit');
  const modeSelect = $('mode-select');
  const terminal = $('terminal');
  const runStatus = $('run-status');
  const banner = $('banner');
  const tokenForm = $('token-form');
  const tokenInput = $('token-input');

  const TOKEN_KEY = 'autosre-operator-token';
  const THEME_KEY = 'autosre-theme';
  const ACTIVE_STATUSES = new Set(['running', 'awaiting_approval']);

  let eventSource = null;
  let currentRunId = null;
  let busy = false;

  // ---------- helpers ----------
  const storage = {
    get(area, key) {
      try {
        return window[area].getItem(key);
      } catch {
        return null;
      }
    },
    set(area, key, value) {
      try {
        window[area].setItem(key, value);
      } catch {
        /* storage unavailable */
      }
    },
  };

  function el(tag, opts = {}, children = []) {
    const node = document.createElement(tag);
    if (opts.className) node.className = opts.className;
    if (opts.text !== undefined) node.textContent = String(opts.text);
    for (const [k, v] of Object.entries(opts.attrs || {})) node.setAttribute(k, v);
    for (const child of children) node.append(child);
    return node;
  }

  function showToast(message, isError = false) {
    const toast = el('div', {
      className: `toast${isError ? ' is-error' : ''}`,
      text: message,
      attrs: { role: 'status' },
    });
    $('toast-container').append(toast);
    setTimeout(() => toast.remove(), 3500);
  }

  function showBanner(message) {
    banner.textContent = message;
    banner.hidden = !message;
  }

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
    const token = storage.get('sessionStorage', TOKEN_KEY);
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = (data && data.error && data.error.message) || `Request failed (HTTP ${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function reportError(err) {
    if (err.status === 401) {
      tokenForm.hidden = false;
      tokenInput.focus();
    }
    showToast(err.message, true);
  }

  function setBusy(value) {
    busy = value;
    const running = Boolean(currentRunId);
    btnResolve.disabled = busy || running;
    btnReset.disabled = busy;
    btnChaos.disabled = busy;
    modeSelect.disabled = busy || running;
    btnResolve.textContent = running ? 'Agent running...' : 'Run agent';
  }

  function setRunStatus(text) {
    runStatus.textContent = text;
  }

  // ---------- environment ----------
  function renderState(state) {
    const bad = !String(state.status).startsWith('200');
    const cpu = Math.max(0, Math.min(100, Number(state.cpu) || 0));
    $('val-cpu').textContent = `${cpu}%`;
    $('val-cpu').classList.toggle('is-bad', cpu > 80);
    $('bar-cpu').style.width = `${cpu}%`;
    $('bar-cpu').classList.toggle('is-bad', cpu > 80);
    $('bar-cpu-wrap').setAttribute('aria-valuenow', String(cpu));

    $('val-status').textContent = state.status;
    $('val-status').classList.toggle('is-bad', bad);
    const dot = $('status-indicator');
    dot.className = `dot ${bad ? 'dot-bad' : 'dot-ok'}`;
    dot.setAttribute('aria-label', bad ? 'Unhealthy' : 'Healthy');

    const procs = Array.isArray(state.processes) ? state.processes : [];
    $('process-list').replaceChildren(
      ...(procs.length
        ? procs.map((p) =>
            el('li', {}, [el('span', { text: p.name }), el('span', { className: 'meta', text: `PID ${p.pid}` })]),
          )
        : [el('li', { className: 'empty', text: 'No processes' })]),
    );

    const services = Object.entries(state.services || {});
    $('service-list').replaceChildren(
      ...(services.length
        ? services.map(([name, status]) =>
            el('li', {}, [
              el('span', { text: name }),
              el('span', { className: `pill${status === 'running' ? '' : ' is-bad'}`, text: status }),
            ]),
          )
        : [el('li', { className: 'empty', text: 'No services' })]),
    );
  }

  async function fetchState() {
    try {
      renderState(await api('/api/state'));
      showBanner('');
    } catch (err) {
      showBanner(`Could not load server state: ${err.message}`);
    }
  }

  async function envAction(path, successMessage) {
    if (busy) return;
    setBusy(true);
    try {
      const data = await api(path, { method: 'POST' });
      closeStream();
      renderState(data.state);
      clearTerminal('Environment changed. Awaiting operator.');
      showToast(successMessage);
      loadAudit();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  }

  // ---------- terminal ----------
  const PREFIX = { thought: '[Thought]', action: '[Action]', observation: '[Observation]', system: '[System]' };

  function appendLog(type, text) {
    const kind = PREFIX[type] ? type : 'system';
    const line = el('p', { className: `log log-${kind}` }, [el('strong', { text: PREFIX[kind] }), String(text)]);
    terminal.append(line);
    terminal.scrollTop = terminal.scrollHeight;
  }

  function clearTerminal(message) {
    terminal.replaceChildren();
    if (message) appendLog('system', message);
  }

  function appendPendingAction(action) {
    const approve = el('button', { className: 'btn btn-primary btn-sm', text: 'Approve', attrs: { type: 'button' } });
    const reject = el('button', { className: 'btn btn-danger btn-sm', text: 'Reject', attrs: { type: 'button' } });
    const expires = new Date(action.expiresAt);
    const card = el(
      'div',
      { className: 'approval', attrs: { 'data-action-id': action.id, role: 'group', 'aria-label': 'Pending action' } },
      [
        el('p', { className: 'log' }, [
          el('strong', { text: action.destructive ? '[Approval required: destructive]' : '[Approval required]' }),
          el('code', { text: action.command }),
        ]),
        el('p', {
          className: 'hint',
          text: `Mode: ${action.mode}. Auto-rejects at ${Number.isNaN(expires.getTime()) ? '?' : expires.toLocaleTimeString()}.`,
        }),
        el('div', { className: 'actions' }, [approve, reject]),
      ],
    );
    terminal.append(card);
    terminal.scrollTop = terminal.scrollHeight;
    approve.focus({ preventScroll: true });

    const decide = async (approved) => {
      approve.disabled = true;
      reject.disabled = true;
      try {
        await api(`/api/agent/runs/${encodeURIComponent(currentRunId)}/approve`, {
          method: 'POST',
          body: JSON.stringify({ actionId: action.id, approved }),
        });
      } catch (err) {
        reportError(err);
        approve.disabled = false;
        reject.disabled = false;
      }
    };
    approve.addEventListener('click', () => decide(true));
    reject.addEventListener('click', () => decide(false));
  }

  function resolvePendingCard(data) {
    const card = terminal.querySelector(`[data-action-id="${CSS.escape(data.id)}"]`);
    if (!card) return;
    const actions = card.querySelector('.actions');
    if (actions) actions.replaceWith(el('p', { className: 'hint', text: data.approved ? 'Approved.' : 'Rejected.' }));
  }

  function closeStream() {
    if (eventSource) eventSource.close();
    eventSource = null;
    currentRunId = null;
    setRunStatus('idle');
    setBusy(false);
  }

  function parse(e) {
    try {
      return JSON.parse(e.data);
    } catch {
      return null;
    }
  }

  function openStream(runId) {
    currentRunId = runId;
    setBusy(false);
    setRunStatus('running');
    eventSource = new EventSource(`/api/agent/runs/${encodeURIComponent(runId)}/events`);
    eventSource.addEventListener('message', (e) => {
      const data = parse(e);
      if (data) appendLog(data.type, data.text);
    });
    eventSource.addEventListener('update', (e) => {
      const data = parse(e);
      if (data) renderState(data);
    });
    eventSource.addEventListener('pending_action', (e) => {
      const data = parse(e);
      if (!data) return;
      setRunStatus('awaiting approval');
      appendPendingAction(data);
    });
    eventSource.addEventListener('action_resolved', (e) => {
      const data = parse(e);
      if (!data) return;
      setRunStatus('running');
      resolvePendingCard(data);
    });
    eventSource.addEventListener('end', (e) => {
      const data = parse(e) || {};
      closeStream();
      setRunStatus(data.status || 'finished');
      fetchState();
      loadAudit();
    });
    eventSource.addEventListener('error', () => {
      // EventSource reconnects on its own (resuming via Last-Event-ID). Only give
      // up when the run is gone or already finished.
      if (!currentRunId) return;
      api(`/api/agent/runs/${encodeURIComponent(runId)}`)
        .then((run) => {
          if (!ACTIVE_STATUSES.has(run.status)) {
            closeStream();
            setRunStatus(run.status);
          }
        })
        .catch(() => {
          closeStream();
          appendLog('system', 'Lost connection to the agent run.');
        });
    });
  }

  async function startAgent() {
    if (busy || currentRunId) return;
    setBusy(true);
    clearTerminal('');
    try {
      const run = await api('/api/agent/runs', { method: 'POST', body: JSON.stringify({ mode: modeSelect.value }) });
      openStream(run.id);
    } catch (err) {
      reportError(err);
      appendLog('system', `Could not start the agent: ${err.message}`);
      setBusy(false);
    }
  }

  // ---------- audit ----------
  async function loadAudit() {
    const list = $('audit-list');
    try {
      const { entries } = await api('/api/audit?limit=50');
      list.replaceChildren(
        ...(entries.length
          ? entries
              .slice()
              .reverse()
              .map((e) => {
                const command = e.details && e.details.command ? ` ${e.details.command.tool}` : '';
                const operator = e.details && e.details.operator ? ` by ${e.details.operator}` : '';
                return el('li', { text: `${new Date(e.ts).toLocaleTimeString()} ${e.event}${command}${operator}` });
              })
          : [el('li', { className: 'empty', text: 'No audit entries yet.' })]),
      );
    } catch (err) {
      list.replaceChildren(el('li', { className: 'empty', text: `Audit unavailable: ${err.message}` }));
    }
  }

  // ---------- theme & config ----------
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    btnTheme.setAttribute('aria-pressed', String(theme === 'light'));
    btnTheme.textContent = theme === 'light' ? 'Dark theme' : 'Light theme';
  }

  async function loadConfig() {
    try {
      const config = await api('/api/config');
      modeSelect.value = config.defaultMode;
      const execute = modeSelect.querySelector('option[value="execute"]');
      if (!config.allowExecute && execute) {
        execute.disabled = true;
        execute.textContent = 'Execute (disabled on server)';
        modeSelect.value = 'dry-run';
      }
      if (config.authRequired) tokenForm.hidden = false;
    } catch (err) {
      showBanner(`Could not load configuration: ${err.message}`);
    }
  }

  tokenForm.addEventListener('submit', (e) => {
    e.preventDefault();
    storage.set('sessionStorage', TOKEN_KEY, tokenInput.value.trim());
    tokenInput.value = '';
    showToast('Token saved for this tab.');
    loadAudit();
  });
  btnTheme.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    storage.set('localStorage', THEME_KEY, next);
    applyTheme(next);
  });
  btnReset.addEventListener('click', () => envAction('/api/reset', 'Environment reset to nominal state.'));
  btnChaos.addEventListener('click', () => envAction('/api/chaos', 'Chaos injected: the system is failing.'));
  btnResolve.addEventListener('click', startAgent);
  btnAudit.addEventListener('click', loadAudit);

  applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
  loadConfig();
  fetchState();
  loadAudit();
});
