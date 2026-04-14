const { GoogleGenAI, Modality } = require('@google/genai');
const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { saveDebugAudio } = require('../audioUtils');
const { getSystemPrompt } = require('./prompts');
const { getAvailableModel, incrementLimitCount, getApiKey, getGroqApiKey, getAnthropicApiKey, incrementCharUsage, getModelForToday, saveSession: persistSession } = require('../storage');
const { connectCloud, sendCloudAudio, sendCloudText, sendCloudImage, closeCloud, setOnTurnComplete } = require('./cloud');
const { startWhisperVAD, stopWhisperVAD, processAudioChunk: processWhisperChunk } = require('./whisper');

// Lazy-loaded to avoid circular dependency (localai.js imports from gemini.js)
let _localai = null;
function getLocalAi() {
    if (!_localai) _localai = require('./localai');
    return _localai;
}

// Provider mode: 'byok', 'cloud', or 'local'
let currentProviderMode = 'byok';

// Groq conversation history for context
let groqConversationHistory = [];

// Conversation tracking variables
let currentSessionId = null;
let currentTranscription = '';
let conversationHistory = [];
let screenAnalysisHistory = [];
let currentProfile = null;
let currentCustomPrompt = null;
let isInitializingSession = false;
let currentSystemPrompt = null;

function formatSpeakerResults(results) {
    let text = '';
    for (const result of results) {
        if (result.transcript && result.speakerId) {
            const speakerLabel = result.speakerId === 1 ? 'Interviewer' : 'Candidate';
            text += `[${speakerLabel}]: ${result.transcript}\n`;
        }
    }
    return text;
}

module.exports.formatSpeakerResults = formatSpeakerResults;

// Audio capture variables
let systemAudioProc = null;

// Silence detection: wait for a 1.2s pause after speech before triggering the LLM.
// Resets on every new transcription chunk.
let transcriptionSilenceTimer = null;
const SILENCE_THRESHOLD_MS = 1200;
let sessionReadyAt = 0;
const SESSION_WARMUP_MS = 2000;

// AbortController for in-flight Groq/Anthropic LLM requests
let currentGroqAbortController = null;

// Deduplication: don't re-process the same intent twice in a row
let lastProcessedIntent = '';

// Anthropic sequential question queue — processes questions one at a time in order.
// Max 2 pending items: if the backlog grows beyond that, the oldest pending is dropped
// so we never answer questions that are several turns out of date.
let anthropicQueue = [];
let anthropicProcessing = false;

function cancelSilenceTimer() {
    if (transcriptionSilenceTimer) {
        clearTimeout(transcriptionSilenceTimer);
        transcriptionSilenceTimer = null;
    }
}

function cancelProvisionalTimer() {
    // no-op: provisional tier removed; kept for call-site compatibility
}

function scheduleGroqTrigger() {
    if (Date.now() - sessionReadyAt < SESSION_WARMUP_MS) return;

    cancelSilenceTimer();

    transcriptionSilenceTimer = setTimeout(() => {
        transcriptionSilenceTimer = null;
        if (currentTranscription.trim() !== '') {
            if (hasGroqKey()) {
                sendToGroq(currentTranscription);
            } else {
                sendToGemma(currentTranscription);
            }
            currentTranscription = '';
        }
    }, SILENCE_THRESHOLD_MS);
}


// Reconnection variables
let isUserClosing = false;
let sessionParams = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 2000;

function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}

// Build context message for session restoration
function buildContextMessage() {
    const lastTurns = conversationHistory.slice(-20);
    const validTurns = lastTurns.filter(turn => turn.transcription?.trim() && turn.ai_response?.trim());

    if (validTurns.length === 0) return null;

    const contextLines = validTurns.map(turn =>
        `[Interviewer]: ${turn.transcription.trim()}\n[Your answer]: ${turn.ai_response.trim()}`
    );

    return `Session reconnected. Here's the conversation so far:\n\n${contextLines.join('\n\n')}\n\nContinue from here.`;
}

// Conversation management functions
function initializeNewSession(profile = null, customPrompt = null) {
    currentSessionId = Date.now().toString();
    currentTranscription = '';
    conversationHistory = [];
    screenAnalysisHistory = [];
    groqConversationHistory = [];
    cancelSilenceTimer();
    sessionReadyAt = 0;
    lastProcessedIntent = '';
    anthropicQueue = [];
    anthropicProcessing = false;
    currentProfile = profile;
    currentCustomPrompt = customPrompt;
    console.log('New conversation session started:', currentSessionId, 'profile:', profile);

    // Persist session context to disk immediately (no IPC round-trip)
    if (profile) {
        persistSession(currentSessionId, { profile, customPrompt: customPrompt || '' });
        sendToRenderer('save-session-context', {
            sessionId: currentSessionId,
            profile: profile,
            customPrompt: customPrompt || ''
        });
    }
}

function saveConversationTurn(transcription, aiResponse) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const conversationTurn = {
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: aiResponse.trim(),
    };

    conversationHistory.push(conversationTurn);

    // Write directly to disk from main process — survives crashes and renderer busy states
    persistSession(currentSessionId, { conversationHistory });
    console.log('Saved conversation turn:', conversationTurn);

    // Also notify renderer (for HistoryView live updates)
    sendToRenderer('save-conversation-turn', {
        sessionId: currentSessionId,
        turn: conversationTurn,
        fullHistory: conversationHistory,
    });
}

