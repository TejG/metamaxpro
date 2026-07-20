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
// How long to wait after the last speech chunk before answering. Lower = faster
// perceived response; too low triggers on natural mid-sentence pauses. 700ms is
// the sweet spot (ADR-003).
const SILENCE_THRESHOLD_MS = 700;
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

const PROGRAMMING_LANGUAGE_PATTERNS = [
    { language: 'Python', patterns: [/\bpython\b/i, /\bpy\b/i, /def\s+\w+\s*\(/i, /\bprint\s*\(/i] },
    { language: 'JavaScript', patterns: [/\bjavascript\b/i, /\bjs\b/i, /\bnode(\.js)?\b/i, /\bconsole\.log\s*\(/i, /=>/] },
    { language: 'TypeScript', patterns: [/\btypescript\b/i, /\bts\b/i, /interface\s+\w+/i, /:\s*(string|number|boolean|unknown|any)\b/i] },
    { language: 'Java', patterns: [/\bjava\b/i, /public\s+static\s+void\s+main/i, /System\.out\.println\s*\(/i] },
    { language: 'C++', patterns: [/\bc\+\+\b/i, /#include\s*<\w+>/i, /std::/i, /\bcout\s*<</i] },
    { language: 'C', patterns: [/\bc language\b/i, /\bc\b/i, /#include\s*<stdio\.h>/i, /printf\s*\(/i] },
    { language: 'C#', patterns: [/\bc#\b/i, /\bcsharp\b/i, /Console\.WriteLine\s*\(/i, /using\s+System;/i] },
    { language: 'Go', patterns: [/\bgolang\b/i, /\bgo\b/i, /package\s+main/i, /fmt\.Println\s*\(/i] },
    { language: 'Rust', patterns: [/\brust\b/i, /fn\s+main\s*\(/i, /println!\s*\(/i] },
    { language: 'Kotlin', patterns: [/\bkotlin\b/i, /fun\s+main\s*\(/i, /val\s+\w+\s*:/i] },
    { language: 'Swift', patterns: [/\bswift\b/i, /import\s+Foundation/i, /print\s*\(/i] },
    { language: 'Ruby', patterns: [/\bruby\b/i, /\brb\b/i, /puts\s+['"]/i, /def\s+\w+/i] },
    { language: 'PHP', patterns: [/\bphp\b/i, /<\?php/i, /echo\s+['"]/i] },
];

function looksLikeCodingExercise(text = '') {
    const t = (text || '').toLowerCase();
    if (!t) return false;
    return [
        'leetcode', 'hackerrank', 'coding challenge', 'algorithm', 'data structure',
        'time complexity', 'space complexity', 'implement', 'write a function',
        'write code', 'solve this', 'array', 'string', 'binary tree', 'linked list',
        'dynamic programming', 'dfs', 'bfs', 'two pointers', 'sliding window'
    ].some(k => t.includes(k));
}

function detectProgrammingLanguage(inputText = '', history = []) {
    const candidates = [inputText];

    // Include last few turns to preserve previously chosen language.
    if (Array.isArray(history) && history.length) {
        for (let i = history.length - 1; i >= 0 && candidates.length < 6; i--) {
            const msg = history[i];
            if (msg && msg.role === 'user' && typeof msg.content === 'string') {
                candidates.push(msg.content);
            }
        }
    }

    for (const text of candidates) {
        if (!text) continue;
        for (const rule of PROGRAMMING_LANGUAGE_PATTERNS) {
            if (rule.patterns.some(p => p.test(text))) {
                return { language: rule.language, source: text === inputText ? 'current-question' : 'recent-context' };
            }
        }
    }

    return { language: null, source: 'none' };
}

function buildLanguageLockInstruction(questionText, history = []) {
    if (!looksLikeCodingExercise(questionText)) {
        return null;
    }

    const detected = detectProgrammingLanguage(questionText, history);
    if (detected.language) {
        return `LANGUAGE LOCK: The programming language is ${detected.language} (detected from ${detected.source}). Answer this coding exercise using ONLY ${detected.language} syntax and idioms.`;
    }

    return 'LANGUAGE LOCK: Language is ambiguous. Infer from explicit prompt constraints first, then from visible code syntax. If still ambiguous, ask one short clarification question for language before providing code.';
}

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
            routeAnswer(currentTranscription);
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
    // Prefer the focused window, fall back to the first non-destroyed window, then index 0
    const target = BrowserWindow.getFocusedWindow() || windows.find(w => w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) || windows[0];
    if (target && target.webContents && !target.webContents.isDestroyed()) {
        try {
            target.webContents.send(channel, data);
        } catch (e) {
            console.error('sendToRenderer failed for channel', channel, e);
        }
    } else {
        console.warn('No renderer window available to send IPC:', channel);
    }
}

// Environment override for Gemini/fallback models
// Default to a current, vision-capable Gemini model name; allow env var to override.
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || process.env.GEMMA_FALLBACK_MODEL || 'gemini-flash-lite-latest';
const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-09-2025';

// Currently-valid Groq chat models, tried in order when the rotation's pick
// has been decommissioned (Groq 404s on retired model IDs). Keep this list to
// models Groq still serves; update if one starts 404ing.
const GROQ_FALLBACK_MODELS = [
    'openai/gpt-oss-120b',
    'llama-3.3-70b-versatile',
    'openai/gpt-oss-20b',
    'moonshotai/kimi-k2-instruct',
    'llama-3.1-8b-instant',
];

// Current, valid, vision-capable Gemini models used for screenshot solving,
// in order of preference. Kept in one place so the single- and multi-image
// paths stay in sync. (Previous list had invalid ids like 'gemini-1.5' /
// 'gemini-2.1' that only burned 404 retries before landing on a working model.)
// NOTE: gemini-2.5-pro is intentionally excluded — it is NOT available on the
// Gemini free tier (the API returns 429 with `limit: 0`), so including it only
// ever surfaced a misleading "quota exceeded for gemini-2.5-pro" error as the
// last fallback. Override via GEMINI_IMAGE_FALLBACKS if you have a paid key.
// Try the current GA Flash aliases first, then fall back to concrete, known-good
// free-tier models as a safety net if an alias ever resolves to something the
// key can't use. gemini-2.5-pro is intentionally absent (free-tier limit: 0).
const GEMINI_IMAGE_FALLBACKS = (process.env.GEMINI_IMAGE_FALLBACKS
    ? process.env.GEMINI_IMAGE_FALLBACKS.split(',').map(s => s.trim()).filter(Boolean)
    : ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);

// Build a deduped fallback list starting from the preferred model.
function buildImageModelFallbacks(preferred) {
    return [preferred, ...GEMINI_IMAGE_FALLBACKS].filter((m, i, arr) => m && arr.indexOf(m) === i);
}

function isModelNotFoundError(err) {
    if (!err) return false;
    const msg = (err.message || err.toString() || '').toLowerCase();
    if (msg.includes('not found') || msg.includes('no longer available') || msg.includes('models/') && msg.includes('is no longer')) return true;
    // Some clients attach a nested response object
    try {
        const body = err.response?.body || err.body || err.response?.data || null;
        const s = JSON.stringify(body || '');
        if (s.toLowerCase().includes('is no longer available') || s.toLowerCase().includes('not found')) return true;
    } catch (e) {
        // ignore
    }
    return false;
}

// True when the API rejected the request for quota / rate-limit reasons
// (HTTP 429 / RESOURCE_EXHAUSTED). On the free tier this fires both for
// per-minute rate limits (transient — worth trying another model) and for
// models with no free-tier access at all, e.g. gemini-2.5-pro (limit: 0).
function isRateLimitError(err) {
    if (!err) return false;
    const msg = (err.message || err.toString() || '').toLowerCase();
    const status = err.status || err.code || err.response?.status;
    if (status === 429) return true;
    return msg.includes('429') || msg.includes('too many requests') ||
        msg.includes('resource_exhausted') || msg.includes('quota');
}

// Extract the API-suggested retry delay (seconds) from a 429 body, if present.
function getRetryDelaySeconds(err) {
    try {
        const s = err && (err.message || err.toString() || '');
        const m = s.match(/retry(?:delay)?["\s:]*["']?(\d+(?:\.\d+)?)s/i) ||
            s.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
        if (m) return Math.ceil(parseFloat(m[1]));
    } catch (e) { /* ignore */ }
    return null;
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
        console.log('[STORAGE DEBUG] persistSession -> context', { sessionId: currentSessionId, profile, customPrompt: customPrompt || '' });
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
    console.log('[STORAGE DEBUG] persistSession -> conversation turn', { sessionId: currentSessionId, newTurn: conversationTurn, totalTurns: conversationHistory.length });
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
    console.log('[STORAGE DEBUG] persistSession -> screen analysis', { sessionId: currentSessionId, newEntry: analysisEntry, total: screenAnalysisHistory.length });
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

function hasAnthropicKey() {
    const key = getAnthropicApiKey();
    return key && key.trim() !== '';
}

// Answer a question with a cross-provider cascade: try the fastest available
// provider, and if it fails for ANY reason (dead model, 400/413, network, no
// key) fall through to the next one, so a single provider outage never leaves
// the user without an answer. Groq (~1s) → Claude (~1-2s) → Gemini (fallback).
// This owns the shared concerns (dedup, question/placeholder bubbles, history,
// save); the _stream* helpers only stream tokens and return the text or null.
async function routeAnswer(transcription) {
    const intent = (transcription || '').trim();
    if (!intent) return;

    // Deduplicate: don't re-answer the same question (silence + turnComplete both fire).
    if (intent === lastProcessedIntent) {
        console.log('[routeAnswer] Duplicate intent, skipping');
        return;
    }
    lastProcessedIntent = intent;

    // Question bubble (left) + answer placeholder (right).
    sendToRenderer('new-question', intent);
    sendToRenderer('new-response', '...');
    sendToRenderer('update-status', 'Thinking...');

    // Push the user turn once into shared history (with language lock).
    const lock = buildLanguageLockInstruction(intent, groqConversationHistory);
    groqConversationHistory.push({ role: 'user', content: lock ? `${intent}\n\n${lock}` : intent });
    if (groqConversationHistory.length > 20) groqConversationHistory = groqConversationHistory.slice(-20);

    // Cascade: first provider that returns text wins.
    let answer = null;
    if (hasGroqKey())                        answer = await _streamGroq();
    if ((answer == null) && hasAnthropicKey()) answer = await _streamAnthropic();
    if ((answer == null) && getApiKey())       answer = await _streamGemma();

    if (answer == null || !answer.trim()) {
        sendToRenderer('update-response', '⚠️ Could not get an answer from any configured provider. Check your API keys in Settings.');
        sendToRenderer('update-status', 'Listening...');
        return;
    }

    groqConversationHistory.push({ role: 'assistant', content: answer.trim() });
    if (groqConversationHistory.length > 20) groqConversationHistory = groqConversationHistory.slice(-20);
    saveConversationTurn(intent, answer.trim());
    sendToRenderer('update-status', 'Listening...');
}

// ── Provider streamers ──────────────────────────────────────────────
// Each reads the shared groqConversationHistory (the user turn is already
// appended by routeAnswer), streams tokens via 'update-response', and returns
// the full answer text on success or null on any failure (so the cascade
// continues). They do NOT push history, save, dedup, or emit bubbles.

async function _streamGroq() {
    const groqApiKey = getGroqApiKey();
    if (!groqApiKey) return null;
    if (currentGroqAbortController) { currentGroqAbortController.abort(); currentGroqAbortController = null; }

    // Prefer a fast, non-reasoning model first (lowest time-to-first-token), then
    // the rotation pick, then the rest. Reasoning models (gpt-oss) are slower.
    const preferred = getModelForToday();
    const candidates = ['llama-3.3-70b-versatile', preferred, ...GROQ_FALLBACK_MODELS]
        .filter((m, i, a) => m && a.indexOf(m) === i);
    // Trim history to keep the request well under Groq's request-size cap (avoids 413).
    const trimmed = trimConversationHistoryForGemma(groqConversationHistory, 12000);

    try {
        let response = null;
        let modelToUse = candidates[0];
        for (const candidate of candidates) {
            const body = {
                model: candidate,
                messages: [{ role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' }, ...trimmed],
                stream: true,
                temperature: 0.7,
                max_tokens: 1024,
            };
            if (/gpt-oss/i.test(candidate)) body.reasoning_effort = 'low';
            else if (/qwen/i.test(candidate)) body.reasoning_effort = 'none';

            currentGroqAbortController = new AbortController();
            const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
                signal: currentGroqAbortController.signal,
                body: JSON.stringify(body),
            });
            if (r.ok) { response = r; modelToUse = candidate; break; }
            const errText = await r.text();
            console.error(`[Groq] ${candidate} → ${r.status}:`, errText.slice(0, 200));
            // Per-model failures (retired / bad param / too large for this model) → next model.
            if (r.status === 404 || r.status === 400 || r.status === 413
                || /decommission|not found|reasoning_effort|too large|context|invalid model/i.test(errText)) continue;
            // Auth / rate limit / server error → give up on Groq (cascade to next provider).
            return null;
        }
        if (!response) return null;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '', inThinkBlock = false, streamBuffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            streamBuffer += decoder.decode(value, { stream: true });
            const lines = streamBuffer.split('\n');
            streamBuffer = lines.pop();
            for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('data: ')) continue;
                const data = t.slice(6);
                if (data === '[DONE]') continue;
                try {
                    const json = JSON.parse(data);
                    const token = json.choices?.[0]?.delta?.content || '';
                    if (token) {
                        fullText += token;
                        if (fullText.includes('<think>')) inThinkBlock = true;
                        if (inThinkBlock && fullText.includes('</think>')) inThinkBlock = false;
                        if (!inThinkBlock) {
                            const disp = stripThinkingTags(fullText);
                            if (disp) sendToRenderer('update-response', disp);
                        }
                    }
                } catch (_) { /* skip bad chunk */ }
            }
        }
        const cleaned = stripThinkingTags(fullText);
        if (cleaned) incrementCharUsage('groq', modelToUse.split('/').pop(), cleaned.length);
        console.log(`[Groq] answer completed (${modelToUse})`);
        return cleaned || null;
    } catch (error) {
        if (error.name === 'AbortError') return null;
        console.error('[Groq] stream error:', error.message);
        return null;
    } finally {
        currentGroqAbortController = null;
    }
}

async function _streamAnthropic() {
    const key = getAnthropicApiKey();
    if (!key) return null;
    if (currentGroqAbortController) { currentGroqAbortController.abort(); currentGroqAbortController = null; }
    const messages = recentHistoryAsAnthropicMessages(12);
    if (!messages.length) return null;
    try {
        currentGroqAbortController = new AbortController();
        const response = await fetchWithAnthropicRetry(
            'https://api.anthropic.com/v1/messages',
            {
                method: 'POST',
                headers: {
                    'x-api-key': key,
                    'anthropic-version': '2023-06-01',
                    'anthropic-beta': 'prompt-caching-2024-07-31',
                    'content-type': 'application/json',
                },
                signal: currentGroqAbortController.signal,
                body: JSON.stringify({
                    model: 'claude-sonnet-4-6',
                    max_tokens: 1024,
                    system: currentSystemPrompt ? [{ type: 'text', text: currentSystemPrompt, cache_control: { type: 'ephemeral' } }] : undefined,
                    messages,
                    stream: true,
                }),
            },
            'Sonnet'
        );
        if (!response) return null;
        if (!response.ok) {
            const t = await response.text();
            console.error('[Anthropic] answer error:', response.status, t.slice(0, 200));
            return null;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '', streamBuffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            streamBuffer += decoder.decode(value, { stream: true });
            const lines = streamBuffer.split('\n');
            streamBuffer = lines.pop();
            for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('data: ')) continue;
                const data = t.slice(6);
                if (data === '[DONE]') continue;
                try {
                    const json = JSON.parse(data);
                    if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
                        fullText += json.delta.text;
                        sendToRenderer('update-response', fullText);
                    }
                } catch (_) { /* skip */ }
            }
        }
        console.log('[Anthropic] answer completed');
        return fullText.trim() || null;
    } catch (error) {
        if (error.name === 'AbortError') return null;
        console.error('[Anthropic] stream error:', error.message);
        return null;
    } finally {
        currentGroqAbortController = null;
    }
}

async function _streamGemma() {
    const apiKey = getApiKey();
    if (!apiKey) return null;
    const trimmed = trimConversationHistoryForGemma(groqConversationHistory, 42000);
    try {
        const ai = new GoogleGenAI({ apiKey });
        const messages = trimmed.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
        const sys = currentSystemPrompt || 'You are a helpful assistant.';
        const contents = [
            { role: 'user', parts: [{ text: sys }] },
            { role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] },
            ...messages,
        ];
        const chosenModel = getAvailableModel() || GEMINI_FALLBACK_MODEL;
        console.log('[Gemini] answer using model:', chosenModel);
        const response = await ai.models.generateContentStream({ model: chosenModel, contents });
        let fullText = '';
        for await (const chunk of response) {
            const ct = chunk.text;
            if (ct) { fullText += ct; sendToRenderer('update-response', fullText); }
        }
        if (fullText) incrementCharUsage('gemini', chosenModel, fullText.length);
        console.log('[Gemini] answer completed');
        return fullText.trim() || null;
    } catch (error) {
        console.error('[Gemini] stream error:', error.message);
        return null;
    }
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

    // Show the transcribed question (left), then an answer placeholder (right).
    sendToRenderer('new-question', intent);
    sendToRenderer('new-response', '...');

    const questionToAnswer = intent;
    const assumptionPrefix = '';
    const languageLockInstruction = buildLanguageLockInstruction(questionToAnswer, groqConversationHistory);
    const questionForModel = languageLockInstruction
        ? `${questionToAnswer}\n\n${languageLockInstruction}`
        : questionToAnswer;

    // Preferred model from the daily rotation, then a list of currently-valid
    // Groq models to fall back to if one has been decommissioned (Groq returns
    // 404 for retired model IDs — this makes the answer path self-heal).
    const preferred = getModelForToday();
    const candidates = [preferred, ...GROQ_FALLBACK_MODELS].filter((m, i, a) => m && a.indexOf(m) === i);

    console.log(`Sending to Groq (candidates: ${candidates.join(', ')}):`, questionToAnswer.substring(0, 100) + '...');

    groqConversationHistory.push({
        role: 'user',
        content: questionForModel.trim()
    });

    if (groqConversationHistory.length > 20) {
        groqConversationHistory = groqConversationHistory.slice(-20);
    }

    try {
        let response = null;
        let modelToUse = candidates[0];
        for (const candidate of candidates) {
            const body = {
                model: candidate,
                messages: [
                    { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
                    ...groqConversationHistory
                ],
                stream: true,
                temperature: 0.7,
                max_tokens: 1024,
            };
            // reasoning_effort is model-specific: gpt-oss requires low|medium|high
            // (rejects "none"); qwen accepts "none"; other models reject it entirely.
            if (/gpt-oss/i.test(candidate)) {
                body.reasoning_effort = 'low'; // minimal reasoning → keep it fast
            } else if (/qwen/i.test(candidate)) {
                body.reasoning_effort = 'none';
            }

            currentGroqAbortController = new AbortController();
            const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
                signal: currentGroqAbortController.signal,
                body: JSON.stringify(body),
            });

            if (r.ok) { response = r; modelToUse = candidate; break; }

            const errorText = await r.text();
            console.error(`Groq API error for ${candidate}:`, r.status, errorText.slice(0, 300));
            // 404 = retired model; 400 = param the model rejects (differs per model).
            // Both are per-model, so try the next candidate. Auth/rate/5xx are fatal.
            const perModel = r.status === 404 || r.status === 400
                || /decommission|not found|does not exist|no longer|invalid model|model_not_found|reasoning_effort/i.test(errorText);
            if (perModel) {
                console.log(`[Groq] ${candidate} rejected (${r.status}) — trying next model`);
                continue; // try the next candidate
            }
            // Auth (401/403), rate limit (429), or server error — stop and report.
            sendToRenderer('update-status', `Groq error: ${r.status}`);
            return;
        }

        if (!response) {
            console.error('[Groq] All candidate models failed');
            sendToRenderer('update-status', 'Groq: no available model — check Settings');
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

    // Show the transcribed question (left), then an answer placeholder (right).
    sendToRenderer('new-question', transcription.trim());
    sendToRenderer('new-response', '...');

    const languageLockInstruction = buildLanguageLockInstruction(transcription.trim(), groqConversationHistory);
    const questionForModel = languageLockInstruction
        ? `${transcription.trim()}\n\n${languageLockInstruction}`
        : transcription.trim();

    groqConversationHistory.push({
        role: 'user',
        content: questionForModel
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

        // Pick a model for this call. Prefer today's selected model but fall
        // back to the configured GEMINI_FALLBACK_MODEL when necessary.
        const chosenModel = getAvailableModel() || GEMINI_FALLBACK_MODEL;
        console.log('[Gemini] sendToGemma using model:', chosenModel);
        const response = await ai.models.generateContentStream({
            model: chosenModel,
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

    incrementCharUsage('gemini', chosenModel, inputChars + outputChars);

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

    // Show the transcribed question (left), then an answer placeholder (right).
    sendToRenderer('new-question', intent);
    sendToRenderer('new-response', '...');

    const questionToAnswer = intent;
    const languageLockInstruction = buildLanguageLockInstruction(questionToAnswer, groqConversationHistory);
    const questionForModel = languageLockInstruction
        ? `${questionToAnswer}\n\n${languageLockInstruction}`
        : questionToAnswer;

    groqConversationHistory.push({ role: 'user', content: questionForModel.trim() });
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

// Map recent conversation into Anthropic messages (role user/assistant),
// dropping leading assistant turns so the array starts with a user turn.
function recentHistoryAsAnthropicMessages(maxTurns = 8) {
    if (!Array.isArray(groqConversationHistory) || groqConversationHistory.length === 0) return [];
    const msgs = groqConversationHistory
        .slice(-maxTurns)
        .map(m => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: typeof m.content === 'string' ? m.content : String(m.content || ''),
        }))
        .filter(m => m.content.trim());
    while (msgs.length && msgs[0].role === 'assistant') msgs.shift();
    return msgs;
}

// Solve screenshots with Claude vision (Anthropic provider mode). Context-aware:
// persona (resume + JD + human-tone rules) as system, prior conversation as
// history, then the image(s) + task prompt as the final user turn.
async function sendImagesToAnthropic(images, prompt) {
    const anthropicApiKey = getAnthropicApiKey();
    if (!anthropicApiKey) return { success: false, error: 'No Anthropic API key configured' };
    if (!images || images.length === 0) return { success: false, error: 'No images provided' };

    const imageBlocks = images.map(data => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data },
    }));
    const messages = [
        ...recentHistoryAsAnthropicMessages(),
        { role: 'user', content: [...imageBlocks, { type: 'text', text: prompt }] },
    ];

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
                    system: currentSystemPrompt
                        ? [{ type: 'text', text: currentSystemPrompt, cache_control: { type: 'ephemeral' } }]
                        : undefined,
                    messages,
                    stream: true,
                }),
            },
            'Sonnet-Vision'
        );

        if (!response) return { success: false, error: 'Request aborted' };
        if (!response.ok) {
            const errText = await response.text();
            console.error('[Anthropic] Vision API error:', response.status, errText);
            return { success: false, error: `Claude error ${response.status}` };
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
                const t = line.trim();
                if (!t.startsWith('data: ')) continue;
                const data = t.slice(6);
                if (data === '[DONE]') continue;
                try {
                    const json = JSON.parse(data);
                    if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
                        fullText += json.delta.text;
                        sendToRenderer('update-response', fullText);
                    }
                } catch (_) { /* skip malformed SSE lines */ }
            }
        }

        saveScreenAnalysis(prompt, fullText, 'claude-sonnet-4-6');
        recordScreenTurnInHistory(fullText);
        return { success: true, text: fullText, model: 'claude-sonnet-4-6' };
    } catch (error) {
        if (error.name === 'AbortError') return { success: false, error: 'Request cancelled' };
        console.error('[Anthropic] Vision error:', error);
        return { success: false, error: error.message };
    } finally {
        currentGroqAbortController = null;
    }
}

// Solve screenshots with a Groq vision model (best-effort fallback for whisper
// mode when no Gemini/Anthropic key is available). OpenAI-compatible format.
async function sendImagesToGroqVision(images, prompt) {
    const groqApiKey = getGroqApiKey();
    if (!groqApiKey) return { success: false, error: 'No Groq API key configured' };
    if (!images || images.length === 0) return { success: false, error: 'No images provided' };

    const userContent = [
        { type: 'text', text: prompt },
        ...images.map(data => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } })),
    ];
    const messages = [
        { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
        ...groqConversationHistory
            .slice(-8)
            .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: typeof m.content === 'string' ? m.content : String(m.content || '') }))
            .filter(m => m.content.trim()),
        { role: 'user', content: userContent },
    ];

    try {
        currentGroqAbortController = new AbortController();
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
            signal: currentGroqAbortController.signal,
            body: JSON.stringify({
                model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                messages,
                stream: true,
            }),
        });
        if (!response.ok) {
            const errText = await response.text();
            console.error('[Groq] Vision API error:', response.status, errText);
            return { success: false, error: `Groq vision error ${response.status}` };
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
                const t = line.trim();
                if (!t.startsWith('data: ')) continue;
                const data = t.slice(6);
                if (data === '[DONE]') continue;
                try {
                    const json = JSON.parse(data);
                    const delta = json.choices?.[0]?.delta?.content;
                    if (delta) { fullText += delta; sendToRenderer('update-response', fullText); }
                } catch (_) { /* skip malformed SSE lines */ }
            }
        }
        saveScreenAnalysis(prompt, fullText, 'groq-vision');
        recordScreenTurnInHistory(fullText);
        return { success: true, text: fullText, model: 'groq-vision' };
    } catch (error) {
        if (error.name === 'AbortError') return { success: false, error: 'Request cancelled' };
        console.error('[Groq] Vision error:', error);
        return { success: false, error: error.message };
    } finally {
        currentGroqAbortController = null;
    }
}

// Route screenshot solving to a vision-capable provider based on the active
// mode, with fallbacks so a solve works whenever ANY vision key is configured.
// (cloud/local are handled by the IPC callers before this is reached.)
async function routeImagesToProvider(images, prompt) {
    if (currentProviderMode === 'anthropic' && getAnthropicApiKey()) {
        return sendImagesToAnthropic(images, prompt);
    }
    if (currentProviderMode === 'whisper' || currentProviderMode === 'anthropic') {
        if (getApiKey()) return sendMultipleImagesToGeminiHttp(images, prompt);
        if (getAnthropicApiKey()) return sendImagesToAnthropic(images, prompt);
        if (getGroqApiKey()) return sendImagesToGroqVision(images, prompt);
        return { success: false, error: 'No vision-capable API key configured — add a Gemini, Anthropic, or Groq key to analyze screenshots' };
    }
    // Default (byok) — Gemini HTTP
    return sendMultipleImagesToGeminiHttp(images, prompt);
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
            model: GEMINI_LIVE_MODEL,
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
                            routeAnswer(currentTranscription);
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
        console.error('Failed to initialize Gemini session (first attempt):', error);
        // If the configured model is no longer available, try a fallback model
        if (isModelNotFoundError(error) && GEMINI_FALLBACK_MODEL) {
            try {
                console.log('Attempting to reconnect using fallback model:', GEMINI_FALLBACK_MODEL);
                const session = await client.live.connect({
                    model: GEMINI_FALLBACK_MODEL,
                    callbacks: {
                        onopen: function () {
                            sessionReadyAt = Date.now();
                            sendToRenderer('update-status', 'Live session connected (fallback)');
                        },
                        onmessage: function (message) {
                            console.log('----------------', message);
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
                            if (message.serverContent?.turnComplete) {
                                sendToRenderer('update-status', 'Listening...');
                                if (transcriptionSilenceTimer) {
                                    clearTimeout(transcriptionSilenceTimer);
                                    transcriptionSilenceTimer = null;
                                }
                                if (currentTranscription.trim() !== '') {
                                    routeAnswer(currentTranscription);
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
                            if (isUserClosing) {
                                isUserClosing = false;
                                sendToRenderer('update-status', 'Session closed');
                                return;
                            }
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
                if (!isReconnect) sendToRenderer('session-initializing', false);
                return session;
            } catch (err2) {
                console.error('Fallback model connect failed:', err2);
            }
        }
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

    const { app, systemPreferences } = require('electron');
    const path = require('path');
    const fs = require('fs');
    const { execFileSync } = require('child_process');

    let systemAudioPath;
    if (app.isPackaged) {
        systemAudioPath = path.join(process.resourcesPath, 'SystemAudioDump');
    } else {
        systemAudioPath = path.join(__dirname, '../assets', 'SystemAudioDump');
    }

    console.log('SystemAudioDump path:', systemAudioPath);

    // The helper is bundled inside an (unsigned) app, so a freshly-downloaded
    // copy is quarantined by macOS and Gatekeeper can silently kill it the
    // moment we spawn it — which looks exactly like "audio produces no response".
    // Best-effort: make sure it's executable and clear the quarantine flag so
    // capture works without the user opening Terminal. (Both may fail if the app
    // lives in a write-protected location — harmless, it's wrapped in try/catch.)
    if (!fs.existsSync(systemAudioPath)) {
        console.error('SystemAudioDump binary not found at', systemAudioPath);
        sendToRenderer('update-status', '⚠️ Audio capture unavailable: helper binary is missing. Please reinstall the app.');
        return false;
    }
    try {
        fs.chmodSync(systemAudioPath, 0o755);
        try { execFileSync('xattr', ['-d', 'com.apple.quarantine', systemAudioPath]); } catch (_) { /* no quarantine attribute — nothing to clear */ }
    } catch (e) {
        console.error('Could not prepare SystemAudioDump binary (continuing):', e.message);
    }

    // System-audio capture goes through ScreenCaptureKit, which is gated by the
    // Screen Recording permission. Without it the helper runs but records
    // silence — surface that rather than leaving the user staring at nothing.
    try {
        const screenStatus = systemPreferences.getMediaAccessStatus('screen');
        console.log('[Permissions] screen recording status:', screenStatus);
        if (screenStatus !== 'granted') {
            sendToRenderer('update-status', '⚠️ Grant Screen Recording permission (System Settings ▸ Privacy & Security), then restart to capture audio.');
        }
    } catch (_) { /* getMediaAccessStatus unsupported on this OS version — ignore */ }

    const spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
        },
    };

    try {
        systemAudioProc = spawn(systemAudioPath, [], spawnOptions);
    } catch (e) {
        console.error('Failed to spawn SystemAudioDump:', e);
        sendToRenderer('update-status', '⚠️ Audio capture failed to start: ' + e.message);
        return false;
    }

    if (!systemAudioProc || !systemAudioProc.pid) {
        console.error('Failed to start SystemAudioDump');
        sendToRenderer('update-status', '⚠️ Audio capture failed to start (the helper could not launch).');
        return false;
    }

    console.log('SystemAudioDump started with PID:', systemAudioProc.pid);
    // If the helper dies within ~1.5s it was almost certainly blocked by
    // Gatekeeper or a missing permission — used by the close handler below.
    const systemAudioSpawnedAt = Date.now();

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
        // Died almost immediately (and not because the user stopped it) → the OS
        // blocked it. Tell the user the two things that actually fix it.
        if (!isUserClosing && Date.now() - systemAudioSpawnedAt < 1500) {
            sendToRenderer('update-status', `⚠️ Audio helper stopped immediately (code ${code}). Grant Screen Recording permission, and if the app was downloaded, right-click it and choose Open once to allow it.`);
        }
        systemAudioProc = null;
    });

    systemAudioProc.on('error', err => {
        console.error('SystemAudioDump process error:', err);
        sendToRenderer('update-status', '⚠️ Audio capture error: ' + err.message);
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

// Map the recent Groq/audio conversation into Gemini `contents` turns so a
// screenshot answer is coherent with what has already been said in the session.
// Gemini uses the role name 'model' (not 'assistant').
function recentHistoryAsGeminiContents(maxTurns = 8) {
    if (!Array.isArray(groqConversationHistory) || groqConversationHistory.length === 0) return [];
    return groqConversationHistory
        .slice(-maxTurns)
        .map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: typeof m.content === 'string' ? m.content : String(m.content || '') }],
        }))
        .filter(t => t.parts[0].text.trim());
}

// Build a context-aware image request: the session persona (resume + JD +
// human-tone rules) as systemInstruction, prior conversation as history, then
// the image(s) + task prompt as the final user turn.
function buildImageRequest(imageParts, taskPrompt) {
    const contents = [
        ...recentHistoryAsGeminiContents(),
        { role: 'user', parts: [...imageParts, { text: taskPrompt }] },
    ];
    const config = {};
    if (currentSystemPrompt && currentSystemPrompt.trim()) {
        config.systemInstruction = currentSystemPrompt;
    }
    return { contents, config };
}

// Record a screenshot exchange in the shared conversation history so subsequent
// audio answers stay aware of what was shown/answered on screen.
function recordScreenTurnInHistory(answer) {
    if (!answer || !answer.trim()) return;
    groqConversationHistory.push({ role: 'user', content: '(I shared my screen and asked for help with what was shown.)' });
    groqConversationHistory.push({ role: 'assistant', content: answer.trim() });
    if (groqConversationHistory.length > 20) {
        groqConversationHistory = groqConversationHistory.slice(-20);
    }
}

async function sendImageToGeminiHttp(base64Data, prompt) {
    // Get available model based on rate limits
    let model = getAvailableModel();

    // Candidate fallback list in order of preference (current, valid models).
    const MODEL_FALLBACKS = buildImageModelFallbacks(model);

    const apiKey = getApiKey();
    if (!apiKey) {
        return { success: false, error: 'No API key configured' };
    }

    try {
        const ai = new GoogleGenAI({ apiKey: apiKey });
        const imageParts = [{ inlineData: { mimeType: 'image/jpeg', data: base64Data } }];
        const { contents, config } = buildImageRequest(imageParts, prompt);

        console.log(`[Gemini] Sending single image to ${model} (streaming, context-aware=${!!config.systemInstruction})...`);

        // Attempt a few transient network/fetch retries and also try alternate
        // model names if the API returns a 404 model-not-found error. We iterate
        // through MODEL_FALLBACKS and for each model we allow a few internal
        // attempts to handle transient failures.
        const MAX_ATTEMPTS_PER_MODEL = 2;
        let response = null;
        let lastErr = null;
        for (const candidateModel of MODEL_FALLBACKS) {
            let attempt = 0;
            model = candidateModel;
            while (attempt < MAX_ATTEMPTS_PER_MODEL) {
                try {
                    console.log(`[Gemini] trying model ${model} (attempt ${attempt + 1}/${MAX_ATTEMPTS_PER_MODEL})`);
                    response = await ai.models.generateContentStream({ model: model, contents: contents, config });
                    lastErr = null;
                    break; // got a response for this model
                } catch (err) {
                    lastErr = err;
                    const msg = err && (err.message || err.toString());
                    console.error(`[Gemini] generateContentStream failed for model ${model} attempt ${attempt + 1}:`, msg, err && err.stack ? err.stack : err);

                    // If it's a 404 / model-not-found error, break out to try the next model
                    const isNotFound = msg && msg.toLowerCase().includes('not found') && msg.toLowerCase().includes('model');
                    attempt++;
                    if (isNotFound) {
                        console.log(`[Gemini] model ${model} not available for this API version, trying next fallback`);
                        break; // try next candidateModel
                    }

                    // Rate-limited (429): retrying the SAME model won't help within
                    // the per-minute window, so skip straight to the next fallback.
                    if (isRateLimitError(err)) {
                        console.log(`[Gemini] model ${model} rate-limited (429), trying next fallback`);
                        break; // try next candidateModel
                    }

                    if (attempt < MAX_ATTEMPTS_PER_MODEL) {
                        const waitMs = 500 * attempt;
                        console.log(`[Gemini] retrying in ${waitMs}ms...`);
                        await new Promise(r => setTimeout(r, waitMs));
                        continue;
                    }
                }
            }

            if (response) break; // success, stop trying other models
        }

        if (lastErr && !response) {
            // All candidate models/attempts failed — log which models were attempted
            console.error('[Gemini] All candidate models failed for image generation. Last error:', lastErr && (lastErr.message || lastErr.toString()));
            throw lastErr;
        }

        if (!response) {
            throw new Error('No response from Gemini generateContentStream');
        }

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

        console.log(`[Gemini] Image response completed from ${model}`);

        // Save screen analysis to history
        saveScreenAnalysis(prompt, fullText, model);
        // Keep the shared conversation aware of this screen exchange
        recordScreenTurnInHistory(fullText);

        return { success: true, text: fullText, model: model };
    } catch (error) {
        console.error('[Gemini] Error sending image to Gemini HTTP:', error && error.stack ? error.stack : error);
        if (isRateLimitError(error)) {
            const secs = getRetryDelaySeconds(error);
            const wait = secs ? ` Try again in about ${secs}s.` : '';
            return { success: false, error: `Gemini rate limit reached on the free tier.${wait} If this keeps happening, add billing to your Google AI Studio key for higher limits.` };
        }
        const message = (error && (error.message || error.toString())) || 'Unknown error';
        return { success: false, error: message };
    }
}

async function sendMultipleImagesToGeminiHttp(images, prompt) {
    const model = getAvailableModel();
    const apiKey = getApiKey();
    if (!apiKey) {
        return { success: false, error: 'No API key configured' };
    }

    // If caller passed a single image, reuse the single-image path which
    // is often more robust and avoids passing an array to the HTTP client.
    if (images.length === 1) {
        try {
            console.log('[Gemini] sendMultipleImagesToGeminiHttp: single image detected, delegating to sendImageToGeminiHttp');
            return await sendImageToGeminiHttp(images[0], prompt);
        } catch (err) {
            console.error('[Gemini] delegated single-image send failed:', err && err.stack ? err.stack : err);
            // fall through to try the multi-image path as a last resort
        }
    }

    try {
        console.log('[Gemini] sendMultipleImagesToGeminiHttp', { model, imagesCount: images.length });
        images.forEach((img, idx) => {
            try {
                const size = Buffer.from(img, 'base64').length;
                console.log(`[Gemini] image[${idx}] size: ${size} bytes`);
            } catch (e) {
                console.log(`[Gemini] image[${idx}] size: <unreadable>`);
            }
        });
        const ai = new GoogleGenAI({ apiKey: apiKey });

        const imageParts = images.map(data => ({
            inlineData: { mimeType: 'image/jpeg', data },
        }));
        const { contents, config } = buildImageRequest(imageParts, prompt);

        // Try model fallbacks similar to single-image path (current, valid models)
        const MODEL_FALLBACKS = buildImageModelFallbacks(model);
        let response = null;
        let usedModel = model;
        let lastErr = null;
        for (const candidateModel of MODEL_FALLBACKS) {
            try {
                console.log(`Sending ${images.length} images to ${candidateModel} (streaming, context-aware=${!!config.systemInstruction})...`);
                response = await ai.models.generateContentStream({ model: candidateModel, contents: contents, config });
                usedModel = candidateModel;
                break;
            } catch (err) {
                lastErr = err;
                const msg = err && (err.message || err.toString());
                console.error(`[Gemini] generateContentStream failed for model ${candidateModel}:`, msg, err && err.stack ? err.stack : err);
                const isNotFound = msg && msg.toLowerCase().includes('not found') && msg.toLowerCase().includes('model');
                if (isNotFound) {
                    console.log(`[Gemini] model ${candidateModel} not available, trying next fallback`);
                    continue;
                }
                // For transient / rate-limit errors, retry next candidate as well
                continue;
            }
        }

        if (!response) {
            // Surface the underlying cause so the catch below can produce a
            // friendly rate-limit message instead of a generic failure.
            throw lastErr || new Error('No response from Gemini generateContentStream for any candidate models');
        }

        incrementLimitCount(usedModel);

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
        recordScreenTurnInHistory(fullText);

        return { success: true, text: fullText, model: model };
    } catch (error) {
        console.error('Error sending images to Gemini HTTP:', error && error.stack ? error.stack : error);
        if (isRateLimitError(error)) {
            const secs = getRetryDelaySeconds(error);
            const wait = secs ? ` Try again in about ${secs}s.` : '';
            return { success: false, error: `Gemini rate limit reached on the free tier.${wait} If this keeps happening, add billing to your Google AI Studio key for higher limits.` };
        }
        // Some errors come with nested 'cause' or 'error' fields from the library
        const message = (error && (error.message || error.toString())) || 'Unknown error';
        return { success: false, error: message };
    }
}

// -------------------- follow-up helpers --------------------
function extractLastAssistantCode() {
    // look in conversationHistory (most recent assistant turn with a code fence)
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
        const turn = conversationHistory[i];
        if (!turn || !turn.ai_response) continue;
        const text = turn.ai_response;
        const fenced = text.match(/```([^\n]*)\n([\s\S]*?)```/);
        if (fenced) return { lang: fenced[1] || '', code: fenced[2].trim(), source: 'conversation' };
        const pre = text.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
        if (pre) return { lang: '', code: pre[1].trim(), source: 'conversation' };
    }
    // fallback to last screenAnalysisHistory entry
    for (let i = screenAnalysisHistory.length - 1; i >= 0; i--) {
        const entry = screenAnalysisHistory[i];
        if (!entry || !entry.response) continue;
        const text = entry.response;
        const fenced = text.match(/```([^\n]*)\n([\s\S]*?)```/);
        if (fenced) return { lang: fenced[1] || '', code: fenced[2].trim(), source: 'screenAnalysis' };
        const pre = text.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
        if (pre) return { lang: '', code: pre[1].trim(), source: 'screenAnalysis' };
    }
    return null;
}

function looksLikeFollowUpFix() {
    // Only consider follow-up fixes inside the Interview profile
    if (currentProfile !== 'interview') return false;

    const lastAssistantHasCode = extractLastAssistantCode();
    if (!lastAssistantHasCode) return false;

    // If the last assistant turn is too old (>30m) don't assume follow-up
    const lastTurn = conversationHistory.length ? conversationHistory[conversationHistory.length - 1] : null;
    if (lastTurn) {
        const ageMs = Date.now() - (lastTurn.timestamp || Date.now());
        if (ageMs > 1000 * 60 * 30) return false;
    }

    return true;
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
            routeAnswer(transcript);
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
