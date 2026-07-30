document.addEventListener('DOMContentLoaded', () => {
    const btnResolve = document.getElementById('btn-resolve');
    const btnReset = document.getElementById('btn-reset');
    const terminal = document.getElementById('terminal-output');
    const bootSkeleton = document.getElementById('boot-skeleton');
    
    // UI Elements
    const valCpu = document.getElementById('val-cpu');
    const barCpu = document.getElementById('bar-cpu');
    const valStatus = document.getElementById('val-status');
    const processList = document.getElementById('process-list');
    const serviceList = document.getElementById('service-list');
    const statusIndicator = document.getElementById('status-indicator');

    let eventSource = null;

    // Initialize Icons
    lucide.createIcons();

    function showToast(message, type = 'success') {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        const icon = type === 'success' ? 'check-circle' : 'info';
        toast.className = `glass-panel text-white px-4 py-3 rounded shadow-lg flex items-center gap-3 transform transition-all duration-300 translate-y-10 opacity-0`;
        toast.innerHTML = `<i data-lucide="${icon}" class="w-5 h-5 ${type === 'success' ? 'text-matrix-green' : 'text-blue-400'}"></i> <span>${message}</span>`;
        
        container.appendChild(toast);
        lucide.createIcons({ root: toast });
        
        requestAnimationFrame(() => {
            toast.classList.remove('translate-y-10', 'opacity-0');
        });

        setTimeout(() => {
            toast.classList.add('translate-y-10', 'opacity-0');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

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
        
        Array.from(terminal.children).forEach(c => {
            if (c.id !== 'boot-skeleton') c.remove();
        });
        appendLog('system', 'Environment reset. Awaiting manual intervention or AutoSRE trigger...');
        
        fetch('/api/reset', { method: 'POST' })
            .then(() => fetchState())
            .then(() => {
                btnResolve.disabled = false;
                btnResolve.textContent = "Auto-Resolve Incident";
                btnResolve.className = "px-4 py-2 bg-matrix-green text-black font-bold hover:bg-white hover:text-black transition-colors duration-300";
                showToast("Environment reset successfully", "success");
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
        
        Array.from(terminal.children).forEach(c => {
            if (c.id !== 'boot-skeleton') c.remove();
        });
        
        bootSkeleton.classList.remove('hidden');
        showToast("Booting AutoSRE Agent...", "info");
        
        setTimeout(() => {
            bootSkeleton.classList.add('hidden');
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
                showToast("Incident Resolved Successfully", "success");
            });
        }, 1500);
    }

    function appendLog(type, text) {
        const div = document.createElement('div');
        div.className = `log-${type} mb-1 opacity-0 animate-[fadeIn_0.5s_forwards] flex items-start gap-2`;
        
        let iconHtml = '';
        let prefix = '';
        if (type === 'thought') {
            iconHtml = '<i data-lucide="brain" class="w-4 h-4 mt-0.5"></i>';
            prefix = '[Thought]';
        } else if (type === 'action') {
            iconHtml = '<i data-lucide="zap" class="w-4 h-4 mt-0.5"></i>';
            prefix = '[Action]';
        } else if (type === 'observation') {
            iconHtml = '<i data-lucide="eye" class="w-4 h-4 mt-0.5"></i>';
            prefix = '[Observation]';
        } else {
            iconHtml = '<i data-lucide="settings" class="w-4 h-4 mt-0.5"></i>';
            prefix = '[System]';
        }
                       
        div.innerHTML = `${iconHtml} <span><strong>${prefix}</strong> ${text}</span>`;
        terminal.appendChild(div);
        lucide.createIcons({ root: div });
        terminal.scrollTop = terminal.scrollHeight;
    }

    btnReset.addEventListener('click', resetEnvironment);
    btnResolve.addEventListener('click', startAgent);

    // Initial load
    fetchState();
});
