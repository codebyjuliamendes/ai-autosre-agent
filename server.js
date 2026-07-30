/**
 * @file server.js
 * @description AutoSRE DevOps Agent - Backend Service
 * Applies Clean Architecture, error handling, and JSDoc typings.
 */

const express = require('express');
const path = require('path');

const app = express();
const port = process.env.PORT || 4002;

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

/**
 * Service to manage the server state
 */
class StateService {
    /** @type {ServerState} */
    #state;

    constructor() {
        this.reset();
    }

    /**
     * Resets the state to the initial incident state.
     */
    reset() {
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

    /**
     * Gets the current state
     * @returns {ServerState}
     */
    getState() {
        return this.#state;
    }

    /**
     * Updates the state with new partial data
     * @param {Partial<ServerState>} newState 
     */
    updateState(newState) {
        this.#state = { ...this.#state, ...newState };
    }
}

const stateService = new StateService();

/**
 * Controller for State endpoints
 */
class StateController {
    /**
     * @param {express.Request} req 
     * @param {express.Response} res 
     * @param {express.NextFunction} next 
     */
    static getState(req, res, next) {
        try {
            res.json(stateService.getState());
        } catch (error) {
            next(error);
        }
    }

    /**
     * @param {express.Request} req 
     * @param {express.Response} res 
     * @param {express.NextFunction} next 
     */
    static resetState(req, res, next) {
        try {
            stateService.reset();
            res.json({ message: 'State reset successfully', state: stateService.getState() });
        } catch (error) {
            next(error);
        }
    }
}

/**
 * Controller for the Agent SSE
 */
class AgentController {
    /**
     * Handles the SSE connection and agent loop
     * @param {express.Request} req 
     * @param {express.Response} res 
     * @param {express.NextFunction} next 
     */
    static async runAgent(req, res, next) {
        try {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            const sendEvent = (type, data) => {
                res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
            };

            const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

            const agentLogic = async () => {
                const state = stateService.getState();

                sendEvent('message', { type: 'system', text: 'Initializing AutoSRE DevOps Agent v9.0...' });
                await sleep(1000);
                sendEvent('message', { type: 'system', text: 'Connecting to target server environment...' });
                await sleep(1000);

                // Step 1
                sendEvent('message', { type: 'thought', text: 'The server is throwing 500 errors. I should check the nginx error log to identify the root cause.' });
                await sleep(1500);
                sendEvent('message', { type: 'action', text: 'call read_log("nginx_error.log")' });
                await sleep(1000);
                sendEvent('message', { type: 'observation', text: state.logs['nginx_error.log'] });
                await sleep(2000);

                // Step 2
                sendEvent('message', { type: 'thought', text: 'The database is down (Connection refused). I should check running processes to see if postgres is running and investigate overall system health.' });
                await sleep(1500);
                sendEvent('message', { type: 'action', text: 'call list_processes()' });
                await sleep(1000);
                sendEvent('message', { type: 'observation', text: JSON.stringify(state.processes) });
                await sleep(2000);

                // Step 3
                sendEvent('message', { type: 'thought', text: 'Postgres is not in the process list, but a rogue process "cryptominer_xmrig" (PID 1337) is running, likely causing the 99% CPU usage.' });
                await sleep(1500);
                sendEvent('message', { type: 'action', text: 'call kill_process(1337)' });
                await sleep(1000);
                
                // Execute action
                const updatedProcesses = state.processes.filter(p => p.pid !== 1337);
                stateService.updateState({ processes: updatedProcesses, cpu: 15 });
                
                sendEvent('update', stateService.getState());
                sendEvent('message', { type: 'observation', text: 'Process 1337 killed successfully.' });
                await sleep(2000);

                // Step 4
                sendEvent('message', { type: 'thought', text: 'Now that the CPU is freed up, I need to start the postgres database service.' });
                await sleep(1500);
                sendEvent('message', { type: 'action', text: 'call restart_service("postgres")' });
                await sleep(1000);

                // Execute action
                const newState = stateService.getState();
                const newServices = { ...newState.services, postgres: 'running' };
                const newProcs = [...newState.processes, { pid: 5432, name: 'postgres' }];
                
                stateService.updateState({ services: newServices, processes: newProcs, status: '200 OK' });
                
                sendEvent('update', stateService.getState());
                sendEvent('message', { type: 'observation', text: 'Service postgres restarted successfully.' });
                await sleep(2000);

                // Step 5
                sendEvent('message', { type: 'thought', text: 'The database is running and CPU is stable. The 500 errors should be resolved.' });
                await sleep(1500);
                sendEvent('message', { type: 'action', text: 'call verify_health()' });
                await sleep(1000);
                sendEvent('message', { type: 'observation', text: 'HTTP 200 OK - All systems nominal.' });
                await sleep(1000);
                sendEvent('message', { type: 'system', text: 'Incident resolved. Agent terminating.' });
                
                res.end();
            };

            await agentLogic();

        } catch (error) {
            next(error);
        }
    }
}

// Routes
app.get('/api/state', StateController.getState);
app.post('/api/reset', StateController.resetState);
app.get('/api/agent', AgentController.runAgent);

// Error Middleware
app.use((err, req, res, next) => {
    console.error('Unhandled Error:', err);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

app.listen(port, () => {
    console.log(`AutoSRE listening on port ${port}`);
});
