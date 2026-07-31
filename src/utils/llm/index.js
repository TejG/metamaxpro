// llm/index.js — public facade for the LLM pipeline.
//
// Owns the Gemini Live session lifecycle and all LLM-related IPC handlers,
// and re-exports the pipeline so consumers (src/index.js, localai.js) have a
// single entry point. Everything else lives in focused modules:
//
//   state.js        shared mutable session state + sendToRenderer
//   config.js       model lists, constants, pure helpers
//   persistence.js  session/history persistence + provider history mappers
//   router.js       text-answer cascade (Groq / Anthropic / Gemini)
//   vision.js       screenshot solving + provider routing
//   audio.js        macOS SystemAudioDump capture + Whisper VAD routing
const { GoogleGenAI, Modality } = require('@google/genai');
const { BrowserWindow, ipcMain } = require('electron');
const { getSystemPrompt } = require('../prompts');
const { connectCloud, sendCloudAudio, sendCloudText, sendCloudImage, closeCloud, setOnTurnComplete } = require('../cloud');
const { startWhisperVAD, stopWhisperVAD } = require('../whisper');

const { S, sendToRenderer, getLocalAi } = require('./state');
const { SESSION_WARMUP_MS, MAX_RECONNECT_ATTEMPTS, RECONNECT_DELAY, GEMINI_LIVE_MODELS, formatSpeakerResults } = require('./config');
const { initializeNewSession, saveConversationTurn, getCurrentSessionData, buildContextMessage } = require('./persistence');
const { routeAnswer, scheduleGroqTrigger, cancelSilenceTimer, cancelProvisionalTimer, queueForAnthropic } = require('./router');
const { sendImageToGeminiHttp, sendMultipleImagesToGeminiHttp, routeImagesToProvider } = require('./vision');
const { killExistingSystemAudioDump, startMacOSAudioCapture, convertStereoToMono, stopMacOSAudioCapture, sendAudioToGemini } = require('./audio');

async function getEnabledTools() {
    const tools = [];

    // Check if Google Search is enabled (default: true)
    const googleSearchEnabled = await getStoredSetting('googleSearchEnabled', 'true');
    console.log('Google Search enabled:', googleSearchEnabled);

    if (googleSearchEnabled === 'true') {
        tools.push({ googleSearch: {} });
        console.log('Added Google Search tool');
    } else {
        console.log('Google Search tool disabled');
    }

    return tools;
}

async function getStoredSetting(key, defaultValue) {
    try {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
            // Wait a bit for the renderer to be ready
            await new Promise(resolve => setTimeout(resolve, 100));

            // Try to get setting from renderer process localStorage
            const value = await windows[0].webContents.executeJavaScript(`
                (function() {
                    try {
                        if (typeof localStorage === 'undefined') {
                            console.log('localStorage not available yet for ${key}');
                            return '${defaultValue}';
                        }
                        const stored = localStorage.getItem('${key}');
                        console.log('Retrieved setting ${key}:', stored);
                        return stored || '${defaultValue}';
                    } catch (e) {
                        console.error('Error accessing localStorage for ${key}:', e);
                        return '${defaultValue}';
                    }
                })()
            `);
            return value;
        }
    } catch (error) {
        console.error('Error getting stored setting for', key, ':', error.message);
    }
    console.log('Using default value for', key, ':', defaultValue);
    return defaultValue;
}

