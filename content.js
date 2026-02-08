class CognitiveStateControlSystem {
    constructor() {
        this.sessionId = this.generateSessionId();
        this.dataBuffer = [];
        this.aggregates = {};
        this.isRecording = true;
        this.fs = FileSystem;
        this.fs.setSessionId(this.sessionId);
        this.HISTORY_LIMITS = {
            keyEvents: 10000,
            mouseEvents: 5000,
            focusEvents: 100,
            scrollEvents: 500,
            bufferStats: 1000,
            cursorPositions: 1000,
            aggregates_5s: 720,
            aggregates_30s: 120,
            aggregates_60s: 60
        };
        this.sessionState = {
            session_start_time: Date.now(),
            last_activity_time: Date.now(),
            last_save_time: Date.now(),
            cumulative_keystrokes: 0,
            cumulative_clicks: 0,
            cumulative_corrections: 0,
            total_key_events: 0,
            total_mouse_events: 0,
            periods_truncated: 0
        };
        this.eventHistory = {
            keyEvents: [],
            mouseEvents: [],
            focusEvents: [],
            scrollEvents: []
        };
        this.bufferStats = {
            lastKeyTime: null,
            lastMouseTime: null,
            keyBuffer: [],
            mouseBuffer: [],
            pauseBuffer: []
        };
        this.temporalAggregates = {
            windows: {
                '5s': { start: Date.now(), data: [] },
                '30s': { start: Date.now(), data: [] },
                '60s': { start: Date.now(), data: [] }
            }
        };
        this.cognitiveLoops = {
            cursorPositions: new Map(),
            editRegions: new Map(),
            activeLoops: []
        };
        this.realtimeMetrics = {
            lastUpdate: Date.now(),
            keystrokes: 0,
            corrections: 0,
            wpm: 0,
            correctionRate: 0,
            loadHeuristic: 0
        };
        this.eventBuffer = {
            keys: [],
            mouse: [],
            aggregator: null
        };
        this.lastGlobalUpdate = 0;
        this.updateBackgroundInterval = null;
        this.initializeTracking();
        this.startAggregationTimers();
        this.setupAutoSave();
        this.startBackgroundUpdates();
    }
    generateSessionId() {
        return `cscs_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    initializeTracking() {
        const options = { passive: true, capture: true };
        document.addEventListener('keydown', this.handleKeyDown.bind(this), options);
        document.addEventListener('keyup', this.handleKeyUp.bind(this), options);
        let lastMouseEvent = 0;
        document.addEventListener('mousemove', (e) => {
            if (!this.isRecording) return;
            const now = Date.now();
            if (now - lastMouseEvent < 100) return;
            lastMouseEvent = now;
            this.handleMouseMove(e);
        }, options);
        document.addEventListener('mousedown', this.handleMouseDown.bind(this), options);
        document.addEventListener('mouseup', this.handleMouseUp.bind(this), options);
        document.addEventListener('click', this.handleClick.bind(this), options);
        document.addEventListener('scroll', this.handleScroll.bind(this), options);
        window.addEventListener('focus', this.handleFocusIn.bind(this));
        window.addEventListener('blur', this.handleFocusOut.bind(this));
        window.addEventListener('beforeunload', () => {
            this.saveAllData();
            this.stopBackgroundUpdates();
        });
    }
    handleKeyDown(event) {
        if (!this.isRecording) return;
        const timestamp = Date.now();
        const keyData = this.extractKeyData(event, timestamp, 'keydown');
        this.eventHistory.keyEvents.push(keyData);
        this.sessionState.total_key_events++;
        this.bufferStats.keyBuffer.push({
            time: timestamp,
            type: 'keydown',
            key: keyData.key_code,
            isCorrection: keyData.is_backspace || keyData.is_delete
        });
        this.sessionState.last_activity_time = timestamp;
        this.sessionState.cumulative_keystrokes++;
        this.realtimeMetrics.keystrokes++;
        if (keyData.is_backspace || keyData.is_delete) {
            this.sessionState.cumulative_corrections++;
            this.realtimeMetrics.corrections++;
        }
        this.fs.saveRecord('raw_keydown', keyData);
        if (this.eventHistory.keyEvents.length > this.HISTORY_LIMITS.keyEvents * 1.1) {
            this.trimEventHistory('keyEvents');
        }
        if (this.bufferStats.keyBuffer.length > this.HISTORY_LIMITS.bufferStats) {
            this.bufferStats.keyBuffer = this.bufferStats.keyBuffer.slice(-this.HISTORY_LIMITS.bufferStats);
        }
        this.scheduleBackgroundUpdate();
    }
    handleKeyUp(event) {
        if (!this.isRecording) return;
        const timestamp = Date.now();
        const keyData = this.extractKeyData(event, timestamp, 'keyup');
        const keydownEvent = this.eventHistory.keyEvents.findLast(
            e => e.key_code === keyData.key_code && e.event_type === 'keydown'
        );
        if (keydownEvent) {
            const holdTime = timestamp - keydownEvent.timestamp;
            keyData.hold_time = holdTime;
            keydownEvent.hold_time = holdTime;
            if (this.bufferStats.lastKeyTime) {
                const interKeyLatency = timestamp - this.bufferStats.lastKeyTime;
                keyData.inter_key_latency = interKeyLatency;
                this.bufferStats.pauseBuffer.push(interKeyLatency);
            }
            this.bufferStats.lastKeyTime = timestamp;
        }
        this.fs.saveRecord('raw_keyup', keyData);
        this.scheduleBackgroundUpdate();
    }
    extractKeyData(event, timestamp, eventType) {
        const key = event.key;
        const code = event.code;
        return {
            timestamp,
            event_type: eventType,
            key_code: code,
            key_value: key,
            key_length: key ? key.length : 0,
            is_char: key && key.length === 1 && !event.ctrlKey && !event.altKey,
            is_control: event.ctrlKey || event.metaKey,
            is_navigation: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
                'Home', 'End', 'PageUp', 'PageDown'].includes(key),
            keydown_time: eventType === 'keydown' ? timestamp : null,
            keyup_time: eventType === 'keyup' ? timestamp : null,
            modifier_state: {
                ctrl: event.ctrlKey,
                shift: event.shiftKey,
                alt: event.altKey,
                meta: event.metaKey
            },
            is_backspace: key === 'Backspace',
            is_delete: key === 'Delete',
            is_enter: key === 'Enter',
            is_undo: (event.ctrlKey || event.metaKey) && key === 'z',
            is_repeat: event.repeat,
            target_tag: event.target.tagName,
            target_type: event.target.type || 'none'
        };
    }
    handleMouseMove(event) {
        if (!this.isRecording) return;
        const timestamp = Date.now();
        const lastMouseEvent = this.eventHistory.mouseEvents[this.eventHistory.mouseEvents.length - 1];
        const mouseData = {
            timestamp,
            event_type: 'mousemove',
            client_x: event.clientX,
            client_y: event.clientY,
            screen_x: event.screenX,
            screen_y: event.screenY,
            page_x: event.pageX,
            page_y: event.pageY
        };
        if (lastMouseEvent && lastMouseEvent.event_type === 'mousemove') {
            const deltaX = event.clientX - lastMouseEvent.client_x;
            const deltaY = event.clientY - lastMouseEvent.client_y;
            const timeDelta = timestamp - lastMouseEvent.timestamp;
            mouseData.mousemove_delta = {
                x: deltaX,
                y: deltaY,
                distance: Math.sqrt(deltaX * deltaX + deltaY * deltaY)
            };
            mouseData.mousemove_velocity = timeDelta > 0 ? {
                x: deltaX / timeDelta,
                y: deltaY / timeDelta,
                speed: Math.sqrt(deltaX * deltaX + deltaY * deltaY) / timeDelta
            } : { x: 0, y: 0, speed: 0 };
        }
        this.eventHistory.mouseEvents.push(mouseData);
        this.sessionState.total_mouse_events++;
        this.bufferStats.mouseBuffer.push({
            time: timestamp,
            type: 'mousemove',
            velocity: mouseData.mousemove_velocity?.speed || 0
        });
        this.fs.saveRecord('raw_mousemove', mouseData);
        if (this.eventHistory.mouseEvents.length > this.HISTORY_LIMITS.mouseEvents * 1.1) {
            this.trimEventHistory('mouseEvents');
        }
        if (this.bufferStats.mouseBuffer.length > this.HISTORY_LIMITS.bufferStats) {
            this.bufferStats.mouseBuffer = this.bufferStats.mouseBuffer.slice(-this.HISTORY_LIMITS.bufferStats);
        }
    }
    handleMouseDown(event) {
        this.trackMouseEvent(event, 'mousedown');
        this.scheduleBackgroundUpdate();
    }
    handleMouseUp(event) {
        this.trackMouseEvent(event, 'mouseup');
        this.scheduleBackgroundUpdate();
    }
    handleClick(event) {
        if (!this.isRecording) return;
        const timestamp = Date.now();
        this.sessionState.cumulative_clicks++;
        const clickData = {
            timestamp,
            event_type: 'click',
            client_x: event.clientX,
            client_y: event.clientY,
            button: event.button,
            click_count: event.detail,
            target_tag: event.target.tagName,
            target_id: event.target.id || 'none',
            target_class: event.target.className || 'none'
        };
        this.eventHistory.mouseEvents.push(clickData);
        this.fs.saveRecord('raw_click', clickData);
        this.scheduleBackgroundUpdate();
    }
    trackMouseEvent(event, eventType) {
        if (!this.isRecording) return;
        const data = {
            timestamp: Date.now(),
            event_type: eventType,
            client_x: event.clientX,
            client_y: event.clientY,
            button: event.button
        };
        this.eventHistory.mouseEvents.push(data);
        this.fs.saveRecord(`raw_${eventType}`, data);
    }
    handleFocusIn() {
        this.trackFocusEvent('focus_in');
        this.scheduleBackgroundUpdate();
    }
    handleFocusOut() {
        this.trackFocusEvent('focus_out');
        this.scheduleBackgroundUpdate();
    }
    trackFocusEvent(eventType) {
        if (!this.isRecording) return;
        const timestamp = Date.now();
        const lastFocusEvent = this.eventHistory.focusEvents[this.eventHistory.focusEvents.length - 1];
        const focusData = {
            timestamp,
            event_type: eventType
        };
        if (eventType === 'focus_in' && lastFocusEvent && lastFocusEvent.event_type === 'focus_out') {
            focusData.blur_duration = timestamp - lastFocusEvent.timestamp;
        }
        this.eventHistory.focusEvents.push(focusData);
        this.fs.saveRecord(`raw_${eventType}`, focusData);
        if (this.eventHistory.focusEvents.length > this.HISTORY_LIMITS.focusEvents) {
            this.eventHistory.focusEvents = this.eventHistory.focusEvents.slice(-this.HISTORY_LIMITS.focusEvents);
        }
    }
    handleScroll(event) {
        if (!this.isRecording) return;
        const scrollData = {
            timestamp: Date.now(),
            event_type: 'scroll',
            scroll_x: window.scrollX,
            scroll_y: window.scrollY,
            scroll_delta: {
                x: event.deltaX || 0,
                y: event.deltaY || 0
            },
            target_tag: event.target.tagName
        };
        this.eventHistory.scrollEvents.push(scrollData);
        this.fs.saveRecord('raw_scroll', scrollData);
        if (this.eventHistory.scrollEvents.length > this.HISTORY_LIMITS.scrollEvents) {
            this.eventHistory.scrollEvents = this.eventHistory.scrollEvents.slice(-this.HISTORY_LIMITS.scrollEvents);
        }
    }
    startAggregationTimers() {
        setInterval(() => {
            this.calculate5sAggregates();
        }, 5000);
        setInterval(() => {
            this.calculate30sAggregates();
        }, 30000);
        setInterval(() => {
            this.calculate60sAggregates();
            this.calculateCognitiveLoops();
            this.generateStateVector();
            this.trimAllHistories();
        }, 60000);
        setInterval(() => {
            this.updateRealtimeMetrics();
        }, 1000);
    }
    calculate5sAggregates() {
        const now = Date.now();
        const windowStart = now - 5000;
        const recentKeyEvents = this.eventHistory.keyEvents.filter(
            e => e.timestamp >= windowStart
        );
        const recentMouseEvents = this.eventHistory.mouseEvents.filter(
            e => e.timestamp >= windowStart
        );
        if (recentKeyEvents.length === 0) return;
        const keyLatencies = [];
        const holdTimes = [];
        let corrections = 0;
        let totalChars = 0;
        for (let i = 1; i < recentKeyEvents.length; i++) {
            const latency = recentKeyEvents[i].timestamp - recentKeyEvents[i - 1].timestamp;
            if (latency > 0 && latency < 5000) {
                keyLatencies.push(latency);
            }
        }
        recentKeyEvents.forEach(event => {
            if (event.hold_time) holdTimes.push(event.hold_time);
            if (event.is_char) totalChars++;
            if (event.is_backspace || event.is_delete) corrections++;
        });
        const words = totalChars / 5;
        const minutes = 5 / 60;
        const wpm = minutes > 0 ? words / minutes : 0;
        const bursts = this.detectBursts(recentKeyEvents, windowStart);
        const aggregates = {
            timestamp: now,
            window_size: '5s',
            inter_key_latency_mean: this.mean(keyLatencies),
            inter_key_latency_std: this.stdDev(keyLatencies),
            inter_key_latency_entropy: this.calculateEntropy(keyLatencies),
            typing_speed_wpm: wpm,
            typing_speed_delta: this.calculateSpeedDelta(wpm),
            hold_time_mean: this.mean(holdTimes),
            hold_time_variance: this.variance(holdTimes),
            backspace_rate: recentKeyEvents.filter(e => e.is_backspace).length / 5,
            delete_rate: recentKeyEvents.filter(e => e.is_delete).length / 5,
            correction_ratio: totalChars > 0 ? corrections / totalChars : 0,
            undo_rate: recentKeyEvents.filter(e => e.is_undo).length / 5,
            burst_count: bursts.count,
            burst_duration_mean: bursts.meanDuration,
            burst_intensity: bursts.intensity,
            burst_correction_ratio: bursts.correctionRatio,
            click_rate: recentMouseEvents.filter(e => e.event_type === 'click').length / 5,
            mouse_velocity_mean: this.mean(recentMouseEvents
                .filter(e => e.mousemove_velocity)
                .map(e => e.mousemove_velocity.speed))
        };
        this.temporalAggregates.windows['5s'].data.push(aggregates);
        if (this.temporalAggregates.windows['5s'].data.length > this.HISTORY_LIMITS.aggregates_5s) {
            this.temporalAggregates.windows['5s'].data =
                this.temporalAggregates.windows['5s'].data.slice(-this.HISTORY_LIMITS.aggregates_5s);
        }
        this.fs.saveRecord('aggregate_5s', aggregates);
        this.realtimeMetrics.wpm = Math.round(wpm);
        this.realtimeMetrics.correctionRate = aggregates.correction_ratio;
        this.realtimeMetrics.loadHeuristic = this.calculateLoadHeuristic();
        this.updateBackgroundState();
    }
    calculate30sAggregates() {
        const now = Date.now();
        const windowStart = now - 30000;
        const recentEvents = this.eventHistory.keyEvents.filter(
            e => e.timestamp >= windowStart
        );
        if (recentEvents.length < 3) return;
        const pauses = this.detectPauses(recentEvents);
        const aggregates = {
            timestamp: now,
            window_size: '30s',
            pause_count: pauses.count,
            pause_mean_duration: pauses.meanDuration,
            long_pause_count: pauses.longPauses,
            micro_pause_rate: pauses.microPauseRate,
            speed_after_pause: this.calculateSpeedAfterPause(recentEvents),
            correction_after_pause: this.calculateCorrectionAfterPause(recentEvents),
            latency_after_pause: this.calculateLatencyAfterPause(recentEvents),
            cumulative_keystrokes: this.sessionState.cumulative_keystrokes,
            cumulative_corrections: this.sessionState.cumulative_corrections,
            correction_pressure: this.sessionState.cumulative_keystrokes > 0 ?
                this.sessionState.cumulative_corrections / this.sessionState.cumulative_keystrokes : 0
        };
        this.temporalAggregates.windows['30s'].data.push(aggregates);
        if (this.temporalAggregates.windows['30s'].data.length > this.HISTORY_LIMITS.aggregates_30s) {
            this.temporalAggregates.windows['30s'].data =
                this.temporalAggregates.windows['30s'].data.slice(-this.HISTORY_LIMITS.aggregates_30s);
        }
        this.fs.saveRecord('aggregate_30s', aggregates);
        this.updateBackgroundState();
    }
    calculate60sAggregates() {
        const now = Date.now();
        const sessionDuration = now - this.sessionState.session_start_time;
        const aggregates = {
            timestamp: now,
            window_size: '60s',
            session_start_time: new Date(this.sessionState.session_start_time).toISOString(),
            session_duration: sessionDuration,
            time_since_last_break: this.calculateTimeSinceLastBreak(),
            work_continuity_index: this.calculateContinuityIndex(),
            night_hours_flag: this.isNightHour(now),
            event_intensity: this.eventHistory.keyEvents.length / (sessionDuration / 1000),
            correction_intensity: this.sessionState.cumulative_corrections / (sessionDuration / 1000),
            variability_index: this.calculateVariabilityIndex(),
            memory_metrics: {
                key_events_count: this.eventHistory.keyEvents.length,
                mouse_events_count: this.eventHistory.mouseEvents.length,
                periods_truncated: this.sessionState.periods_truncated
            }
        };
        this.temporalAggregates.windows['60s'].data.push(aggregates);
        if (this.temporalAggregates.windows['60s'].data.length > this.HISTORY_LIMITS.aggregates_60s) {
            this.temporalAggregates.windows['60s'].data =
                this.temporalAggregates.windows['60s'].data.slice(-this.HISTORY_LIMITS.aggregates_60s);
        }
        this.fs.saveRecord('aggregate_60s', aggregates);
        this.updateBackgroundState();
    }
    calculateCognitiveLoops() {
        const lastMinute = Date.now() - 60000;
        const recentKeyEvents = this.eventHistory.keyEvents
            .filter(e => e.timestamp >= lastMinute)
            .slice(-200);
        if (recentKeyEvents.length < 10) return;
        const cursorPositions = this.simulateCursorPositions(recentKeyEvents);
        const loops = this.detectLoops(cursorPositions);
        loops.forEach(loop => {
            const loopData = {
                type: 'cognitive_loop',
                timestamp: Date.now(),
                loop_id: `loop_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                loop_type: loop.type,
                loop_duration: loop.duration,
                iterations: loop.iterations,
                correction_pressure: loop.correctionPressure,
                exit_success: loop.exitSuccess,
                region_stability: loop.regionStability
            };
            this.fs.saveRecord('cognitive_loop', loopData);
        });
        if (this.cognitiveLoops.cursorPositions.size > this.HISTORY_LIMITS.cursorPositions) {
            const entries = Array.from(this.cognitiveLoops.cursorPositions.entries());
            const recentEntries = entries.slice(-this.HISTORY_LIMITS.cursorPositions);
            this.cognitiveLoops.cursorPositions = new Map(recentEntries);
        }
    }
    simulateCursorPositions(keyEvents) {
        let position = 0;
        const positions = [];
        keyEvents.forEach(event => {
            if (event.is_char) position++;
            else if (event.is_backspace && position > 0) position--;
            else if (event.is_delete) position = position;
            else if (event.is_navigation) {
                if (event.key_value === 'ArrowLeft') position = Math.max(0, position - 1);
                else if (event.key_value === 'ArrowRight') position++;
            }
            positions.push({
                timestamp: event.timestamp,
                position: position,
                event_type: event.event_type,
                is_correction: event.is_backspace || event.is_delete
            });
        });
        return positions;
    }
    detectLoops(positions) {
        const loops = [];
        const windowSize = 30;
        const searchPositions = positions.slice(-100);
        for (let i = 0; i < searchPositions.length; i++) {
            const current = searchPositions[i];
            const windowStart = current.timestamp - (windowSize * 1000);
            const similarPositions = searchPositions.filter(p =>
                p.timestamp >= windowStart &&
                p.timestamp < current.timestamp &&
                Math.abs(p.position - current.position) < 3
            );
            if (similarPositions.length >= 2) {
                const loopDuration = current.timestamp - similarPositions[0].timestamp;
                const corrections = similarPositions.filter(p => p.is_correction).length;
                loops.push({
                    type: 'cursor_position_loop',
                    duration: loopDuration,
                    iterations: similarPositions.length,
                    correctionPressure: corrections / similarPositions.length,
                    exitSuccess: this.evaluateLoopExit(similarPositions),
                    regionStability: this.calculateRegionStability(similarPositions)
                });
            }
        }
        return loops;
    }
    updateRealtimeMetrics() {
        const recent5s = this.temporalAggregates.windows['5s'].data;
        const current = recent5s[recent5s.length - 1] || {};
        this.realtimeMetrics.wpm = Math.round(current.typing_speed_wpm || 0);
        this.realtimeMetrics.correctionRate = current.correction_ratio || 0;
        this.realtimeMetrics.loadHeuristic = this.calculateLoadHeuristic();
        this.realtimeMetrics.lastUpdate = Date.now();
        const now = Date.now();
        if (!this.lastGlobalUpdate || (now - this.lastGlobalUpdate > 2000)) {
            this.lastGlobalUpdate = now;
            this.updateBackgroundState();
        }
    }
    tagCognitiveState(tagType, note = '') {
        const tagData = {
            timestamp: Date.now(),
            type: 'user_tag',
            session_id: this.sessionId,
            user_tag: tagType,
            note_length: note.length,
            context: {
                recent_events_count: this.bufferStats.keyBuffer.length,
                recent_corrections: this.bufferStats.keyBuffer.filter(e => e.isCorrection).length,
                time_since_last_activity: Date.now() - this.sessionState.last_activity_time
            }
        };
        this.fs.saveRecord('user_tag', tagData);
        this.updateBackgroundState();
        return { success: true, tag: tagType, timestamp: tagData.timestamp };
    }
    generateStateVector() {
        const recent5s = this.temporalAggregates.windows['5s'].data;
        const currentState = recent5s[recent5s.length - 1] || {};
        const previousState = recent5s[recent5s.length - 2] || {};
        const stateVector = {
            state_vector_id: `state_${Date.now()}`,
            timestamp: Date.now(),
            previous_state_similarity: this.calculateStateSimilarity(currentState, previousState),
            state_delta_magnitude: this.calculateStateDelta(currentState, previousState),
            load_heuristic: this.calculateLoadHeuristic(),
            cognitive_pressure_index: this.calculateCognitivePressure(),
            time_to_user_realization: this.estimateTimeToRealization(),
            warning_signals: this.extractWarningSignals()
        };
        this.fs.saveRecord('state_vector', stateVector);
        this.updateBackgroundState();
        return stateVector;
    }
    detectBursts(keyEvents, windowStart) {
        const bursts = [];
        let currentBurst = null;
        const BURST_THRESHOLD = 200;
        const MIN_BURST_LENGTH = 3;
        const eventsToAnalyze = keyEvents.slice(-100);
        for (const event of eventsToAnalyze) {
            if (!currentBurst) {
                currentBurst = {
                    start: event.timestamp,
                    events: [event],
                    corrections: 0
                };
            } else {
                const timeSinceLast = event.timestamp - currentBurst.events[currentBurst.events.length - 1].timestamp;
                if (timeSinceLast < BURST_THRESHOLD) {
                    currentBurst.events.push(event);
                    if (event.is_backspace || event.is_delete) {
                        currentBurst.corrections++;
                    }
                } else {
                    if (currentBurst.events.length >= MIN_BURST_LENGTH) {
                        bursts.push(currentBurst);
                    }
                    currentBurst = {
                        start: event.timestamp,
                        events: [event],
                        corrections: 0
                    };
                }
            }
        }
        if (currentBurst && currentBurst.events.length >= MIN_BURST_LENGTH) {
            bursts.push(currentBurst);
        }
        return {
            count: bursts.length,
            meanDuration: bursts.length > 0 ?
                bursts.reduce((sum, b) => sum + (b.events[b.events.length - 1].timestamp - b.start), 0) / bursts.length : 0,
            intensity: bursts.length > 0 ?
                bursts.reduce((sum, b) => sum + b.events.length, 0) / bursts.length : 0,
            correctionRatio: bursts.length > 0 ?
                bursts.reduce((sum, b) => sum + b.corrections, 0) / bursts.reduce((sum, b) => sum + b.events.length, 0) : 0
        };
    }
    detectPauses(keyEvents) {
        const pauses = [];
        const PAUSE_THRESHOLD = 1000;
        const LONG_PAUSE_THRESHOLD = 5000;
        const MICRO_PAUSE_THRESHOLD = 200;
        const eventsToAnalyze = keyEvents.slice(-50);
        for (let i = 1; i < eventsToAnalyze.length; i++) {
            const pause = eventsToAnalyze[i].timestamp - eventsToAnalyze[i - 1].timestamp;
            if (pause > PAUSE_THRESHOLD) {
                pauses.push({
                    duration: pause,
                    isLong: pause > LONG_PAUSE_THRESHOLD,
                    isMicro: pause < MICRO_PAUSE_THRESHOLD && pause > 50
                });
            }
        }
        return {
            count: pauses.length,
            meanDuration: pauses.length > 0 ?
                pauses.reduce((sum, p) => sum + p.duration, 0) / pauses.length : 0,
            longPauses: pauses.filter(p => p.isLong).length,
            microPauseRate: pauses.filter(p => p.isMicro).length / (eventsToAnalyze.length || 1)
        };
    }
    mean(array) {
        if (!array || array.length === 0) return 0;
        return array.reduce((a, b) => a + b, 0) / array.length;
    }
    variance(array) {
        if (!array || array.length < 2) return 0;
        const m = this.mean(array);
        return this.mean(array.map(x => Math.pow(x - m, 2)));
    }
    stdDev(array) {
        return Math.sqrt(this.variance(array));
    }
    calculateEntropy(array) {
        if (!array || array.length === 0) return 0;
        const bins = {};
        array.forEach(val => {
            const bin = Math.round(val / 10) * 10;
            bins[bin] = (bins[bin] || 0) + 1;
        });
        let entropy = 0;
        const total = array.length;
        Object.values(bins).forEach(count => {
            const p = count / total;
            entropy -= p * Math.log2(p);
        });
        return entropy;
    }
    calculateSpeedDelta(currentWPM) {
        const recentAggregates = this.temporalAggregates.windows['5s'].data;
        if (recentAggregates.length < 2) return 0;
        const previousWPM = recentAggregates[recentAggregates.length - 2].typing_speed_wpm || 0;
        return previousWPM > 0 ? (currentWPM - previousWPM) / previousWPM : 0;
    }
    calculateSpeedAfterPause(events) {
        let totalSpeed = 0;
        let count = 0;
        const eventsToAnalyze = events.slice(-30);
        for (let i = 1; i < eventsToAnalyze.length; i++) {
            const pause = eventsToAnalyze[i].timestamp - eventsToAnalyze[i - 1].timestamp;
            if (pause > 2000 && i + 3 < eventsToAnalyze.length) {
                const nextEvents = eventsToAnalyze.slice(i, i + 3);
                if (nextEvents.length >= 2) {
                    const duration = nextEvents[nextEvents.length - 1].timestamp - nextEvents[0].timestamp;
                    const speed = duration > 0 ? (nextEvents.length / duration) * 1000 : 0;
                    totalSpeed += speed;
                    count++;
                }
            }
        }
        return count > 0 ? totalSpeed / count : 0;
    }
    calculateCorrectionAfterPause(events) {
        let totalCorrections = 0;
        let totalEvents = 0;
        const eventsToAnalyze = events.slice(-30);
        for (let i = 1; i < eventsToAnalyze.length; i++) {
            const pause = eventsToAnalyze[i].timestamp - eventsToAnalyze[i - 1].timestamp;
            if (pause > 2000 && i + 5 < eventsToAnalyze.length) {
                const nextEvents = eventsToAnalyze.slice(i, i + 5);
                const corrections = nextEvents.filter(e => e.is_backspace || e.is_delete).length;
                totalCorrections += corrections;
                totalEvents += nextEvents.length;
            }
        }
        return totalEvents > 0 ? totalCorrections / totalEvents : 0;
    }
    calculateLatencyAfterPause(events) {
        let totalLatency = 0;
        let count = 0;
        const eventsToAnalyze = events.slice(-30);
        for (let i = 1; i < eventsToAnalyze.length; i++) {
            const pause = eventsToAnalyze[i].timestamp - eventsToAnalyze[i - 1].timestamp;
            if (pause > 2000 && i + 1 < eventsToAnalyze.length) {
                const latency = eventsToAnalyze[i + 1].timestamp - eventsToAnalyze[i].timestamp;
                totalLatency += latency;
                count++;
            }
        }
        return count > 0 ? totalLatency / count : 0;
    }
    calculateTimeSinceLastBreak() {
        const recentEvents = this.eventHistory.keyEvents.slice(-500);
        const lastLongPause = recentEvents.findLast(
            e => recentEvents.find(
                e2 => e2.timestamp > e.timestamp && e2.timestamp - e.timestamp > 300000
            )
        );
        return lastLongPause ? Date.now() - lastLongPause.timestamp : Date.now() - this.sessionState.session_start_time;
    }
    calculateContinuityIndex() {
        const totalTime = Date.now() - this.sessionState.session_start_time;
        const activeTime = this.calculateActiveTime();
        return totalTime > 0 ? activeTime / totalTime : 0;
    }
    calculateActiveTime() {
        let activeTime = 0;
        const events = this.eventHistory.keyEvents.slice(-1000);
        for (let i = 1; i < events.length; i++) {
            const interval = events[i].timestamp - events[i - 1].timestamp;
            if (interval < 2000) {
                activeTime += interval;
            }
        }
        return activeTime;
    }
    isNightHour(timestamp) {
        const hour = new Date(timestamp).getHours();
        return hour >= 22 || hour <= 6;
    }
    calculateVariabilityIndex() {
        const recentEvents = this.eventHistory.keyEvents.slice(-50);
        if (recentEvents.length < 10) return 0;
        const latencies = [];
        for (let i = 1; i < recentEvents.length; i++) {
            latencies.push(recentEvents[i].timestamp - recentEvents[i - 1].timestamp);
        }
        const mean = this.mean(latencies);
        const std = this.stdDev(latencies);
        return mean > 0 ? std / mean : 0;
    }
    calculateLoadHeuristic() {
        const recent5s = this.temporalAggregates.windows['5s'].data;
        if (recent5s.length === 0) return 0;
        const current = recent5s[recent5s.length - 1];
        let score = 0;
        if (typeof current.correction_ratio === 'number') {
            score += current.correction_ratio * 40;
        }
        if (typeof current.typing_speed_wpm === 'number' && current.typing_speed_wpm < 20) {
            score += 20;
        }
        if (typeof current.inter_key_latency_std === 'number') {
            score += Math.min(current.inter_key_latency_std / 100, 20);
        }
        const recent30s = this.temporalAggregates.windows['30s'].data;
        if (recent30s.length > 0) {
            const current30s = recent30s[recent30s.length - 1];
            if (typeof current30s.pause_count === 'number' && current30s.pause_count > 3) {
                score += 15;
            }
        }
        return Math.min(Math.max(score, 0), 100);
    }
    calculateStateSimilarity(stateA, stateB) {
        if (!stateA || !stateB) return 0;
        const metrics = ['typing_speed_wpm', 'correction_ratio', 'inter_key_latency_mean'];
        let similarity = 0;
        metrics.forEach(metric => {
            if (stateA[metric] && stateB[metric]) {
                const maxVal = Math.max(stateA[metric], stateB[metric]);
                if (maxVal > 0) {
                    similarity += 1 - Math.abs(stateA[metric] - stateB[metric]) / maxVal;
                }
            }
        });
        return similarity / metrics.length;
    }
    calculateStateDelta(stateA, stateB) {
        if (!stateA || !stateB) return 0;
        const deltas = [
            Math.abs((stateA.typing_speed_wpm || 0) - (stateB.typing_speed_wpm || 0)),
            Math.abs((stateA.correction_ratio || 0) - (stateB.correction_ratio || 0)),
            Math.abs((stateA.inter_key_latency_mean || 0) - (stateB.inter_key_latency_mean || 0))
        ];
        return this.mean(deltas);
    }
    calculateCognitivePressure() {
        const recentEvents = this.eventHistory.keyEvents.slice(-100);
        if (recentEvents.length < 20) return 0;
        let pressure = 0;
        const corrections = recentEvents.filter(e => e.is_backspace || e.is_delete);
        if (corrections.length > 5) pressure += 30;
        const latencies = [];
        for (let i = 1; i < recentEvents.length; i++) {
            latencies.push(recentEvents[i].timestamp - recentEvents[i - 1].timestamp);
        }
        const cv = this.stdDev(latencies) / this.mean(latencies);
        pressure += Math.min(cv * 20, 40);
        const simulatedPositions = this.simulateCursorPositions(recentEvents.slice(-100));
        const loops = this.detectLoops(simulatedPositions);
        pressure += loops.length * 10;
        return Math.min(pressure, 100);
    }
    estimateTimeToRealization() {
        const load = this.calculateLoadHeuristic();
        if (load > 70) return 5000;
        if (load > 40) return 15000;
        return 30000;
    }
    extractWarningSignals() {
        const signals = [];
        const recent5s = this.temporalAggregates.windows['5s'].data;
        if (recent5s.length > 0) {
            const current = recent5s[recent5s.length - 1];
            if (current.correction_ratio > 0.3) signals.push('high_correction_rate');
            if (current.typing_speed_wpm < 10) signals.push('very_slow_typing');
            if (current.inter_key_latency_std > 500) signals.push('high_variability');
            const recent30s = this.temporalAggregates.windows['30s'].data;
            if (recent30s.length > 0) {
                const current30s = recent30s[recent30s.length - 1];
                if (current30s.pause_count > 5) signals.push('frequent_pauses');
            }
        }
        return signals;
    }
    evaluateLoopExit(loopPositions) {
        if (loopPositions.length < 3) return false;
        const lastThree = loopPositions.slice(-3);
        const positions = lastThree.map(p => p.position);
        const uniquePositions = new Set(positions);
        return uniquePositions.size > 1;
    }
    calculateRegionStability(positions) {
        if (positions.length < 2) return 1;
        const positionValues = positions.map(p => p.position);
        const mean = this.mean(positionValues);
        const variance = this.variance(positionValues);
        return Math.max(0, 1 - (variance / 100));
    }
    trimEventHistory(type = null) {
        this.sessionState.periods_truncated++;
        if (!type || type === 'keyEvents') {
            if (this.eventHistory.keyEvents.length > this.HISTORY_LIMITS.keyEvents) {
                const before = this.eventHistory.keyEvents.length;
                this.eventHistory.keyEvents = this.eventHistory.keyEvents.slice(-this.HISTORY_LIMITS.keyEvents);
                console.log(`CSCS: Trimmed keyEvents from ${before} to ${this.eventHistory.keyEvents.length}`);
            }
        }
        if (!type || type === 'mouseEvents') {
            if (this.eventHistory.mouseEvents.length > this.HISTORY_LIMITS.mouseEvents) {
                const before = this.eventHistory.mouseEvents.length;
                this.eventHistory.mouseEvents = this.eventHistory.mouseEvents.slice(-this.HISTORY_LIMITS.mouseEvents);
                console.log(`CSCS: Trimmed mouseEvents from ${before} to ${this.eventHistory.mouseEvents.length}`);
            }
        }
        if (!type || type === 'focusEvents') {
            if (this.eventHistory.focusEvents.length > this.HISTORY_LIMITS.focusEvents) {
                this.eventHistory.focusEvents = this.eventHistory.focusEvents.slice(-this.HISTORY_LIMITS.focusEvents);
            }
        }
        if (!type || type === 'scrollEvents') {
            if (this.eventHistory.scrollEvents.length > this.HISTORY_LIMITS.scrollEvents) {
                this.eventHistory.scrollEvents = this.eventHistory.scrollEvents.slice(-this.HISTORY_LIMITS.scrollEvents);
            }
        }
        if (this.bufferStats.pauseBuffer.length > this.HISTORY_LIMITS.bufferStats) {
            this.bufferStats.pauseBuffer = this.bufferStats.pauseBuffer.slice(-this.HISTORY_LIMITS.bufferStats);
        }
    }
    trimAllHistories() {
        this.trimEventHistory();
        const now = Date.now();
        const OLD_THRESHOLD = 5 * 60 * 1000;
        this.eventHistory.keyEvents = this.eventHistory.keyEvents.filter(
            e => e.timestamp > now - OLD_THRESHOLD
        );
        this.eventHistory.mouseEvents = this.eventHistory.mouseEvents.filter(
            e => e.timestamp > now - OLD_THRESHOLD
        );
    }
    async updateBackgroundState() {
        try {
            const stats = this.getRealtimeStats();
            await chrome.runtime.sendMessage({
                action: "updateGlobalState",
                data: stats
            });
        } catch (error) {
            console.debug('CSCS: Background not available for update');
        }
    }
    scheduleBackgroundUpdate() {
        if (!this.updateDebounceTimer) {
            this.updateDebounceTimer = setTimeout(() => {
                this.updateBackgroundState();
                this.updateDebounceTimer = null;
            }, 500);
        }
    }
    startBackgroundUpdates() {
        this.updateBackgroundInterval = setInterval(() => {
            this.updateBackgroundState();
        }, 5000);
    }
    stopBackgroundUpdates() {
        if (this.updateBackgroundInterval) {
            clearInterval(this.updateBackgroundInterval);
            this.updateBackgroundInterval = null;
        }
        if (this.updateDebounceTimer) {
            clearTimeout(this.updateDebounceTimer);
            this.updateDebounceTimer = null;
        }
    }
    setupAutoSave() {
        setInterval(() => {
            this.fs.flushBuffer();
        }, 30000);
        window.CSCS = {
            save: () => {
                this.fs.flushBuffer();
                return { success: true, message: "Buffer flushed" };
            },
            tag: (tagType, note) => this.tagCognitiveState(tagType, note),
            getRealtimeStats: () => this.getRealtimeStats(),
            getSystemStatus: () => this.getSystemStatus(),
            toggleRecording: () => {
                this.isRecording = !this.isRecording;
                setTimeout(() => {
                    this.updateBackgroundState();
                }, 100);
                return this.isRecording;
            },
            exportData: async () => await this.exportData(),
            trimMemory: () => this.trimAllHistories(),
            updateBackground: () => this.updateBackgroundState()
        };
    }
    async exportData() {
        const exportData = {
            export_timestamp: new Date().toISOString(),
            system: "Cognitive State Control System",
            company: "Electric Entropy - Deterministic AI Systems",
            session_id: this.sessionId,
            session_summary: {
                ...this.sessionState,
                duration: Date.now() - this.sessionState.session_start_time
            },
            temporal_aggregates: this.temporalAggregates,
            event_history: {
                keyEvents: this.eventHistory.keyEvents.slice(-this.HISTORY_LIMITS.keyEvents),
                mouseEvents: this.eventHistory.mouseEvents.slice(-this.HISTORY_LIMITS.mouseEvents),
                focusEvents: this.eventHistory.focusEvents.slice(-this.HISTORY_LIMITS.focusEvents),
                scrollEvents: this.eventHistory.scrollEvents.slice(-this.HISTORY_LIMITS.scrollEvents)
            }
        };
        return this.fs.generateDownload(exportData);
    }
    saveAllData() {
        this.exportData().then(result => {
            if (result && result.url) {
                chrome.runtime.sendMessage({
                    action: "downloadExport",
                    data: result
                });
            }
        });
    }
    getRealtimeStats() {
        const recent5s = this.temporalAggregates.windows['5s'].data;
        const current = recent5s[recent5s.length - 1] || {};
        const loadHeuristic = this.calculateLoadHeuristic();
        return {
            session_id: this.sessionId,
            session_duration: Date.now() - this.sessionState.session_start_time,
            total_keystrokes: this.sessionState.cumulative_keystrokes,
            total_corrections: this.sessionState.cumulative_corrections,
            current_speed_wpm: current.typing_speed_wpm || 0,
            current_correction_ratio: current.correction_ratio || 0,
            loadHeuristic: isNaN(loadHeuristic) ? 0 : Math.min(loadHeuristic, 100),
            wpm: this.realtimeMetrics.wpm || 0,
            correctionRate: this.realtimeMetrics.correctionRate || 0,
            keystrokes: this.sessionState.cumulative_keystrokes || 0,
            is_recording: this.isRecording,
            warning_signals: this.extractWarningSignals(),
            timestamp: Date.now()
        };
    }
    getSystemStatus() {
        return {
            session_id: this.sessionId,
            session_duration: Date.now() - this.sessionState.session_start_time,
            is_recording: this.isRecording,
            event_counts: {
                key_events: this.eventHistory.keyEvents.length,
                mouse_events: this.eventHistory.mouseEvents.length,
                focus_events: this.eventHistory.focusEvents.length,
                scroll_events: this.eventHistory.scrollEvents.length,
                total_key_events: this.sessionState.total_key_events,
                total_mouse_events: this.sessionState.total_mouse_events
            },
            history_limits: this.HISTORY_LIMITS,
            periods_truncated: this.sessionState.periods_truncated,
            last_background_update: this.lastGlobalUpdate
        };
    }
    detectHighLoad() {
        console.log('CSCS: Wykryto wysokie obciążenie poznawcze');
        this.fs.saveRecord('cognitive_event', {
            type: 'high_load_detected',
            timestamp: Date.now(),
            metrics: { ...this.realtimeMetrics },
            suggestion: 'consider_break'
        });
        this.updateBackgroundState();
    }
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.CSCS = new CognitiveStateControlSystem();
    });
} else {
    window.CSCS = new CognitiveStateControlSystem();
}
