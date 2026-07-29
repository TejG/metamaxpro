// Model lists, tuning constants, and PURE helper functions for the LLM
// pipeline. Nothing in this file touches shared session state — anything that
// does belongs in state.js (state) or the module that owns the behavior.

// ── Timing ──────────────────────────────────────────────────────────
// How long to wait after the last speech chunk before answering. This was
// previously tuned down to 400ms for a "snappier" feel, but 400ms is shorter
// than a normal mid-sentence breathing/thinking pause — it made the assistant
// start answering before the other person finished talking. 900ms comfortably
// clears natural pauses while still feeling fast. Override via GEMINI_SILENCE_MS.
const SILENCE_THRESHOLD_MS = Number(process.env.GEMINI_SILENCE_MS) || 900;
// If the buffered transcription ends with one of these, the sentence is almost
// certainly not finished yet (trailing conjunction/preposition/filler) — extend
// the wait once instead of firing immediately, so we don't cut people off.
const INCOMPLETE_TRAILING_WORDS = /\b(and|or|but|so|because|if|when|which|that|the|a|an|to|of|is|are|was|were|um|uh|like|actually|basically)$/i;
// Ignore transcription for a brief moment after connect so the session's initial
// buffered audio doesn't fire a spurious answer. Override via GEMINI_WARMUP_MS.
const SESSION_WARMUP_MS = Number(process.env.GEMINI_WARMUP_MS) || 1000;

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 2000;

// ── Models ──────────────────────────────────────────────────────────
// Environment override for Gemini/fallback models
// Default to a current, vision-capable Gemini model name; allow env var to override.
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || process.env.GEMMA_FALLBACK_MODEL || 'gemini-flash-lite-latest';
// Native-audio Live models used for real-time transcription, current first.
// Dated preview IDs get RETIRED over time — the old pinned '...-09-2025' was,
// which silently killed all audio (the Live session couldn't connect, so audio
// was streamed to nothing). We now try a chain and fall through on failure.
// Override the whole list via GEMINI_LIVE_MODEL (comma-separated).
const GEMINI_LIVE_MODELS = process.env.GEMINI_LIVE_MODEL
    ? process.env.GEMINI_LIVE_MODEL.split(',')
          .map(s => s.trim())
          .filter(Boolean)
    : [
          'gemini-2.5-flash-native-audio-preview-12-2025',
          'gemini-2.5-flash-preview-native-audio-dialog',
          'gemini-2.5-flash-native-audio-preview-09-2025',
      ];

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

// Groq vision-capable models to try, in order. Groq periodically retires/
// renames preview vision models (e.g. llama-4-scout-17b-16e-instruct started
// 404'ing with model_not_found for some accounts) — trying a short list here
// keeps screenshot-solving on the fast Groq path instead of silently falling
// all the way back to the much slower Gemini HTTP path on every request.
const GROQ_VISION_MODELS = ['meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct'];

// Current, valid, vision-capable Gemini models used for screenshot solving,
// in order of preference. Kept in one place so the single- and multi-image
// paths stay in sync. gemini-2.5-pro is intentionally excluded — it is NOT
// available on the Gemini free tier (the API returns 429 with `limit: 0`).
// Override via GEMINI_IMAGE_FALLBACKS if you have a paid key.
const GEMINI_IMAGE_FALLBACKS = process.env.GEMINI_IMAGE_FALLBACKS
    ? process.env.GEMINI_IMAGE_FALLBACKS.split(',')
          .map(s => s.trim())
          .filter(Boolean)
    : ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

// Build a deduped fallback list starting from the preferred model. Capped to 2
// candidates total — trying all 5 configured models sequentially (each with
// its own retries) on a rate-limited/unavailable key was previously adding
// 15-20+ seconds to screenshot answers before ever giving up or falling back
// to another provider.
function buildImageModelFallbacks(preferred) {
    return [preferred, ...GEMINI_IMAGE_FALLBACKS].filter((m, i, arr) => m && arr.indexOf(m) === i).slice(0, 2);
}

// ── Gemini thinking configs ─────────────────────────────────────────
// Gemini 2.5 Flash / Flash-Lite (what `gemini-flash-latest` now resolves to)
// enable "thinking" — extra internal reasoning tokens generated BEFORE the first
// visible token — by DEFAULT via the API. For a live interview assistant that
// costs 10-40s of dead air before an answer starts streaming. We don't need
// chain-of-thought for fast, speakable answers, so disable it with
// thinkingBudget: 0. This restores sub-2s time-to-first-token.
const GEMINI_NO_THINKING = { thinkingConfig: { thinkingBudget: 0 } };
// Reasoning-enabled Gemini config for questions that must be WORKED OUT
// (aptitude, quantitative, logic, multiple-choice). thinkingBudget > 0 lets the
// model reason internally before answering — the single biggest lever for
// getting these right. Bounded (not dynamic -1) so latency stays predictable.
const GEMINI_THINKING = { thinkingConfig: { thinkingBudget: 2048 } };