function saveScreenAnalysis(prompt, response, model) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const analysisEntry = {
        timestamp: Date.now(),
        prompt: prompt,
        response: response.trim(),
        model: model
    };

    screenAnalysisHistory.push(analysisEntry);

    // Write directly to disk from main process
    persistSession(currentSessionId, { screenAnalysisHistory });
    console.log('Saved screen analysis:', analysisEntry);

    // Also notify renderer (for HistoryView live updates)
    sendToRenderer('save-screen-analysis', {
        sessionId: currentSessionId,
        analysis: analysisEntry,
        fullHistory: screenAnalysisHistory,
        profile: currentProfile,
        customPrompt: currentCustomPrompt
    });
}

function getCurrentSessionData() {
    return {
        sessionId: currentSessionId,
        history: conversationHistory,
    };
}

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

// helper to check if groq has been configured
function hasGroqKey() {
    const key = getGroqApiKey();
    return key && key.trim() != ''
}

const CLEAN_TRANSCRIPTION_SYSTEM_PROMPT = `You are an input preprocessing layer for a live interview AI assistant.

Steps (in order):
1. CLEAN: Remove filler words (um, uh, like, so, you know, basically, right, okay, actually), false starts, and repeated words.
2. LANGUAGE CHECK: If the input is not in English, set response = "Please ask your question in English." and intent = "non-english".
3. INTENT: Extract the clean question or request. Fix typos, handle accents, infer intent — do not be literal.
   - Simple questions: one concise sentence.
   - Complex/multi-part questions (system design, coding challenges, scenario-based, long explanations): preserve ALL key constraints and requirements. Write 2-3 sentences if needed — do NOT over-compress. The main LLM needs the full scope to give a good answer.
   - Long rambling input: cut the filler, keep every piece of substance.
4. CLARITY CHECK: If input is pure noise, a single random word, or completely unintelligible, set response = "Could you repeat that? I didn't catch your question."

Return ONLY valid JSON — no markdown, no extra text:
{"intent": "full clean question preserving all key details", "response": null, "state": "final"}

Rules:
- response = null means the question is clear — main LLM will answer it
- response = string means show this text directly, skip main LLM
- Input is always from an interviewer asking a software engineering candidate a question`;

// LLM middleware: cleans STT noise, detects language, extracts intent.
// Routes to Anthropic when in anthropic mode to avoid Groq 429s.
// Returns { intent, response, state }
//   response = null → call main LLM
//   response = text → show directly (non-English rejection or clarification request)
async function cleanTranscription(rawText, state = 'final') {
    if (currentProviderMode === 'anthropic') {
        return cleanTranscriptionWithAnthropic(rawText, state);
    }

    const groqApiKey = getGroqApiKey();
    if (!groqApiKey) return { intent: rawText, response: null, state };

    try {
        const apiResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${groqApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'llama-3.1-8b-instant',
                messages: [
                    { role: 'system', content: CLEAN_TRANSCRIPTION_SYSTEM_PROMPT },
                    { role: 'user', content: rawText },
                ],
                max_tokens: 150,
                temperature: 0.1,
                stream: false,
            }),
        });

        if (!apiResponse.ok) return { intent: rawText, response: null, state };

        const json = await apiResponse.json();
        const content = json.choices?.[0]?.message?.content?.trim() || '';
        const result = JSON.parse(content);
        return {
            intent: result.intent || rawText,
            response: result.response || null,
            state: state,
        };
    } catch (e) {
        return { intent: rawText, response: null, state };
    }
}

// Retry fetch for Anthropic API — handles 429 (rate limit), 529 (overloaded), 500/503 (server error).
// Respects abort signal: if the request is aborted mid-retry, returns null immediately.
// Reads Retry-After header when present.
async function fetchWithAnthropicRetry(url, options, label = 'Anthropic') {
    const MAX_RETRIES = 3;
    let delay = 1000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (options.signal?.aborted) return null;

        let response;
        try {
            response = await fetch(url, options);
        } catch (err) {
            if (err.name === 'AbortError') return null;
            throw err;
        }

        if (response.ok) return response;

        const status = response.status;
        const isRetryable = status === 429 || status === 529 || status === 500 || status === 503;

        if (isRetryable && attempt < MAX_RETRIES) {
            const retryAfterHeader = response.headers?.get('retry-after');
            const waitMs = retryAfterHeader
                ? Math.min(parseInt(retryAfterHeader, 10) * 1000, 10000)
                : delay;
            console.log(`[${label}] ${status} — retry ${attempt + 1}/${MAX_RETRIES} in ${waitMs}ms`);
            sendToRenderer('update-status', `Retrying... (${attempt + 1}/${MAX_RETRIES})`);
            await new Promise(r => setTimeout(r, waitMs));
            delay = Math.min(delay * 2, 8000);
            continue;
        }

        return response; // non-retryable or max retries exhausted
    }
    return null;
}

