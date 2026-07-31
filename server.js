/**
 * @file server.js
 * @description AutoSRE DevOps Agent - Backend Service
 * Applies Clean Architecture, error handling, and JSDoc typings.
 */

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');

const app = express();
const port = process.env.PORT || 4002;

app.use(helmet());
app.use(cors());
app.use(compression());

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/**
 * @typedef {Object} ProcessInfo
 * @property {number} pid - Process ID
 * @property {string} name - Process name
 */

/**
 * @typedef {Object} ServerState
 * @property {number} cpu - CPU usage percentage
 * @property {string} status - HTTP status string
 * @property {ProcessInfo[]} processes - List of running processes
 * @property {Record<string, string>} logs - System logs
 * @property {Record<string, string>} services - Service statuses
 */

class StateService {
    /** @type {ServerState} */
    #state;

    constructor() {
        this.reset();
    }

    /**
     * Resets the state to the nominal state.
     */
    reset() {
        this.#state = {
            cpu: 10,
            status: '200 OK',
            processes: [
                { pid: 1, name: 'init' },
                { pid: 80, name: 'nginx' },
                { pid: 5432, name: 'postgres' }
            ],
            logs: {
                'nginx_error.log': '',
                'syslog': 'System nominal.'
            },
            services: {
                'nginx': 'running',
                'postgres': 'running'
            }
        };
    }

    /**
     * Introduces chaos (bad state)
     */
    triggerChaos() {
        this.#state = {
            cpu: 99,
            status: '500 Internal Server Error',
            processes: [
                { pid: 1, name: 'init' },
                { pid: 80, name: 'nginx' },
                { pid: 1337, name: 'cryptominer_xmrig' }
            ],
            logs: {
                'nginx_error.log': '[error] 80#80: *1 connect() to 127.0.0.1:5432 failed (Connection refused) - Database is unreachable.',
                'syslog': 'High CPU usage detected on PID 1337.'
            },
            services: {
                'nginx': 'running',
                'postgres': 'stopped'
            }
        };
    }

    getState() {
        return this.#state;
    }

    updateState(newState) {
        this.#state = { ...this.#state, ...newState };
    }
}

const stateService = new StateService();

// Safe Whitelisted Commands Sandbox
const COMMAND_WHITELIST = new Set([
    'read_log("nginx_error.log")',
    'list_processes()',
    'kill_process(1337)',
    'restart_service("postgres")',
    'verify_health()'
]);

class CommandSandbox {
    static execute(command) {
        if (!COMMAND_WHITELIST.has(command)) {
            throw new Error(`Command "${command}" is blocked by security guardrails (not whitelisted).`);
        }
        
        const state = stateService.getState();
        
        if (command === 'read_log("nginx_error.log")') {
            return state.logs['nginx_error.log'] || 'Empty log';
        } else if (command === 'list_processes()') {
            return JSON.stringify(state.processes);
        } else if (command === 'kill_process(1337)') {
            const updatedProcesses = state.processes.filter(p => p.pid !== 1337);
            stateService.updateState({ processes: updatedProcesses, cpu: 15 });
            return 'Process 1337 killed successfully.';
        } else if (command === 'restart_service("postgres")') {
            const newServices = { ...state.services, postgres: 'running' };
            const newProcs = [...state.processes, { pid: 5432, name: 'postgres' }];
            stateService.updateState({ services: newServices, processes: newProcs, status: '200 OK' });
            return 'Service postgres restarted successfully.';
        } else if (command === 'verify_health()') {
            return state.status === '200 OK' ? 'HTTP 200 OK - All systems nominal.' : 'HTTP 500 - System failure';
        }
    }
}

// Simple Circuit Breaker logic simulation for the agent controller
class CircuitBreaker {
    constructor(action, failureThreshold = 3) {
        this.action = action;
        this.failureCount = 0;
        this.failureThreshold = failureThreshold;
    }
    
    async fire(...args) {
        if (this.failureCount >= this.failureThreshold) {
            throw new Error('Circuit Breaker is OPEN');
        }
        try {
            return await this.action(...args);
        } catch (e) {
            this.failureCount++;
            throw e;
        }
    }
}