// ── Adaptive answer effort ──────────────────────────────────────────
// Decide whether a question must be WORKED OUT (one correct numeric/logical
// answer) vs. answered conversationally. Conservative by design: a false
// positive only makes a chatty answer slightly slower, while a false negative
// is a fast wrong answer — so borderline cases lean toward reasoning.
const REASONING_STRONG_SIGNALS = [
    /\b(calculate|compute|solve|evaluate|simplify|derive|prove|factor(?:ise|ize)?)\b/i,
    /\b(how many|how much|what (?:is|are|will be) the|find (?:the|out)|determine the|value of)\b/i,
    /\b(percent|percentage|ratio|proportion|average|mean|median|mode|probability|permutation|combination|factorial)\b/i,
    /\b(profit|loss|interest|discount|speed|distance|velocity|acceleration|area|volume|perimeter|angle)\b/i,
    /\b(series|sequence|next (?:number|term)|missing (?:number|term)|odd one out|analogy)\b/i,
    /\b(syllogism|blood relation|seating|arrangement|ranking|coding[- ]decoding|direction sense)\b/i,
    /\b(equation|solve for|integral|derivative|logarithm|square root|cube root|prime|factor)\b/i,
    /\b(which of the following|choose the correct|correct (?:option|answer)|mark the|select the)\b/i,
    /[=×÷√∑≥≤∫∏]|\b\d+\s*[-+*/^%]\s*\d+\b/, // math operators / "12 * 3"
    /(?:^|\s)\(?[a-dA-D]\)[\s.]/, // MCQ markers: "a)" "B."
];
function questionNeedsReasoning(text) {
    if (!text) return false;
    const s = String(text);
    if (REASONING_STRONG_SIGNALS.some(re => re.test(s))) return true;
    // A bare number plus a question mark ("what's 15% of 240?") — a digit alone
    // (e.g. "in 2020 I led...") is NOT enough, to avoid slowing behavioral answers.
    return /\d/.test(s) && /\?/.test(s) && /\b(of|is|are|equal|total|sum|difference|left|remain|each|per)\b/i.test(s);
}

// ── Programming-language detection (coding-exercise language lock) ──
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
        'leetcode',
        'hackerrank',
        'coding challenge',
        'algorithm',
        'data structure',
        'time complexity',
        'space complexity',
        'implement',
        'write a function',
        'write code',
        'solve this',
        'array',
        'string',
        'binary tree',
        'linked list',
        'dynamic programming',
        'dfs',
        'bfs',
        'two pointers',
        'sliding window',
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

// ── Error classification helpers ────────────────────────────────────
function isModelNotFoundError(err) {
    if (!err) return false;
    const msg = (err.message || err.toString() || '').toLowerCase();
    if (msg.includes('not found') || msg.includes('no longer available') || (msg.includes('models/') && msg.includes('is no longer'))) return true;
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
    return msg.includes('429') || msg.includes('too many requests') || msg.includes('resource_exhausted') || msg.includes('quota');
}

// Extract the API-suggested retry delay (seconds) from a 429 body, if present.
function getRetryDelaySeconds(err) {
    try {
        const s = err && (err.message || err.toString() || '');
        const m = s.match(/retry(?:delay)?["\s:]*["']?(\d+(?:\.\d+)?)s/i) || s.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
        if (m) return Math.ceil(parseFloat(m[1]));
    } catch (e) {
        /* ignore */
    }
    return null;
}

// ── Small text utilities ────────────────────────────────────────────
function stripThinkingTags(text) {
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function trimConversationHistoryForGemma(history, maxChars = 42000) {
    if (!history || history.length === 0) return [];
    let totalChars = 0;
    const trimmed = [];

    for (let i = history.length - 1; i >= 0; i--) {
        const turn = history[i];
        const turnChars = (turn.content || '').length;

        if (totalChars + turnChars > maxChars) break;
        totalChars += turnChars;
        trimmed.unshift(turn);
    }
    return trimmed;
}

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

module.exports = {
    SILENCE_THRESHOLD_MS,
    INCOMPLETE_TRAILING_WORDS,
    SESSION_WARMUP_MS,
    MAX_RECONNECT_ATTEMPTS,
    RECONNECT_DELAY,
    GEMINI_FALLBACK_MODEL,
    GEMINI_LIVE_MODELS,
    GROQ_FALLBACK_MODELS,
    GROQ_VISION_MODELS,
    GEMINI_IMAGE_FALLBACKS,
    buildImageModelFallbacks,
    GEMINI_NO_THINKING,
    GEMINI_THINKING,
    questionNeedsReasoning,
    looksLikeCodingExercise,
    detectProgrammingLanguage,
    buildLanguageLockInstruction,
    isModelNotFoundError,
    isRateLimitError,
    getRetryDelaySeconds,
    stripThinkingTags,
    trimConversationHistoryForGemma,
    formatSpeakerResults,
};