async function cleanTranscriptionWithAnthropic(rawText, state = 'final') {
    const anthropicApiKey = getAnthropicApiKey();
    if (!anthropicApiKey) return { intent: rawText, response: null, state };

    try {
        const apiResponse = await fetchWithAnthropicRetry(
            'https://api.anthropic.com/v1/messages',
            {
                method: 'POST',
                headers: {
                    'x-api-key': anthropicApiKey,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 200,
                    system: CLEAN_TRANSCRIPTION_SYSTEM_PROMPT,
                    messages: [{ role: 'user', content: rawText }],
                }),
            },
            'Haiku-middleware'
        );

        if (!apiResponse || !apiResponse.ok) return { intent: rawText, response: null, state };

        const json = await apiResponse.json();
        const content = json.content?.[0]?.text?.trim() || '';
        const result = JSON.parse(content);
        return {
            intent: result.intent || rawText,
            response: result.response || null,
            state: state,
        };
    } catch (e) {
        return { intent: rawText, response: null, state };
    }
}

function trimConversationHistoryForGemma(history, maxChars=42000) {
    if(!history || history.length === 0) return [];
    let totalChars = 0;
    const trimmed = [];

    for(let i = history.length - 1; i >= 0; i--) {
        const turn = history[i];
        const turnChars = (turn.content || '').length;

        if(totalChars + turnChars > maxChars) break;
        totalChars += turnChars;
        trimmed.unshift(turn);
    }
    return trimmed;
}

