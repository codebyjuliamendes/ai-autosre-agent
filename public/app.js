document.addEventListener('DOMContentLoaded', () => {
    const btnResolve = document.getElementById('btn-resolve');
    const btnReset = document.getElementById('btn-reset');
    const terminal = document.getElementById('terminal-output');
    
    // UI Elements
    const valCpu = document.getElementById('val-cpu');
    const barCpu = document.getElementById('bar-cpu');
    const valStatus = document.getElementById('val-status');
    const processList = document.getElementById('process-list');
    const serviceList = document.getElementById('service-list');
    const statusIndicator = document.querySelector('.status-indicator');

    let eventSource = null;

    function fetchState() {
        fetch('/api/state')
            .then(res => res.json())
            .then(state => updateUI(state));
    }

    function resetEnvironment() {
        if(eventSource) {
            eventSource.close();
            eventSource = null;
        }
        terminal.innerHTML = '<div class="log system">Environment reset. Awaiting manual intervention or AutoSRE trigger...</div>';
        
        fetch('/api/reset', { method: 'POST' })
            .then(() => fetchState())
            .then(() => {
                btnResolve.disabled = false;
                btnResolve.textContent = "Auto-Resolve Incident";
            });
    }

    function updateUI(state) {
        // CPU
        valCpu.textContent = state.cpu + '%';
        barCpu.style.width = state.cpu + '%';
        if (state.cpu > 80) {
            valCpu.className = 'value critical';
            barCpu.className = 'bar critical';
        } else {
            valCpu.className = 'value ok';
            barCpu.className = 'bar ok';
        }

        // Status
        valStatus.textContent = state.status;
        if (state.status.includes('500')) {
            valStatus.className = 'value critical';
            statusIndicator.className = 'status-indicator critical';
        } else {
            valStatus.className = 'value ok';
            statusIndicator.className = 'status-indicator healthy';
        }

        // Processes
        processList.innerHTML = state.processes.map(p => 
            `<li><span>${p.name}</span> <span style="color:#8b949e">PID: ${p.pid}</span></li>`
        ).join('');

        // Services
        serviceList.innerHTML = Object.entries(state.services).map(([name, status]) => 
            `<li><span>${name}</span> <span class="badge ${status}">${status}</span></li>`
        ).join('');
    }

    function startAgent() {
        btnResolve.disabled = true;
        btnResolve.textContent = "Agent Running...";
        terminal.innerHTML = '';
        
        eventSource = new EventSource('/api/agent');
        
        eventSource.addEventListener('message', (e) => {
            const data = JSON.parse(e.data);
            appendLog(data.type, data.text);
        });

        eventSource.addEventListener('update', (e) => {
            const data = JSON.parse(e.data);
            updateUI(data);
        });

        eventSource.addEventListener('error', () => {
            eventSource.close();
            btnResolve.textContent = "Incident Resolved";
        });
    }

    function appendLog(type, text) {
        const div = document.createElement('div');
        div.className = `log ${type}`;
        div.textContent = text;
        terminal.appendChild(div);
        terminal.scrollTop = terminal.scrollHeight;
    }

    btnReset.addEventListener('click', resetEnvironment);
    btnResolve.addEventListener('click', startAgent);

    // Initial load
    fetchState();
});
