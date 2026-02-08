import '/lib/filesystem.js';

let currentState = {
    metrics: {
        cognitiveLoad: 0,
        wpm: 0,
        entropy: 0,
        stability: 0
    },
    state: 'NEUTRAL',
    warnings: [],
    sessionStart: Date.now()
};

// Keep Alive
const keepAlive = () => {
    setInterval(() => {
        chrome.runtime.getPlatformInfo(() => { });
    }, 20000);
};
keepAlive();

chrome.runtime.onInstalled.addListener(() => {
    console.log('CSCS Lite Installed');
    chrome.storage.local.set({ currentState });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case 'METRIC_UPDATE':
            handleMetricUpdate(message.data);
            break;
        case 'GET_STATE':
            sendResponse(currentState);
            break;
        case 'MANUAL_TAG':
            handleManualTag(message.data);
            break;
        case 'EXPORT_DATA':
            FileSystem.exportData();
            break;
        case 'CLEAR_SESSION':
            currentState = {
                metrics: { cognitiveLoad: 0, wpm: 0, entropy: 0, stability: 0 },
                state: 'NEUTRAL',
                warnings: [],
                sessionStart: Date.now()
            };
            chrome.storage.local.set({ currentState });
            chrome.runtime.sendMessage({ type: 'STATE_UPDATE', data: currentState });
            break;
    }
    return true;
});

function handleMetricUpdate(data) {
    currentState.metrics = { ...currentState.metrics, ...data };

    // Simple state logic
    if (data.cognitiveLoad > 80) currentState.state = 'OVERLOAD';
    else if (data.wpm > 40 && data.stability > 0.8) currentState.state = 'FLOW';
    else currentState.state = 'NEUTRAL';

    // Broadcast
    chrome.runtime.sendMessage({ type: 'STATE_UPDATE', data: currentState }).catch(() => { });
    chrome.storage.local.set({ currentState });

    // Log to FS
    FileSystem.saveRecord('metric', data);
}

function handleManualTag(data) {
    const warning = {
        message: `Tag użytkownika: ${data.tag}`,
        timestamp: Date.now()
    };
    currentState.warnings.push(warning);
    FileSystem.saveRecord('tag', data);
    chrome.runtime.sendMessage({ type: 'STATE_UPDATE', data: currentState }).catch(() => { });
}