function stripThinkingTags(text) {
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

async function sendToGroq(transcription) {
    const groqApiKey = getGroqApiKey();
    if (!groqApiKey) {
        console.log('No Groq API key configured, skipping Groq response');
        return;
    }

    if (!transcription || transcription.trim() === '') {
        console.log('Empty transcription, skipping Groq');
        return;
    }

    // Cancel any in-flight request before starting a new one
    if (currentGroqAbortController) {
        currentGroqAbortController.abort();
        currentGroqAbortController = null;
    }

    // Bypassing middleware (cleanTranscription) to achieve real-time (1-2s) performance.
    // The STT intent will be sent directly to the model.
    const intent = transcription.trim();
    const state = 'final';
    const preflight = null;

    console.log(`STT [${state}] | "${intent.substring(0, 80)}"`);

    // Non-English or clarification needed — show the preflight response directly
    if (preflight) {
        sendToRenderer('new-response', preflight);
        sendToRenderer('update-status', 'Listening...');
        return;
    }

    // Deduplicate: skip if same intent is already answered
    if (intent === lastProcessedIntent) {
        console.log('[Middleware] Duplicate intent, skipping');
        return;
    }
    lastProcessedIntent = intent;

    const questionToAnswer = intent;
    const assumptionPrefix = '';

    const modelToUse = getModelForToday();
    if (!modelToUse) {
        console.log('All Groq daily limits exhausted');
        sendToRenderer('update-status', 'Groq limits reached for today');
        return;
    }

    console.log(`Sending to Groq (${modelToUse}):`, questionToAnswer.substring(0, 100) + '...');

    groqConversationHistory.push({
        role: 'user',
        content: questionToAnswer.trim()
    });

    if (groqConversationHistory.length > 20) {
        groqConversationHistory = groqConversationHistory.slice(-20);
    }

    try {
        currentGroqAbortController = new AbortController();
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${groqApiKey}`,
                'Content-Type': 'application/json'
            },
            signal: currentGroqAbortController.signal,
            body: JSON.stringify({
                model: modelToUse,
                messages: [
                    { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
                    ...groqConversationHistory
                ],
                stream: true,
                temperature: 0.7,
                max_tokens: 1024,
                reasoning_effort: 'none'
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Groq API error:', response.status, errorText);
            sendToRenderer('update-status', `Groq error: ${response.status}`);
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let inThinkBlock = false;
        let streamBuffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            streamBuffer += decoder.decode(value, { stream: true });
            const lines = streamBuffer.split('\n');
            streamBuffer = lines.pop();

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine.startsWith('data: ')) {
                    const data = trimmedLine.slice(6);
                    if (data === '[DONE]') continue;

                    try {
                        const json = JSON.parse(data);
                        const token = json.choices?.[0]?.delta?.content || '';
                        if (token) {
                            fullText += token;
                            // Track think blocks to avoid rendering them during streaming
                            if (fullText.includes('<think>')) inThinkBlock = true;
                            if (inThinkBlock && fullText.includes('</think>')) inThinkBlock = false;
                            if (!inThinkBlock) {
                                const displayText = stripThinkingTags(fullText);
                                if (displayText) {
                                    sendToRenderer('update-response', assumptionPrefix + displayText);
                                }
                            }
                        }
                    } catch (parseError) {
                        // Skip invalid JSON chunks
                    }
                }
            }
        }

        const cleanedResponse = stripThinkingTags(fullText);
        const modelKey = modelToUse.split('/').pop();

        const systemPromptChars = (currentSystemPrompt || 'You are a helpful assistant.').length;
        const historyChars = groqConversationHistory.reduce((sum, msg) => sum + (msg.content || '').length, 0);
        const inputChars = systemPromptChars + historyChars;
        const outputChars = cleanedResponse.length;

        incrementCharUsage('groq', modelKey, inputChars + outputChars);

        if (cleanedResponse) {
            groqConversationHistory.push({
                role: 'assistant',
                content: cleanedResponse
            });

            saveConversationTurn(questionToAnswer, cleanedResponse);
        }

        console.log(`Groq response completed (${modelToUse})`);
        sendToRenderer('update-status', 'Listening...');

    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('[Groq] Request cancelled — new input arrived');
            return;
        }
        console.error('Error calling Groq API:', error);
        sendToRenderer('update-status', 'Groq error: ' + error.message);
    } finally {
        currentGroqAbortController = null;
    }
}

async function sendToGemma(transcription) {
    const apiKey = getApiKey();
    if (!apiKey) {
        console.log('No Gemini API key configured');
        return;
    }

    if (!transcription || transcription.trim() === '') {
        console.log('Empty transcription, skipping Gemma');
        return;
    }

    console.log('Sending to Gemma:', transcription.substring(0, 100) + '...');

    groqConversationHistory.push({
        role: 'user',
        content: transcription.trim()
    });

    const trimmedHistory = trimConversationHistoryForGemma(groqConversationHistory, 42000);

    try {
        const ai = new GoogleGenAI({ apiKey: apiKey });

        const messages = trimmedHistory.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        }));

        const systemPrompt = currentSystemPrompt || 'You are a helpful assistant.';
        const messagesWithSystem = [
            { role: 'user', parts: [{ text: systemPrompt }] },
            { role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] },
            ...messages
        ];

        const response = await ai.models.generateContentStream({
            model: 'gemma-3-27b-it',
            contents: messagesWithSystem,
        });

        let fullText = '';

        for await (const chunk of response) {
            const chunkText = chunk.text;
            if (chunkText) {
                fullText += chunkText;
                sendToRenderer('update-response', fullText);
            }
        }

        const systemPromptChars = (currentSystemPrompt || 'You are a helpful assistant.').length;
        const historyChars = trimmedHistory.reduce((sum, msg) => sum + (msg.content || '').length, 0);
        const inputChars = systemPromptChars + historyChars;
        const outputChars = fullText.length;

        incrementCharUsage('gemini', 'gemma-3-27b-it', inputChars + outputChars);

        if (fullText.trim()) {
            groqConversationHistory.push({
                role: 'assistant',
                content: fullText.trim()
            });

            if (groqConversationHistory.length > 40) {
                groqConversationHistory = groqConversationHistory.slice(-40);
            }

            saveConversationTurn(transcription, fullText);
        }

        console.log('Gemma response completed');
        sendToRenderer('update-status', 'Listening...');

    } catch (error) {
        console.error('Error calling Gemma API:', error);
        sendToRenderer('update-status', 'Gemma error: ' + error.message);
    }
}

// Enqueue a transcription for sequential Anthropic processing.
// Keeps at most 2 pending items — drops the oldest pending entry when the backlog
// exceeds that limit so we never answer questions that are several turns stale.
function queueForAnthropic(transcription) {
    if (!transcription || transcription.trim() === '') return;

    if (anthropicQueue.length >= 2) {
        // Drop oldest pending — it's stale relative to what the interviewer just said
        anthropicQueue.shift();
    }
    anthropicQueue.push(transcription.trim());

    if (!anthropicProcessing) {
        drainAnthropicQueue();
    }
}

async function drainAnthropicQueue() {
    if (anthropicProcessing) return;
    anthropicProcessing = true;

    while (anthropicQueue.length > 0) {
        const next = anthropicQueue.shift();
        await sendToAnthropic(next);
    }

    anthropicProcessing = false;
}

async function sendToAnthropic(transcription) {
    const anthropicApiKey = getAnthropicApiKey();
    if (!anthropicApiKey) {
        console.log('No Anthropic API key configured, skipping');
        return;
    }

    if (!transcription || transcription.trim() === '') {
        console.log('Empty transcription, skipping Anthropic');
        return;
    }

    // Signal to the UI immediately — card appears while middleware runs
    sendToRenderer('new-response', '...');
    sendToRenderer('update-status', 'Processing...');

    // Middleware skipped to achieve < 2s real-time performance.
    const intent = transcription.trim();
    const state = 'final';
    const preflight = null;
    
    console.log(`[Anthropic STT] [${state}] | "${intent.substring(0, 80)}"`);

    if (preflight) {
        sendToRenderer('update-response', preflight);
        sendToRenderer('update-status', 'Listening...');
        return;
    }

    if (intent === lastProcessedIntent) {
        console.log('[Anthropic] Duplicate intent, skipping');
        return;
    }
    lastProcessedIntent = intent;

    const questionToAnswer = intent;

    groqConversationHistory.push({ role: 'user', content: questionToAnswer.trim() });
    if (groqConversationHistory.length > 20) {
        groqConversationHistory = groqConversationHistory.slice(-20);
    }

    // Build messages array (Anthropic format: no system in messages array)
    const messages = groqConversationHistory.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
    }));

    console.log(`[Anthropic] Sending to claude-sonnet-4-6: "${questionToAnswer.substring(0, 80)}..."`);
    sendToRenderer('update-status', 'Thinking...');

    try {
        currentGroqAbortController = new AbortController();
        const response = await fetchWithAnthropicRetry(
            'https://api.anthropic.com/v1/messages',
            {
                method: 'POST',
                headers: {
                    'x-api-key': anthropicApiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-beta': 'prompt-caching-2024-07-31',
                    'content-type': 'application/json',
                },
                signal: currentGroqAbortController.signal,
                body: JSON.stringify({
                    model: 'claude-sonnet-4-6',
                    max_tokens: 4096,
                    system: [
                        {
                            type: 'text',
                            text: currentSystemPrompt || 'You are a helpful assistant.',
                            cache_control: { type: 'ephemeral' }
                        }
                    ],
                    messages,
                    stream: true,
                }),
            },
            'Sonnet'
        );

        if (!response) {
            // Aborted — new input arrived, silently discard
            return;
        }

        if (!response.ok) {
            const errText = await response.text();
            console.error('[Anthropic] API error after retries:', response.status, errText);
            sendToRenderer('update-status', `Claude error ${response.status} — please try again`);
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let streamBuffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            streamBuffer += decoder.decode(value, { stream: true });
            const lines = streamBuffer.split('\n');
            streamBuffer = lines.pop();

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine.startsWith('data: ')) continue;
                const data = trimmedLine.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const json = JSON.parse(data);
                    if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
                        fullText += json.delta.text;
                        sendToRenderer('update-response', fullText);
                    }
                } catch (_) {
                    // skip malformed SSE lines
                }
            }
        }

        if (fullText) {
            groqConversationHistory.push({ role: 'assistant', content: fullText });
            saveConversationTurn(questionToAnswer, fullText);
        }

        console.log('[Anthropic] Response completed');
        sendToRenderer('update-status', 'Listening...');

    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('[Anthropic] Request cancelled — new input arrived');
            return;
        }
        console.error('[Anthropic] Error:', error);
        sendToRenderer('update-status', 'Claude error: ' + error.message);
    } finally {
        currentGroqAbortController = null;
    }
}

async function initializeGeminiSession(apiKey, customPrompt = '', profile = 'interview', language = 'en-US', isReconnect = false) {
    if (isInitializingSession) {
        console.log('Session initialization already in progress');
        return false;
    }

    isInitializingSession = true;
    if (!isReconnect) {
        sendToRenderer('session-initializing', true);
    }

    // Store params for reconnection
    if (!isReconnect) {
        sessionParams = { apiKey, customPrompt, profile, language };
        reconnectAttempts = 0;
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
    currentSystemPrompt = systemPrompt; // Store for Groq

    // Initialize new conversation session only on first connect
    if (!isReconnect) {
        initializeNewSession(profile, customPrompt);
    }

    try {
        const session = await client.live.connect({
            model: 'gemini-2.5-flash-native-audio-preview-09-2025',
            callbacks: {
                onopen: function () {
                    sessionReadyAt = Date.now();
                    sendToRenderer('update-status', 'Live session connected');
                },
                onmessage: function (message) {
                    console.log('----------------', message);

                    // Handle input transcription (what was spoken)
                    // Each chunk resets the silence timer — Groq fires ~700ms after user stops speaking,
                    // long before Gemini finishes generating its audio response.
                    if (message.serverContent?.inputTranscription?.results) {
                        currentTranscription += formatSpeakerResults(message.serverContent.inputTranscription.results);
                        scheduleGroqTrigger();
                    } else if (message.serverContent?.inputTranscription?.text) {
                        const text = message.serverContent.inputTranscription.text;
                        if (text.trim() !== '') {
                            currentTranscription += text;
                            scheduleGroqTrigger();
                        }
                    }

                    // DISABLED: Gemini's outputTranscription - using Groq for faster responses instead
                    // if (message.serverContent?.outputTranscription?.text) { ... }



                    if (message.serverContent?.turnComplete) {
                        sendToRenderer('update-status', 'Listening...');
                        // Cancel any pending silence timer — turnComplete is the definitive end of turn
                        if (transcriptionSilenceTimer) {
                            clearTimeout(transcriptionSilenceTimer);
                            transcriptionSilenceTimer = null;
                        }
                        // Fallback: if silence timer didn't already fire (e.g. no transcription events came through)
                        if (currentTranscription.trim() !== '') {
                            sendToRenderer('new-response', '...');
                            if (hasGroqKey()) {
                                sendToGroq(currentTranscription);
                            } else {
                                sendToGemma(currentTranscription);
                            }
                            currentTranscription = '';
                        }
                    }
                },
                onerror: function (e) {
                    console.log('Session error:', e.message);
                    sendToRenderer('update-status', 'Error: ' + e.message);
                },
                onclose: function (e) {
                    console.log('Session closed:', e.reason);

                    // Don't reconnect if user intentionally closed
                    if (isUserClosing) {
                        isUserClosing = false;
                        sendToRenderer('update-status', 'Session closed');
                        return;
                    }

                    // Attempt reconnection
                    if (sessionParams && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                        attemptReconnect();
                    } else {
                        sendToRenderer('update-status', 'Session closed');
                    }
                },
            },
            config: {
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
            },
        });

        isInitializingSession = false;
        if (!isReconnect) {
            sendToRenderer('session-initializing', false);
        }
        return session;
    } catch (error) {
        console.error('Failed to initialize Gemini session:', error);
        isInitializingSession = false;
        if (!isReconnect) {
            sendToRenderer('session-initializing', false);
        }
        return null;
    }
}

async function attemptReconnect() {
    reconnectAttempts++;
    console.log(`Reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);

    // Clear stale buffers and any pending silence timer
    currentTranscription = '';
    cancelSilenceTimer();
    cancelProvisionalTimer();
    sessionReadyAt = 0; // reset warmup guard until new session opens
    // Don't reset groqConversationHistory to preserve context across reconnects

    sendToRenderer('update-status', `Reconnecting... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    // Wait before attempting
    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));

    try {
        const session = await initializeGeminiSession(
            sessionParams.apiKey,
            sessionParams.customPrompt,
            sessionParams.profile,
            sessionParams.language,
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
        console.error(`Reconnection attempt ${reconnectAttempts} failed:`, error);
    }

    // If we still have attempts left, try again
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        return attemptReconnect();
    }

    // Max attempts reached - notify frontend
    console.log('Max reconnection attempts reached');
    sendToRenderer('reconnect-failed', {
        message: 'Tried 3 times to reconnect. Must be upstream/network issues. Try restarting or download updated app from site.',
    });
    sessionParams = null;
    return false;
}

function killExistingSystemAudioDump() {
    return new Promise(resolve => {
        console.log('Checking for existing SystemAudioDump processes...');

        // Kill any existing SystemAudioDump processes
        const killProc = spawn('pkill', ['-f', 'SystemAudioDump'], {
            stdio: 'ignore',
        });

        killProc.on('close', code => {
            if (code === 0) {
                console.log('Killed existing SystemAudioDump processes');
            } else {
                console.log('No existing SystemAudioDump processes found');
            }
            resolve();
        });

        killProc.on('error', err => {
            console.log('Error checking for existing processes (this is normal):', err.message);
            resolve();
        });

        // Timeout after 2 seconds
        setTimeout(() => {
            killProc.kill();
            resolve();
        }, 2000);
    });
}

async function startMacOSAudioCapture(geminiSessionRef) {
    if (process.platform !== 'darwin') return false;

    // Kill any existing SystemAudioDump processes first
    await killExistingSystemAudioDump();

    console.log('Starting macOS audio capture with SystemAudioDump...');

    const { app } = require('electron');
    const path = require('path');

    let systemAudioPath;
    if (app.isPackaged) {
        systemAudioPath = path.join(process.resourcesPath, 'SystemAudioDump');
    } else {
        systemAudioPath = path.join(__dirname, '../assets', 'SystemAudioDump');
    }

    console.log('SystemAudioDump path:', systemAudioPath);

    const spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
        },
    };

    systemAudioProc = spawn(systemAudioPath, [], spawnOptions);

    if (!systemAudioProc.pid) {
        console.error('Failed to start SystemAudioDump');
        return false;
    }

    console.log('SystemAudioDump started with PID:', systemAudioProc.pid);

    const CHUNK_DURATION = 0.1;
    const SAMPLE_RATE = 24000;
    const BYTES_PER_SAMPLE = 2;
    const CHANNELS = 2;
    const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION;

    let audioBuffer = Buffer.alloc(0);
    let resampleRemainder = Buffer.alloc(0);

    function resample24kTo16k(inputBuffer) {
        const combined = Buffer.concat([resampleRemainder, inputBuffer]);
        const inputSamples = Math.floor(combined.length / 2);
        const outputSamples = Math.floor((inputSamples * 2) / 3);
        const outputBuffer = Buffer.alloc(outputSamples * 2);

        for (let i = 0; i < outputSamples; i++) {
            const srcPos = (i * 3) / 2;
            const srcIndex = Math.floor(srcPos);
            const frac = srcPos - srcIndex;

            const s0 = combined.readInt16LE(srcIndex * 2);
            const s1 = srcIndex + 1 < inputSamples ? combined.readInt16LE((srcIndex + 1) * 2) : s0;
            const interpolated = Math.round(s0 + frac * (s1 - s0));
            outputBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
        }

        const consumedInputSamples = Math.ceil((outputSamples * 3) / 2);
        const remainderStart = consumedInputSamples * 2;
        resampleRemainder = remainderStart < combined.length ? combined.slice(remainderStart) : Buffer.alloc(0);

        return outputBuffer;
    }

    systemAudioProc.stdout.on('data', data => {
        audioBuffer = Buffer.concat([audioBuffer, data]);

        while (audioBuffer.length >= CHUNK_SIZE) {
            const chunk = audioBuffer.slice(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.slice(CHUNK_SIZE);

            const monoChunk24k = CHANNELS === 2 ? convertStereoToMono(chunk) : chunk;
            const monoChunk16k = resample24kTo16k(monoChunk24k);

            if (currentProviderMode === 'whisper' || currentProviderMode === 'anthropic') {
                processWhisperChunk(monoChunk16k);
            } else if (currentProviderMode === 'cloud') {
                sendCloudAudio(monoChunk16k);
            } else if (currentProviderMode === 'local') {
                getLocalAi().processLocalAudio(monoChunk24k);
            } else {
                const base64Data = monoChunk16k.toString('base64');
                sendAudioToGemini(base64Data, geminiSessionRef);
            }

            if (process.env.DEBUG_AUDIO) {
                console.log(`Processed audio chunk: ${chunk.length} bytes`);
                saveDebugAudio(monoChunk16k, 'system_audio');
            }
        }

        const maxBufferSize = SAMPLE_RATE * BYTES_PER_SAMPLE * 1;
        if (audioBuffer.length > maxBufferSize) {
            audioBuffer = audioBuffer.slice(-maxBufferSize);
        }
    });

    systemAudioProc.stderr.on('data', data => {
        console.error('SystemAudioDump stderr:', data.toString());
    });

    systemAudioProc.on('close', code => {
        console.log('SystemAudioDump process closed with code:', code);
        systemAudioProc = null;
    });

    systemAudioProc.on('error', err => {
        console.error('SystemAudioDump process error:', err);
        systemAudioProc = null;
    });

    return true;
}

function convertStereoToMono(stereoBuffer) {
    const samples = stereoBuffer.length / 4;
    const monoBuffer = Buffer.alloc(samples * 2);

    for (let i = 0; i < samples; i++) {
        const leftSample = stereoBuffer.readInt16LE(i * 4);
        monoBuffer.writeInt16LE(leftSample, i * 2);
    }

    return monoBuffer;
}

function stopMacOSAudioCapture() {
    if (systemAudioProc) {
        console.log('Stopping SystemAudioDump...');
        systemAudioProc.kill('SIGTERM');
        systemAudioProc = null;
    }
    if (currentProviderMode === 'whisper' || currentProviderMode === 'anthropic') {
        stopWhisperVAD();
    }
}

async function sendAudioToGemini(base64Data, geminiSessionRef) {
    if (!geminiSessionRef.current) return;

    try {
        process.stdout.write('.');
        await geminiSessionRef.current.sendRealtimeInput({
            audio: {
                data: base64Data,
                mimeType: 'audio/pcm;rate=16000',
            },
        });
    } catch (error) {
        console.error('Error sending audio to Gemini:', error);
    }
}

async function sendImageToGeminiHttp(base64Data, prompt) {
    // Get available model based on rate limits
    const model = getAvailableModel();

    const apiKey = getApiKey();
    if (!apiKey) {
        return { success: false, error: 'No API key configured' };
    }

    try {
        const ai = new GoogleGenAI({ apiKey: apiKey });

        const contents = [
            {
                inlineData: {
                    mimeType: 'image/jpeg',
                    data: base64Data,
                },
            },
            { text: prompt },
        ];

        console.log(`Sending image to ${model} (streaming)...`);
        const response = await ai.models.generateContentStream({
            model: model,
            contents: contents,
        });

        // Increment count after successful call
        incrementLimitCount(model);

        // Stream the response — always use update-response because the renderer
        // already added a "..." placeholder before invoking this IPC handler
        let fullText = '';
        for await (const chunk of response) {
            const chunkText = chunk.text;
            if (chunkText) {
                fullText += chunkText;
                sendToRenderer('update-response', fullText);
            }
        }

        console.log(`Image response completed from ${model}`);

        // Save screen analysis to history
        saveScreenAnalysis(prompt, fullText, model);

        return { success: true, text: fullText, model: model };
    } catch (error) {
        console.error('Error sending image to Gemini HTTP:', error);
        return { success: false, error: error.message };
    }
}

async function sendMultipleImagesToGeminiHttp(images, prompt) {
    const model = getAvailableModel();
    const apiKey = getApiKey();
    if (!apiKey) {
        return { success: false, error: 'No API key configured' };
    }

    try {
        const ai = new GoogleGenAI({ apiKey: apiKey });

        const contents = [
            ...images.map(data => ({
                inlineData: { mimeType: 'image/jpeg', data },
            })),
            { text: prompt },
        ];

        console.log(`Sending ${images.length} images to ${model} (streaming)...`);
        const response = await ai.models.generateContentStream({
            model: model,
            contents: contents,
        });

        incrementLimitCount(model);

        // Always use update-response — renderer adds a "..." placeholder before invoking
        let fullText = '';
        for await (const chunk of response) {
            const chunkText = chunk.text;
            if (chunkText) {
                fullText += chunkText;
                sendToRenderer('update-response', fullText);
            }
        }

        console.log(`Multi-image response completed from ${model}`);
        saveScreenAnalysis(prompt, fullText, model);

        return { success: true, text: fullText, model: model };
    } catch (error) {
        console.error('Error sending images to Gemini HTTP:', error);
        return { success: false, error: error.message };
    }
}

function setupGeminiIpcHandlers(geminiSessionRef) {
    // Store the geminiSessionRef globally for reconnection access
    global.geminiSessionRef = geminiSessionRef;

    ipcMain.handle('initialize-cloud', async (_event, token, profile, userContext) => {
        try {
            currentProviderMode = 'cloud';
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
            currentProviderMode = 'byok';
            sendToRenderer('session-initializing', false);
            return false;
        }
    });

    ipcMain.handle('initialize-gemini', async (_event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
        currentProviderMode = 'byok';
        const session = await initializeGeminiSession(apiKey, customPrompt, profile, language);
        if (session) {
            geminiSessionRef.current = session;
            return true;
        }
        return false;
    });

    ipcMain.handle('initialize-local', async (_event, ollamaHost, ollamaModel, whisperModel, profile, customPrompt) => {
        currentProviderMode = 'local';
        const success = await getLocalAi().initializeLocalSession(ollamaHost, ollamaModel, whisperModel, profile, customPrompt);
        if (!success) {
            currentProviderMode = 'byok';
        }
        return success;
    });

    ipcMain.handle('initialize-whisper', async (_event, customPrompt, profile = 'interview') => {
        currentProviderMode = 'whisper';
        const systemPrompt = getSystemPrompt(profile, customPrompt, false);
        currentSystemPrompt = systemPrompt;
        initializeNewSession(profile, customPrompt);
        sessionReadyAt = Date.now(); // no Gemini startup noise — warmup not needed

        // Callback fires when Whisper VAD detects end of speech and gets a transcript
        function onWhisperTranscription(transcript) {
            if (!transcript || transcript.trim() === '') return;
            sendToRenderer('new-response', '...');
            if (hasGroqKey()) {
                sendToGroq(transcript);
            } else {
                sendToGemma(transcript);
            }
        }

        startWhisperVAD(onWhisperTranscription);
        sendToRenderer('update-status', 'Whisper Live');
        console.log('[Whisper] Mode initialized — profile:', profile);
        return true;
    });

    ipcMain.handle('initialize-anthropic', async (_event, customPrompt, profile = 'interview') => {
        currentProviderMode = 'anthropic';
        const systemPrompt = getSystemPrompt(profile, customPrompt, false);
        currentSystemPrompt = systemPrompt;
        initializeNewSession(profile, customPrompt);
        sessionReadyAt = Date.now();

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
        if (currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (currentProviderMode === 'local') {
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
        if (currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud mic audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (currentProviderMode === 'local') {
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

            if (currentProviderMode === 'cloud') {
                const sent = sendCloudImage(data);
                if (!sent) {
                    return { success: false, error: 'Cloud connection not active' };
                }
                return { success: true, model: 'cloud' };
            }

            if (currentProviderMode === 'local') {
                const result = await getLocalAi().sendLocalImage(data, prompt);
                return result;
            }

            // Use HTTP API instead of realtime session
            const result = await sendImageToGeminiHttp(data, prompt);
            return result;
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

            if (currentProviderMode === 'cloud') {
                // Cloud only supports single image - send the first one
                const sent = sendCloudImage(images[0]);
                return sent ? { success: true, model: 'cloud' } : { success: false, error: 'Cloud connection not active' };
            }

            if (currentProviderMode === 'local') {
                // Local AI - analyze first image with full prompt
                const result = await getLocalAi().sendLocalImage(images[0], prompt);
                return result;
            }

            const result = await sendMultipleImagesToGeminiHttp(images, prompt);
            return result;
        } catch (error) {
            console.error('Error sending multiple images:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-text-message', async (_event, text) => {
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return { success: false, error: 'Invalid text message' };
        }

        if (currentProviderMode === 'cloud') {
            try {
                console.log('Sending text to cloud:', text);
                sendCloudText(text.trim());
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud text:', error);
                return { success: false, error: error.message };
            }
        }

        if (currentProviderMode === 'local') {
            try {
                console.log('Sending text to local Ollama:', text);
                return await getLocalAi().sendLocalText(text.trim());
            } catch (error) {
                console.error('Error sending local text:', error);
                return { success: false, error: error.message };
            }
        }

        if (currentProviderMode === 'anthropic') {
            queueForAnthropic(text.trim());
            return { success: true };
        }

        if (currentProviderMode === 'whisper') {
            if (hasGroqKey()) {
                sendToGroq(text.trim());
            } else {
                sendToGemma(text.trim());
            }
            return { success: true };
        }

        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };

        try {
            console.log('Sending text message:', text);

            if (hasGroqKey()) {
                sendToGroq(text.trim());
            } else {
                sendToGemma(text.trim());
            }

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

            if (currentProviderMode === 'cloud') {
                closeCloud();
                currentProviderMode = 'byok';
                return { success: true };
            }

            if (currentProviderMode === 'local') {
                getLocalAi().closeLocalSession();
                currentProviderMode = 'byok';
                return { success: true };
            }

            if (currentProviderMode === 'whisper' || currentProviderMode === 'anthropic') {
                stopWhisperVAD();
                currentProviderMode = 'byok';
                return { success: true };
            }

            // Set flag to prevent reconnection attempts
            isUserClosing = true;
            sessionParams = null;

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
            return { success: true, sessionId: currentSessionId };
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
