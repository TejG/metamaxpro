// Shared mutable session state for the LLM pipeline.
//
// Every module (router, vision, audio, live session) reads/writes the SAME
// state object required from here. This is deliberate: when this code lived in
// one 2,800-line file these were module-level variables; splitting them into
// copies per module would silently desynchronize them (the classic failure
// mode of splitting a god module). Always access via `S.<field>` — never
// destructure a mutable field into a local const.
const { BrowserWindow } = require('electron');

const S = {
    // Provider mode: 'byok', 'cloud', 'local', 'whisper', or 'anthropic'
    currentProviderMode: 'byok',

    // Cross-provider conversation history (OpenAI-style {role, content}).
    // Named for its Groq origins but shared by every text/vision provider.
    groqConversationHistory: [],

    // Conversation/session tracking
    currentSessionId: null,
    currentTranscription: '',
    conversationHistory: [],
    screenAnalysisHistory: [],
    currentProfile: null,
    currentCustomPrompt: null,
    isInitializingSession: false,
    currentSystemPrompt: null,

    // Smart resume filtering (Task 4)
    resumeText: '',
    jobDescriptionText: '',
    avoidWordsText: '',

    // Audio capture process (macOS SystemAudioDump)
    systemAudioProc: null,

    // Silence-detection timer for the transcription → answer trigger
    transcriptionSilenceTimer: null,
    sessionReadyAt: 0,

    // AbortController for the in-flight Groq/Anthropic LLM request
    currentGroqAbortController: null,

    // Deduplication: don't re-process the same intent twice in a row
    lastProcessedIntent: '',

    // Anthropic sequential question queue
    anthropicQueue: [],
    anthropicProcessing: false,

    // Reconnection bookkeeping for the Gemini Live session
    isUserClosing: false,
    sessionParams: null,
    reconnectAttempts: 0,

    // Keepalive to prevent idle timeout (Gemini Live sessions timeout after ~15min inactivity)
    sessionKeepaliveTimer: null,
    lastActivityTimestamp: Date.now(),
};

// Lazy-loaded to avoid a circular dependency (localai.js imports from llm/index.js)
let _localai = null;
function getLocalAi() {
    if (!_localai) _localai = require('../localai');
    return _localai;
}

function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    // Prefer the focused window, fall back to the first non-destroyed window, then index 0
    const target =
        BrowserWindow.getFocusedWindow() || windows.find(w => w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) || windows[0];
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

// ── Streaming throttle for 'update-response' ────────────────────────
// LLM streams emit a token every few ms and each emit sends the ENTIRE
// accumulated text over IPC, forcing a full markdown re-render in the
// renderer per token. That render pressure is what shows up as visible
// "jitter"/flicker while an answer types out. Batch to at most one
// update-response every STREAM_THROTTLE_MS (trailing edge guaranteed, so
// the final full text is never dropped).
const STREAM_THROTTLE_MS = 50;
let _streamLastSent = 0;
let _streamPendingData = null;
let _streamFlushTimer = null;

function _flushStream() {
    _streamFlushTimer = null;
    if (_streamPendingData === null) return;
    const data = _streamPendingData;
    _streamPendingData = null;
    _streamLastSent = Date.now();
    sendToRenderer('update-response', data);
}

function sendStreamUpdate(data) {
    _streamPendingData = data;
    const elapsed = Date.now() - _streamLastSent;
    if (elapsed >= STREAM_THROTTLE_MS) {
        // Leading edge: send immediately so time-to-first-token stays snappy.
        _flushStream();
    } else if (!_streamFlushTimer) {
        // Trailing edge: schedule exactly one flush for the newest text.
        _streamFlushTimer = setTimeout(_flushStream, STREAM_THROTTLE_MS - elapsed);
    }
}

// Force out any pending partial text NOW (call when a stream ends or is
// replaced) so the final answer is complete and the next stream can't
// interleave with a stale scheduled flush.
function flushStreamUpdate() {
    if (_streamFlushTimer) {
        clearTimeout(_streamFlushTimer);
        _streamFlushTimer = null;
    }
    if (_streamPendingData !== null) _flushStream();
}

// Drop any pending partial without sending (call when a provider's stream is
// abandoned mid-answer so its stale text can't overwrite the next provider's).
function discardStreamUpdate() {
    if (_streamFlushTimer) {
        clearTimeout(_streamFlushTimer);
        _streamFlushTimer = null;
    }
    _streamPendingData = null;
}

module.exports = { S, sendToRenderer, sendStreamUpdate, flushStreamUpdate, discardStreamUpdate, getLocalAi };
