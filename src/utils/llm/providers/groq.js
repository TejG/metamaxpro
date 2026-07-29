// Groq provider adapter.
// Implements the ProviderAdapter interface:
//   isAvailable()               → boolean
//   streamAnswer({ reasoning }) → Promise<string|null>
//   listModels()                → Promise<string[]>
//
// Model discovery: at first call, fetches the live model list from Groq's
// /models endpoint and caches it for MODEL_CACHE_TTL_MS. Subsequent calls
// use the cache, so there's no per-request overhead.

const { S, sendStreamUpdate } = require('../state');
const { GROQ_FALLBACK_MODELS, stripThinkingTags, trimConversationHistoryForGemma } = require('../config');
const telemetry = require('../telemetry');
const { getGroqApiKey, getModelForToday, incrementCharUsage } = require('../../../storage');

const MODEL_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let _modelCache = null;
let _modelCacheAt = 0;

// Fetch and cache live model list. Falls back to static GROQ_FALLBACK_MODELS on any error.
async function listModels() {
    const apiKey = getGroqApiKey();
    if (!apiKey) return GROQ_FALLBACK_MODELS;

    const now = Date.now();
    if (_modelCache && now - _modelCacheAt < MODEL_CACHE_TTL_MS) return _modelCache;

    try {
        const res = await fetch('https://api.groq.com/openai/v1/models', {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const json = await res.json();
        const ids = (json.data || []).map(m => m.id).filter(Boolean);
        if (ids.length) {
            _modelCache = ids;
            _modelCacheAt = now;
            console.log(`[Groq] model list refreshed (${ids.length} models)`);
        }
        return _modelCache || GROQ_FALLBACK_MODELS;
    } catch (e) {
        console.warn('[Groq] model discovery failed, using static list:', e.message);
        return GROQ_FALLBACK_MODELS;
    }
}

function isAvailable() {
    const key = getGroqApiKey();
    return !!(key && key.trim());
}

async function streamAnswer({ reasoning = false, temperature = 0.4 } = {}) {
    const groqApiKey = getGroqApiKey();
    if (!groqApiKey) return null;

    if (S.currentGroqAbortController) {
        S.currentGroqAbortController.abort();
        S.currentGroqAbortController = null;
    }

    const preferred = getModelForToday();
    const liveModels = _modelCache || GROQ_FALLBACK_MODELS;

    // Build candidate list: reasoning-capable models first for aptitude/math/logic,
    // fastest TTFT models first for conversational. Capped to 3 to bound worst-case latency.
    const order = reasoning
        ? ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', preferred, ...GROQ_FALLBACK_MODELS]
        : ['llama-3.3-70b-versatile', preferred, ...GROQ_FALLBACK_MODELS];

    // Filter by live model list when available (drops retired IDs early).
    const known = new Set(liveModels);
    const candidates = order
        .filter((m, i, a) => m && a.indexOf(m) === i)
        .filter(m => known.size === 0 || known.has(m))
        .slice(0, 3);

    const trimmed = trimConversationHistoryForGemma(S.groqConversationHistory, 12000);

    try {
        let response = null;
        let modelToUse = candidates[0];

        for (const candidate of candidates) {
            const body = {
                model: candidate,
                messages: [{ role: 'system', content: S.currentSystemPrompt || 'You are a helpful assistant.' }, ...trimmed],
                stream: true,
                temperature: temperature,
                max_tokens: reasoning ? 2048 : 1024,
            };
            if (/gpt-oss/i.test(candidate)) body.reasoning_effort = reasoning ? 'high' : 'low';
            else if (/qwen/i.test(candidate)) body.reasoning_effort = reasoning ? 'default' : 'none';

            S.currentGroqAbortController = new AbortController();
            const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
                signal: S.currentGroqAbortController.signal,
                body: JSON.stringify(body),
            });

            if (r.ok) {
                response = r;
                modelToUse = candidate;
                break;
            }
            const errText = await r.text();
            console.error(`[Groq] ${candidate} → ${r.status}:`, errText.slice(0, 200));
            if (r.status === 404 || r.status === 400 || r.status === 413 || /decommission|not found|reasoning_effort|too large|context|invalid model/i.test(errText))
                continue;
            return null;
        }
        if (!response) return null;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '',
            inThinkBlock = false,
            streamBuffer = '',
            firstToken = true;

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
                        if (firstToken) {
                            telemetry.mark('ttft', `groq:${modelToUse}`);
                            firstToken = false;
                        }
                        fullText += token;
                        if (fullText.includes('<think>')) inThinkBlock = true;
                        if (inThinkBlock && fullText.includes('</think>')) inThinkBlock = false;
                        if (!inThinkBlock) {
                            const disp = stripThinkingTags(fullText);
                            if (disp) sendStreamUpdate(disp);
                        }
                    }
                } catch (_) {
                    /* skip bad chunk */
                }
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
        S.currentGroqAbortController = null;
    }
}

module.exports = { name: 'groq', isAvailable, streamAnswer, listModels };
