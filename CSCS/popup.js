document.addEventListener('DOMContentLoaded', () => {
    // Buttons
    document.getElementById('btn-dashboard').addEventListener('click', () => {
        chrome.tabs.create({ url: 'dashboard.html' });
    });

    document.getElementById('btn-tag-focus').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'MANUAL_TAG', data: { tag: 'focus' } });
    });

    document.getElementById('btn-tag-stress').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'MANUAL_TAG', data: { tag: 'stress' } });
    });

    // Updates
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'STATE_UPDATE') {
            updateUI(message.data);
        }
    });

    // Initialize
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
        if (response) updateUI(response);
    });
});

function updateUI(data) {
    document.getElementById('main-metric').textContent = `${Math.round(data.metrics?.cognitiveLoad || 0)}%`;
    document.getElementById('metric-wpm').textContent = Math.round(data.metrics?.wpm || 0);
    document.getElementById('metric-flow').textContent = data.state === 'FLOW' ? 'ON' : 'OFF';

    document.getElementById('connection-status').classList.toggle('active', true);
}