// Global Agent State for HITL (Human-in-the-loop)
const agentSession = {
    sseRes: null,
    pendingActionId: null,
    resolveAction: null
};

class AgentController {
    static async approveAction(req, res, next) {
        try {
            const { id, approved } = req.body;
            if (agentSession.pendingActionId === id && agentSession.resolveAction) {
                agentSession.resolveAction(approved);
                agentSession.pendingActionId = null;
                agentSession.resolveAction = null;
                res.json({ success: true });
            } else {
                res.status(400).json({ error: 'No such pending action or already resolved.' });
            }
        } catch (error) {
            next(error);
        }
    }

    static async runAgent(req, res, next) {
        try {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            agentSession.sseRes = res;

            const sendEvent = (type, data) => {
                if(agentSession.sseRes) {
                    agentSession.sseRes.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
                }
            };

            const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
            
            const agentReActLoop = async () => {
                sendEvent('message', { type: 'system', text: 'Initializing AutoSRE DevOps Agent v9.0...' });
                await sleep(500);

                const plan = [
                    { t: 'The server is throwing 500 errors. I should check the nginx error log.', a: 'read_log("nginx_error.log")' },
                    { t: 'The database is down. I should check running processes.', a: 'list_processes()' },
                    { t: 'Postgres is missing. A rogue process "cryptominer_xmrig" (PID 1337) is running.', a: 'kill_process(1337)' },
                    { t: 'CPU is freed. I need to start the postgres database service.', a: 'restart_service("postgres")' },
                    { t: 'Systems restarted. I should verify health.', a: 'verify_health()' }
                ];

                for (let i = 0; i < plan.length; i++) {
                    const step = plan[i];
                    
                    sendEvent('message', { type: 'thought', text: step.t });
                    await sleep(1000);
                    
                    const actionId = `act_${Date.now()}_${i}`;
                    // Send pending action to UI for Human-In-The-Loop
                    sendEvent('pending_action', { id: actionId, command: step.a });
                    
                    // Wait for human approval
                    const approved = await new Promise(resolve => {
                        agentSession.pendingActionId = actionId;
                        agentSession.resolveAction = resolve;
                    });
                    
                    if (!approved) {
                        sendEvent('message', { type: 'system', text: `Action rejected by operator: ${step.a}` });
                        sendEvent('message', { type: 'system', text: 'Agent terminating due to rejection.' });
                        return;
                    }
                    
                    sendEvent('message', { type: 'action', text: `call ${step.a}` });
                    await sleep(500);
                    
                    try {
                        const obs = CommandSandbox.execute(step.a);
                        sendEvent('message', { type: 'observation', text: obs });
                        sendEvent('update', stateService.getState());
                    } catch (e) {
                        sendEvent('message', { type: 'system', text: `Error: ${e.message}` });
                        return;
                    }
                    
                    await sleep(1000);
                }

                sendEvent('message', { type: 'system', text: 'Incident resolved. Agent terminating.' });
                res.end();
                agentSession.sseRes = null;
            };

            const cb = new CircuitBreaker(agentReActLoop);
            cb.fire().catch(err => {
                sendEvent('message', { type: 'system', text: `Fatal Error: ${err.message}` });
                res.end();
            });

        } catch (error) {
            next(error);
        }
    }
}

class StateController {
    static getState(req, res, next) {
        try {
            res.json(stateService.getState());
        } catch (error) {
            next(error);
        }
    }

    static resetState(req, res, next) {
        try {
            stateService.reset();
            res.json({ message: 'State reset successfully', state: stateService.getState() });
        } catch (error) {
            next(error);
        }
    }

    static triggerChaos(req, res, next) {
        try {
            stateService.triggerChaos();
            res.json({ message: 'Chaos injected!', state: stateService.getState() });
        } catch (error) {
            next(error);
        }
    }
}

// Routes
app.get('/api/state', StateController.getState);
app.post('/api/reset', StateController.resetState);
app.post('/api/chaos', StateController.triggerChaos);
app.get('/api/agent', AgentController.runAgent);
app.post('/api/agent/approve', AgentController.approveAction);

// Error Middleware
app.use((err, req, res, next) => {
    console.error('Unhandled Error:', err);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

app.listen(port, () => {
    console.log(`AutoSRE listening on port ${port}`);
});
