// Gemini provider adapter (text answers — not the Live transcription session).
// Implements the ProviderAdapter interface:
//   isAvailable()               → boolean
//   streamAnswer({ reasoning }) → Promise<string|null>
//   listModels()                → Promise<string[]>

const { GoogleGenAI } = require('@google/genai');
const { S, sendStreamUpdate } = require('../state');
const { GEMINI_FALLBACK_MODEL, GEMINI_NO_THINKING, GEMINI_THINKING, trimConversationHistoryForGemma } = require('../config');
const telemetry = require('../telemetry');
const { getApiKey, getAvailableModel, incrementCharUsage } = require('../../../storage');

// Static model list — Gemini doesn't expose a public /models catalogue
// with the same stability guarantees as Groq, so we keep a curated list.
const GEMINI_TEXT_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'];

// Models that rejected thinkingConfig with a 400. Once a model is here we skip
// the config immediately instead of paying a failed round-trip + retry on
// EVERY answer (this retry was adding seconds to each Gemini fallback).
const _noThinkingConfigModels = new Set();

function isAvailable() {
    const key = getApiKey();
    return !!(key && key.trim());
}

async function listModels() {
    return GEMINI_TEXT_MODELS;
}

// `epoch` tags every stream update so the cascade can discard tokens that
// arrive after it gave up on us; `controller` is how it stops us at all —
// without a signal threaded into the SDK, an abandoned Gemini stream kept
// typing into the answer bubble for as long as the model kept generating.
async function streamAnswer({ reasoning = false, temperature = 0.4, messages: overrideMessages = null, epoch, controller = null } = {}) {
    const apiKey = getApiKey();
    if (!apiKey) return null;

    // `messages` lets a caller answer something other than the running audio
    // conversation (the screenshot OCR path passes the extracted screen text).
    // Without it the answer silently ignores whatever the caller asked about.
    const trimmed =
        overrideMessages && overrideMessages.length ? overrideMessages : trimConversationHistoryForGemma(S.groqConversationHistory, 42000);

    try {
        const ai = new GoogleGenAI({ apiKey });
        const messages = trimmed.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
        
        // Gemini requires conversations to end with a user message, not a model message.
        // If the last message is from the model, remove it.
        if (messages.length > 0 && messages[messages.length - 1].role === 'model') {
            console.log('[Gemini] Trimming final model message to comply with API requirements');
            messages.pop();
        }
        
        const sys = S.currentSystemPrompt || 'You are a helpful assistant.';
        const contents = [
            { role: 'user', parts: [{ text: sys }] },
            { role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] },
            ...messages,
        ];

        const chosenModel = getAvailableModel() || GEMINI_FALLBACK_MODEL;
        console.log('[Gemini] answer using model:', chosenModel, reasoning ? '(reasoning)' : '(fast)');

        const skipThinkingConfig = _noThinkingConfigModels.has(chosenModel);
        const baseConfig = { temperature: temperature, ...(controller ? { abortSignal: controller.signal } : {}) };
        const config = skipThinkingConfig ? baseConfig : { ...(reasoning ? GEMINI_THINKING : GEMINI_NO_THINKING), ...baseConfig };

        let response;
        try {
            response = await ai.models.generateContentStream({ model: chosenModel, contents, config });
        } catch (err) {
            // Some "-latest" models reject thinkingBudget overrides → retry without
            // it and REMEMBER, so future answers skip the failed attempt entirely.
            if (!skipThinkingConfig && /400|INVALID_ARGUMENT/i.test(err.message || '')) {
                console.warn('[Gemini] 400 with thinkingConfig — retrying without it (cached for future calls)');
                _noThinkingConfigModels.add(chosenModel);
                response = await ai.models.generateContentStream({ model: chosenModel, contents, config: baseConfig });
            } else {
                throw err;
            }
        }

        let fullText = '',
            firstToken = true;
        for await (const chunk of response) {
            const ct = chunk.text;
            if (ct) {
                if (firstToken) {
                    telemetry.mark('ttft', `gemini:${chosenModel}`);
                    firstToken = false;
                }
                fullText += ct;
                sendStreamUpdate(fullText, epoch);
            }
        }

        if (fullText) incrementCharUsage('gemini', chosenModel, fullText.length);
        console.log('[Gemini] answer completed');
        return fullText.trim() || null;
    } catch (error) {
        if (error.name === 'AbortError') return null;
        console.error('[Gemini] stream error:', error.message);
        return null;
    }
}

module.exports = { name: 'gemini', isAvailable, streamAnswer, listModels };