async function initializeGeminiSession(apiKey, customPrompt = '', profile = 'interview', language = 'en-US', isReconnect = false) {
    if (S.isInitializingSession) {
        console.log('Session initialization already in progress');
        return false;
    }

    S.isInitializingSession = true;
    if (!isReconnect) {
        sendToRenderer('session-initializing', true);
    }

    // Store params for reconnection
    if (!isReconnect) {
        S.sessionParams = { apiKey, customPrompt, profile, language };
        S.reconnectAttempts = 0;
    }

    const client = new GoogleGenAI({
        vertexai: false,
        apiKey: apiKey,
        httpOptions: { apiVersion: 'v1alpha' },
    });

    // Get enabled tools first to determine Google Search status
    const enabledTools = await getEnabledTools();
    const googleSearchEnabled = enabledTools.some(tool => tool.googleSearch);

    const systemPrompt = getSystemPrompt(profile, customPrompt, googleSearchEnabled);
    S.currentSystemPrompt = systemPrompt; // Store for the answer providers

    // Initialize new conversation session only on first connect
    if (!isReconnect) {
        initializeNewSession(profile, customPrompt);
    }

    // Callbacks + config are identical for every candidate model.
    const callbacks = {
        onopen: function () {
            S.sessionReadyAt = Date.now();
            S.lastActivityTimestamp = Date.now();
            sendToRenderer('update-status', 'Live session connected');

            // Start keepalive timer to prevent idle timeout
            if (global.geminiSessionRef) {
                startKeepalive(global.geminiSessionRef);
            }
        },
        onmessage: function (message) {
            // Handle input transcription (what was spoken). Each chunk resets the
            // silence timer — the answer fires shortly after the user stops speaking.
            if (message.serverContent?.inputTranscription?.results) {
                S.currentTranscription += formatSpeakerResults(message.serverContent.inputTranscription.results);
                scheduleGroqTrigger();
            } else if (message.serverContent?.inputTranscription?.text) {
                const text = message.serverContent.inputTranscription.text;
                if (text.trim() !== '') {
                    S.currentTranscription += text;
                    scheduleGroqTrigger();
                }
            }

            if (message.serverContent?.turnComplete) {
                sendToRenderer('update-status', 'Listening...');
                cancelSilenceTimer();
                if (S.currentTranscription.trim() !== '') {
                    routeAnswer(S.currentTranscription);
                    S.currentTranscription = '';
                }
            }
        },
        onerror: function (e) {
            console.log('Session error:', e.message);
            sendToRenderer('update-status', 'Error: ' + e.message);
        },
        onclose: function (e) {
            console.log('Session closed:', e.reason);
            stopKeepalive(); // Stop keepalive timer
            if (S.isUserClosing) {
                S.isUserClosing = false;
                sendToRenderer('update-status', 'Session closed');
                return;
            }
            if (S.sessionParams && S.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                attemptReconnect();
            } else {
                sendToRenderer('update-status', 'Session closed');
            }
        },
    };

    const liveConfig = {
        responseModalities: [Modality.AUDIO],
        proactivity: { proactiveAudio: true },
        outputAudioTranscription: {},
        tools: enabledTools,
        // Enable speaker diarization
        inputAudioTranscription: {
            enableSpeakerDiarization: true,
            minSpeakerCount: 2,
            maxSpeakerCount: 2,
        },
        contextWindowCompression: { slidingWindow: {} },
        speechConfig: { languageCode: language },
        systemInstruction: {
            parts: [{ text: systemPrompt }],
        },
    };

    // Try each candidate native-audio model until one connects. Dated preview
    // models get retired, which previously killed audio silently — the chain plus
    // a clear error message prevents that from being invisible again.
    let session = null;
    let lastErr = null;
    for (const liveModel of GEMINI_LIVE_MODELS) {
        try {
            console.log('[Gemini] connecting live session with model:', liveModel);
            session = await client.live.connect({ model: liveModel, callbacks, config: liveConfig });
            console.log('[Gemini] live session connected:', liveModel);
            break;
        } catch (err) {
            lastErr = err;
            console.error(`[Gemini] live.connect failed for ${liveModel}:`, err && (err.message || err));
        }
    }

    S.isInitializingSession = false;
    if (!isReconnect) sendToRenderer('session-initializing', false);

    if (!session) {
        const msg = (lastErr && (lastErr.message || String(lastErr))) || 'unknown error';
        console.error('[Gemini] All live audio models failed to connect:', msg);
        sendToRenderer(
            'update-status',
            '⚠️ Live audio session could not start — audio answers are unavailable (' +
                msg +
                '). Screenshots still work; check your Gemini API key/quota.'
        );
        return null;
    }
    return session;
}

