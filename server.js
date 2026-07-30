const express = require('express');
const path = require('path');
const app = express();
const port = process.env.PORT || 4002;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let serverState = {
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

function resetState() {
    serverState = {
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

app.get('/api/state', (req, res) => {
    res.json(serverState);
});

app.post('/api/reset', (req, res) => {
    resetState();
    res.json({ message: 'State reset' });
});

// SSE endpoint for agent
app.get('/api/agent', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendEvent = (type, data) => {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    (async () => {
        sendEvent('message', { type: 'system', text: 'Initializing AutoSRE DevOps Agent v9.0...' });
        await sleep(1000);
        sendEvent('message', { type: 'system', text: 'Connecting to target server environment...' });
        await sleep(1000);

        // Step 1
        sendEvent('message', { type: 'thought', text: 'The server is throwing 500 errors. I should check the nginx error log to identify the root cause.' });
        await sleep(1500);
        sendEvent('message', { type: 'action', text: 'call read_log("nginx_error.log")' });
        await sleep(1000);
        sendEvent('message', { type: 'observation', text: serverState.logs['nginx_error.log'] });
        await sleep(2000);

        // Step 2
        sendEvent('message', { type: 'thought', text: 'The database is down (Connection refused). I should check running processes to see if postgres is running and investigate overall system health.' });
        await sleep(1500);
        sendEvent('message', { type: 'action', text: 'call list_processes()' });
        await sleep(1000);
        sendEvent('message', { type: 'observation', text: JSON.stringify(serverState.processes) });
        await sleep(2000);

        // Step 3
        sendEvent('message', { type: 'thought', text: 'Postgres is not in the process list, but a rogue process "cryptominer_xmrig" (PID 1337) is running, likely causing the 99% CPU usage.' });
        await sleep(1500);
        sendEvent('message', { type: 'action', text: 'call kill_process(1337)' });
        await sleep(1000);
        
        // Execute tool
        serverState.processes = serverState.processes.filter(p => p.pid !== 1337);
        serverState.cpu = 15; // CPU drops
        sendEvent('update', serverState);
        sendEvent('message', { type: 'observation', text: 'Process 1337 killed successfully.' });
        await sleep(2000);

        // Step 4
        sendEvent('message', { type: 'thought', text: 'Now that the CPU is freed up, I need to start the postgres database service.' });
        await sleep(1500);
        sendEvent('message', { type: 'action', text: 'call restart_service("postgres")' });
        await sleep(1000);

        // Execute tool
        serverState.services.postgres = 'running';
        serverState.processes.push({ pid: 5432, name: 'postgres' });
        serverState.status = '200 OK'; // Server recovers
        sendEvent('update', serverState);
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
    })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AutoSRE listening on port ${PORT}`));
