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
    const statusIndicator = document.getElementById('status-indicator');

    let eventSource = null;

    function fetchState() {
        fetch('/api/state')
            .then(res => res.json())
            .then(state => updateUI(state))
            .catch(err => console.error("Error fetching state:", err));
    }

    function resetEnvironment() {
        if(eventSource) {
            eventSource.close();
            eventSource = null;
        }
        terminal.innerHTML = '<div class="log-system">Environment reset. Awaiting manual intervention or AutoSRE trigger...</div>';
        
        fetch('/api/reset', { method: 'POST' })
            .then(() => fetchState())
            .then(() => {
                btnResolve.disabled = false;
                btnResolve.textContent = "Auto-Resolve Incident";
                btnResolve.className = "px-4 py-2 bg-matrix-green text-black font-bold hover:bg-white hover:text-black transition-colors duration-300";
            })
            .catch(err => console.error("Error resetting state:", err));
    }

    function updateUI(state) {
        // CPU
        valCpu.textContent = state.cpu + '%';
        barCpu.style.width = state.cpu + '%';
        if (state.cpu > 80) {
            valCpu.className = 'text-3xl font-bold text-matrix-red mb-2';
            barCpu.className = 'bg-matrix-red h-2 rounded-full transition-all duration-500';
        } else {
            valCpu.className = 'text-3xl font-bold text-matrix-green mb-2';
            barCpu.className = 'bg-matrix-green h-2 rounded-full transition-all duration-500';
        }

        // Status
        valStatus.textContent = state.status;
        if (state.status.includes('500')) {
            valStatus.className = 'text-xl font-bold text-matrix-red mt-2';
            statusIndicator.className = 'w-3 h-3 rounded-full status-indicator bg-matrix-red animate-ping';
        } else {
            valStatus.className = 'text-xl font-bold text-matrix-green mt-2';
            statusIndicator.className = 'w-3 h-3 rounded-full status-indicator bg-matrix-green shadow-[0_0_10px_#00ff41]';
        }

        // Processes
        processList.innerHTML = state.processes.map(p => 
            `<li class="flex justify-between items-center py-1 border-b border-matrix-green/10">
                <span class="text-gray-300">${p.name}</span>
                <span class="text-xs text-matrix-green/50">PID: ${p.pid}</span>
             </li>`
        ).join('');

        // Services
        serviceList.innerHTML = Object.entries(state.services).map(([name, status]) => {
            const isRunning = status === 'running';
            const badgeClass = isRunning 
                ? 'bg-matrix-green/20 text-matrix-green border-matrix-green/50' 
                : 'bg-matrix-red/20 text-matrix-red border-matrix-red/50';
            return `<li class="flex justify-between items-center py-1 border-b border-matrix-green/10">
                        <span class="text-gray-300">${name}</span> 
                        <span class="text-xs px-2 py-0.5 rounded border ${badgeClass}">${status}</span>
                    </li>`;
        }).join('');
    }

    function startAgent() {
        btnResolve.disabled = true;
        btnResolve.textContent = "Agent Running...";
        btnResolve.className = "px-4 py-2 border border-matrix-green text-matrix-green opacity-50 cursor-not-allowed";
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
            btnResolve.className = "px-4 py-2 bg-matrix-green text-black font-bold";
        });
    }

    function appendLog(type, text) {
        const div = document.createElement('div');
        div.className = `log-${type} mb-1 opacity-0 animate-[fadeIn_0.5s_forwards]`;
        
        const prefix = type === 'thought' ? '💡 [Thought]' : 
                       type === 'action' ? '⚡ [Action]' : 
                       type === 'observation' ? '👁️ [Observation]' : '⚙️ [System]';
                       
        div.textContent = `${prefix} ${text}`;
        terminal.appendChild(div);
        terminal.scrollTop = terminal.scrollHeight;
    }

    btnReset.addEventListener('click', resetEnvironment);
    btnResolve.addEventListener('click', startAgent);

    // Initial load
    fetchState();
});
