let dashboardState = {
    sessionStart: Date.now(),
    isConnected: false
};

document.addEventListener('DOMContentLoaded', () => {
    initDashboard();

    // Connect to background
    connectToBackground();

    // Listen for updates
    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === 'updateGlobalState') {
            updateDashboard(message.data);
            updateConnectionStatus(true);
        }
    });

    // Initial fetch
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
        if (response) updateDashboard(response);
    });
});

function connectToBackground() {
    // Ping to check connection
    setInterval(() => {
        try {
            chrome.runtime.sendMessage({ type: 'PING' }, (res) => {
                if (chrome.runtime.lastError) updateConnectionStatus(false);
                else updateConnectionStatus(true);
            });
        } catch (e) {
            updateConnectionStatus(false);
        }
    }, 5000);
}

function updateConnectionStatus(connected) {
    if (dashboardState.isConnected === connected) return;
    dashboardState.isConnected = connected;
    const el = document.getElementById('connection-status');
    if (connected) el.classList.add('connected');
    else el.classList.remove('connected');
}

function initDashboard() {
    // Export
    document.getElementById('btn-export').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'EXPORT_DATA' });
    });

    // Clear
    document.getElementById('btn-clear').addEventListener('click', () => {
        if (confirm('This will delete all session data. Continue?')) {
            chrome.runtime.sendMessage({ type: 'CLEAR_SESSION' });
            location.reload();
        }
    });

    // Tags
    document.querySelectorAll('.tag').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tag = e.target.dataset.tag;
            // Highlight button temporarily
            document.querySelectorAll('.tag').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');

            chrome.runtime.sendMessage({
                type: 'MANUAL_TAG',
                data: { tag, timestamp: Date.now() }
            });
            logEvent(`Tagged: ${tag.toUpperCase()}`);
        });
    });

    // Notes
    document.getElementById('btn-add-note').addEventListener('click', addNote);
    document.getElementById('note-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addNote();
    });

    // Global Timer
    setInterval(updateTimer, 1000);
}

function updateDashboard(data) {
    if (!data) return;

    // Load
    const load = Math.round(data.loadHeuristic || 0);
    document.getElementById('metric-load').textContent = `${load}%`;
    document.getElementById('bar-load').style.width = `${load}%`;

    // Colorize load
    const loadEl = document.getElementById('metric-load');
    if (load > 80) loadEl.style.color = '#ff4444';
    else if (load > 50) loadEl.style.color = '#ffcc00';
    else loadEl.style.color = 'var(--ee-white)';

    // Metrics
    document.getElementById('metric-wpm').textContent = Math.round(data.wpm || 0);
    document.getElementById('metric-cr').textContent = `${Math.round((data.correctionRate || 0) * 100)}%`;

    // These might come from different parts of the data object depending on aggregation
    // Assuming data contains most recent aggregate info if available

    // Update Warnings
    const warningsPanel = document.getElementById('warnings-panel');
    const warningsList = document.getElementById('active-warnings');
    if (data.warning_signals && data.warning_signals.length > 0) {
        warningsPanel.style.display = 'block';
        warningsList.innerHTML = data.warning_signals.map(w =>
            `<span class="ee-button danger" style="padding: 4px 10px; font-size: 0.7em;">${w.replace(/_/g, ' ')}</span>`
        ).join('');
    } else {
        warningsPanel.style.display = 'none';
    }

    // Stats
    document.getElementById('stat-events').textContent = data.total_keystrokes || 0;
    document.getElementById('stat-interactions').textContent = (data.total_keystrokes || 0) + (data.total_corrections || 0);

    // Sync Timer Start if available
    if (data.session_duration) {
        // rough sync relies on local timer mostly
    }
}

function addNote() {
    const input = document.getElementById('note-input');
    const note = input.value.trim();
    if (note) {
        chrome.runtime.sendMessage({
            type: 'MANUAL_TAG',
            data: { tag: 'NOTE', note, timestamp: Date.now() }
        });
        logEvent(`Note: ${note}`);
        input.value = '';
    }
}

function logEvent(msg) {
    const log = document.getElementById('event-log');
    const div = document.createElement('div');
    div.className = 'ee-log-entry';
    div.innerHTML = `<span>${msg}</span><span>${new Date().toLocaleTimeString()}</span>`;
    log.prepend(div);
}

function updateTimer() {
    // Assuming start time is roughly when page loaded or we could sync with bg
    // For now, let's just increment based on page open time as a fallback
    if (!dashboardState.sessionStart) return;

    const diff = Date.now() - dashboardState.sessionStart;
    const h = Math.floor(diff / 3600000).toString().padStart(2, '0');
    const m = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0');
    const s = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
    document.getElementById('session-time').textContent = `${h}:${m}:${s}`;
    document.getElementById('stat-duration').textContent = `${m}m ${s}s`;
}