async function attemptReconnect() {
    S.reconnectAttempts++;
    console.log(`Reconnection attempt ${S.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);

    // Clear stale buffers and any pending silence timer
    S.currentTranscription = '';
    cancelSilenceTimer();
    cancelProvisionalTimer();
    S.sessionReadyAt = 0; // reset warmup guard until new session opens
    // Don't reset groqConversationHistory to preserve context across reconnects

    sendToRenderer('update-status', `Reconnecting... (${S.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    // Wait before attempting
    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));

    try {
        const session = await initializeGeminiSession(
            S.sessionParams.apiKey,
            S.sessionParams.customPrompt,
            S.sessionParams.profile,
            S.sessionParams.language,
            true // isReconnect
        );

        if (session && global.geminiSessionRef) {
            global.geminiSessionRef.current = session;

            // Restore context from conversation history via text message
            const contextMessage = buildContextMessage();
            if (contextMessage) {
                try {
                    console.log('Restoring conversation context...');
                    await session.sendRealtimeInput({ text: contextMessage });
                } catch (contextError) {
                    console.error('Failed to restore context:', contextError);
                    // Continue without context - better than failing
                }
            }

            // Don't reset reconnectAttempts here - let it reset on next fresh session
            sendToRenderer('update-status', 'Reconnected! Listening...');
            console.log('Session reconnected successfully');
            return true;
        }
    } catch (error) {
        console.error(`Reconnection attempt ${S.reconnectAttempts} failed:`, error);
    }

    // If we still have attempts left, try again
    if (S.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        return attemptReconnect();
    }

    // Max attempts reached - notify frontend
    console.log('Max reconnection attempts reached');
    sendToRenderer('reconnect-failed', {
        message: 'Tried 3 times to reconnect. Must be upstream/network issues. Try restarting or download updated app from site.',
    });
    S.sessionParams = null;
    return false;
}

// ── Keepalive to prevent idle timeout ──────────────────────────────
// Gemini Live sessions timeout after ~15 minutes of inactivity. Send periodic
// silent audio packets to keep the session alive during long pauses.
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
const IDLE_TIMEOUT_WARNING_MS = 12 * 60 * 1000; // Warn after 12 minutes idle (before 15min timeout)

function startKeepalive(geminiSessionRef) {
    stopKeepalive(); // Clear any existing timer

    S.sessionKeepaliveTimer = setInterval(async () => {
        const idleDuration = Date.now() - S.lastActivityTimestamp;

        // If idle for 12+ minutes, send keepalive packet
        if (idleDuration >= IDLE_TIMEOUT_WARNING_MS && geminiSessionRef.current) {
            console.log('[Keepalive] Sending heartbeat packet (idle:', Math.floor(idleDuration / 1000 / 60), 'min)');
            try {
                // Send 100ms of silence (minimal payload)
                const silentAudio = Buffer.alloc(3200).toString('base64'); // 100ms @ 16kHz mono
                await geminiSessionRef.current.sendRealtimeInput({
                    audio: {
                        data: silentAudio,
                        mimeType: 'audio/pcm;rate=16000',
                    },
                });
                S.lastActivityTimestamp = Date.now(); // Reset activity timestamp
                console.log('[Keepalive] Heartbeat sent successfully');
            } catch (error) {
                console.error('[Keepalive] Failed to send heartbeat:', error);
                // Session likely dead - trigger reconnect
                if (S.sessionParams && S.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    console.log('[Keepalive] Session appears dead, triggering reconnect');
                    stopKeepalive(); // Stop keepalive before reconnect
                    attemptReconnect();
                }
            }
        }
    }, KEEPALIVE_INTERVAL_MS);

    console.log('[Keepalive] Started (check interval:', KEEPALIVE_INTERVAL_MS / 1000 / 60, 'min)');
}

function stopKeepalive() {
    if (S.sessionKeepaliveTimer) {
        clearInterval(S.sessionKeepaliveTimer);
        S.sessionKeepaliveTimer = null;
        console.log('[Keepalive] Stopped');
    }
}

function updateActivityTimestamp() {
    S.lastActivityTimestamp = Date.now();
}

function setupGeminiIpcHandlers(geminiSessionRef) {
    // Store the geminiSessionRef globally for reconnection access
    global.geminiSessionRef = geminiSessionRef;

    ipcMain.handle('initialize-cloud', async (_event, token, profile, userContext) => {
        try {
            S.currentProviderMode = 'cloud';
            initializeNewSession(profile);
            setOnTurnComplete((transcription, response) => {
                saveConversationTurn(transcription, response);
            });
            sendToRenderer('session-initializing', true);
            await connectCloud(token, profile, userContext);
            sendToRenderer('session-initializing', false);
            return true;
        } catch (err) {
            console.error('[Cloud] Init error:', err);
            S.currentProviderMode = 'byok';
            sendToRenderer('session-initializing', false);
            return false;
        }
    });

    ipcMain.handle('initialize-gemini', async (_event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
        S.currentProviderMode = 'byok';
        const session = await initializeGeminiSession(apiKey, customPrompt, profile, language);
        if (session) {
            geminiSessionRef.current = session;
            return true;
        }
        return false;
    });

    ipcMain.handle('initialize-local', async (_event, ollamaHost, ollamaModel, whisperModel, profile, customPrompt) => {
        S.currentProviderMode = 'local';
        const success = await getLocalAi().initializeLocalSession(ollamaHost, ollamaModel, whisperModel, profile, customPrompt);
        if (!success) {
            S.currentProviderMode = 'byok';
        }
        return success;
    });

    ipcMain.handle('initialize-whisper', async (_event, customPrompt, profile = 'interview') => {
        // Tear down any live Gemini session so its transcription callbacks
        // can't race the Whisper VAD (double-driving currentTranscription).
        if (geminiSessionRef.current) {
            try {
                S.isUserClosing = true;
                stopKeepalive(); // Stop keepalive when closing session
                geminiSessionRef.current.close();
            } catch (_) {
                /* already closed */
            }
            geminiSessionRef.current = null;
        }
        S.sessionParams = null; // disable Gemini auto-reconnect
        S.currentTranscription = '';
        S.lastProcessedIntent = null; // fresh session: allow re-asking earlier questions

        S.currentProviderMode = 'whisper';
        const systemPrompt = getSystemPrompt(profile, customPrompt, false);
        S.currentSystemPrompt = systemPrompt;
        initializeNewSession(profile, customPrompt);
        S.sessionReadyAt = Date.now(); // no Gemini startup noise — warmup not needed

        // Callback fires when Whisper VAD detects end of speech and gets a transcript.
        // Routing here is IMMEDIATE (per detected utterance) — the question and
        // its streamed answer render in the same cycle, and the VAD has already
        // re-armed for the next question before this promise resolves.
        function onWhisperTranscription(transcript) {
            if (!transcript || transcript.trim() === '') return;
            routeAnswer(transcript);
        }

        startWhisperVAD(onWhisperTranscription);
        sendToRenderer('update-status', 'Live');
        console.log('[Whisper] Mode initialized — profile:', profile);
        return true;
    });

    ipcMain.handle('initialize-anthropic', async (_event, customPrompt, profile = 'interview') => {
        S.currentProviderMode = 'anthropic';
        const systemPrompt = getSystemPrompt(profile, customPrompt, false);
        S.currentSystemPrompt = systemPrompt;
        initializeNewSession(profile, customPrompt);
        S.sessionReadyAt = Date.now();

        function onWhisperTranscription(transcript) {
            if (!transcript || transcript.trim() === '') return;
            queueForAnthropic(transcript);
        }

        startWhisperVAD(onWhisperTranscription);
        sendToRenderer('update-status', 'Claude Live');
        console.log('[Anthropic] Mode initialized — profile:', profile);
        return true;
    });

    ipcMain.handle('send-audio-content', async (_event, { data, mimeType }) => {
        if (S.currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (S.currentProviderMode === 'local') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                getLocalAi().processLocalAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending local audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };
        try {
            process.stdout.write('.');
            await geminiSessionRef.current.sendRealtimeInput({
                audio: { data: data, mimeType: mimeType },
            });
            return { success: true };
        } catch (error) {
            console.error('Error sending system audio:', error);
            return { success: false, error: error.message };
        }
    });

    // Handle microphone audio on a separate channel
    ipcMain.handle('send-mic-audio-content', async (_event, { data, mimeType }) => {
        if (S.currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud mic audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (S.currentProviderMode === 'local') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                getLocalAi().processLocalAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending local mic audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };
        try {
            process.stdout.write(',');
            await geminiSessionRef.current.sendRealtimeInput({
                audio: { data: data, mimeType: mimeType },
            });
            return { success: true };
        } catch (error) {
            console.error('Error sending mic audio:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-image-content', async (_event, { data, prompt }) => {
        try {
            if (!data || typeof data !== 'string') {
                console.error('Invalid image data received');
                return { success: false, error: 'Invalid image data' };
            }

            const buffer = Buffer.from(data, 'base64');

            if (buffer.length < 1000) {
                console.error(`Image buffer too small: ${buffer.length} bytes`);
                return { success: false, error: 'Image buffer too small' };
            }

            process.stdout.write('!');

            if (S.currentProviderMode === 'cloud') {
                const sent = sendCloudImage(data);
                if (!sent) {
                    return { success: false, error: 'Cloud connection not active' };
                }
                return { success: true, model: 'cloud' };
            }

            if (S.currentProviderMode === 'local') {
                const result = await getLocalAi().sendLocalImage(data, prompt);
                return result;
            }

            // Route to the active provider's vision path (Gemini / Anthropic /
            // Groq), with fallbacks. Uses the multi-image path (it delegates a
            // single image to the single-image path internally).
            return await routeImagesToProvider([data], prompt);
        } catch (error) {
            console.error('Error sending image:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-multiple-images-content', async (_event, { images, prompt }) => {
        try {
            if (!images || !Array.isArray(images) || images.length === 0) {
                return { success: false, error: 'No images provided' };
            }

            if (S.currentProviderMode === 'cloud') {
                // Cloud only supports single image - send the first one
                const sent = sendCloudImage(images[0]);
                return sent ? { success: true, model: 'cloud' } : { success: false, error: 'Cloud connection not active' };
            }

            if (S.currentProviderMode === 'local') {
                // Local AI - analyze first image with full prompt
                const result = await getLocalAi().sendLocalImage(images[0], prompt);
                return result;
            }

            // Route to the active provider's vision path (Gemini / Anthropic /
            // Groq), with fallbacks.
            return await routeImagesToProvider(images, prompt);
        } catch (error) {
            console.error('Error sending multiple images:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-text-message', async (_event, text) => {
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return { success: false, error: 'Invalid text message' };
        }

        if (S.currentProviderMode === 'cloud') {
            try {
                console.log('Sending text to cloud:', text);
                sendCloudText(text.trim());
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud text:', error);
                return { success: false, error: error.message };
            }
        }

        if (S.currentProviderMode === 'local') {
            try {
                console.log('Sending text to local Ollama:', text);
                return await getLocalAi().sendLocalText(text.trim());
            } catch (error) {
                console.error('Error sending local text:', error);
                return { success: false, error: error.message };
            }
        }

        if (S.currentProviderMode === 'anthropic') {
            queueForAnthropic(text.trim());
            return { success: true };
        }

        if (S.currentProviderMode === 'whisper') {
            routeAnswer(text.trim());
            return { success: true };
        }

        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };

        try {
            console.log('Sending text message:', text);

            routeAnswer(text.trim());

            await geminiSessionRef.current.sendRealtimeInput({ text: text.trim() });
            return { success: true };
        } catch (error) {
            console.error('Error sending text:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-macos-audio', async _event => {
        if (process.platform !== 'darwin') {
            return {
                success: false,
                error: 'macOS audio capture only available on macOS',
            };
        }

        try {
            const success = await startMacOSAudioCapture(geminiSessionRef);
            return { success };
        } catch (error) {
            console.error('Error starting macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-macos-audio', async _event => {
        try {
            stopMacOSAudioCapture();
            return { success: true };
        } catch (error) {
            console.error('Error stopping macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('close-session', async _event => {
        try {
            stopMacOSAudioCapture();

            if (S.currentProviderMode === 'cloud') {
                closeCloud();
                S.currentProviderMode = 'byok';
                return { success: true };
            }

            if (S.currentProviderMode === 'local') {
                getLocalAi().closeLocalSession();
                S.currentProviderMode = 'byok';
                return { success: true };
            }

            if (S.currentProviderMode === 'whisper' || S.currentProviderMode === 'anthropic') {
                stopWhisperVAD();
                S.currentProviderMode = 'byok';
                return { success: true };
            }

            // Set flag to prevent reconnection attempts
            S.isUserClosing = true;
            S.sessionParams = null;

            // Stop keepalive timer
            stopKeepalive();

            // Cleanup session
            if (geminiSessionRef.current) {
                await geminiSessionRef.current.close();
                geminiSessionRef.current = null;
            }

            return { success: true };
        } catch (error) {
            console.error('Error closing session:', error);
            return { success: false, error: error.message };
        }
    });

    // Conversation history IPC handlers
    ipcMain.handle('get-current-session', async _event => {
        try {
            return { success: true, data: getCurrentSessionData() };
        } catch (error) {
            console.error('Error getting current session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-new-session', async _event => {
        try {
            initializeNewSession();
            return { success: true, sessionId: S.currentSessionId };
        } catch (error) {
            console.error('Error starting new session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('update-google-search-setting', async (_event, enabled) => {
        try {
            console.log('Google Search setting updated to:', enabled);
            // The setting is already saved in localStorage by the renderer
            // This is just for logging/confirmation
            return { success: true };
        } catch (error) {
            console.error('Error updating Google Search setting:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    initializeGeminiSession,
    getEnabledTools,
    getStoredSetting,
    sendToRenderer,
    initializeNewSession,
    saveConversationTurn,
    getCurrentSessionData,
    killExistingSystemAudioDump,
    startMacOSAudioCapture,
    convertStereoToMono,
    stopMacOSAudioCapture,
    sendAudioToGemini,
    sendImageToGeminiHttp,
    sendMultipleImagesToGeminiHttp,
    setupGeminiIpcHandlers,
    formatSpeakerResults,
};
