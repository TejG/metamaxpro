// Anthropic provider adapter.
// Implements the ProviderAdapter interface:
//   isAvailable()               → boolean
//   streamAnswer({ reasoning }) → Promise<string|null>
//   listModels()                → Promise<string[]>
//
// Also exports fetchWithAnthropicRetry so other modules (cleanTranscription)
// can reuse the same retry/backoff logic without duplicating it.

const { S, sendToRenderer, sendStreamUpdate } = require('../state');
const telemetry = require('../telemetry');
const { getAnthropicApiKey } = require('../../../storage');
const { recentHistoryAsAnthropicMessages } = require('../persistence');

const ANTHROPIC_MODELS = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];

function isAvailable() {
    const key = getAnthropicApiKey();
    return !!(key && key.trim());
}

async function listModels() {
    return ANTHROPIC_MODELS;
}

// Retry fetch for Anthropic API — handles 429, 529, 500/503.
// maxRetries/baseDelayMs are kept small so cascade callers can fail fast.
async function fetchWithAnthropicRetry(url, options, label = 'Anthropic', maxRetries = 2, baseDelayMs = 500) {
    let delay = baseDelayMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
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

        if (isRetryable && attempt < maxRetries) {
            const retryAfterHeader = response.headers?.get('retry-after');
            const waitMs = retryAfterHeader ? Math.min(parseInt(retryAfterHeader, 10) * 1000, 4000) : delay;
            console.log(`[${label}] ${status} — retry ${attempt + 1}/${maxRetries} in ${waitMs}ms`);
            sendToRenderer('update-status', `Retrying... (${attempt + 1}/${maxRetries})`);
            await new Promise(r => setTimeout(r, waitMs));
            delay = Math.min(delay * 2, 3000);
            continue;
        }

        return response;
    }
    return null;
}

async function streamAnswer({ reasoning = false, temperature = 0.4 } = {}) {
    const key = getAnthropicApiKey();
    if (!key) return null;

    if (S.currentGroqAbortController) {
        S.currentGroqAbortController.abort();
        S.currentGroqAbortController = null;
    }

    const messages = recentHistoryAsAnthropicMessages(12);
    if (!messages.length) return null;

    try {
        S.currentGroqAbortController = new AbortController();
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
                signal: S.currentGroqAbortController.signal,
                body: JSON.stringify({
                    model: 'claude-sonnet-4-6',
                    max_tokens: reasoning ? 2048 : 1024,
                    temperature: temperature,
                    system: S.currentSystemPrompt
                        ? [{ type: 'text', text: S.currentSystemPrompt, cache_control: { type: 'ephemeral' } }]
                        : undefined,
                    messages,
                    stream: true,
                }),
            },
            'Sonnet',
            1,
            400
        );

        if (!response) return null;
        if (!response.ok) {
            const t = await response.text();
            console.error('[Anthropic] answer error:', response.status, t.slice(0, 200));
            return null;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '',
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
                    if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
                        if (firstToken) {
                            telemetry.mark('ttft', 'anthropic');
                            firstToken = false;
                        }
                        fullText += json.delta.text;
                        sendStreamUpdate(fullText);
                    }
                } catch (_) {
                    /* skip */
                }
            }
        }

        console.log('[Anthropic] answer completed');
        return fullText.trim() || null;
    } catch (error) {
        if (error.name === 'AbortError') return null;
        console.error('[Anthropic] stream error:', error.message);
        return null;
    } finally {
        S.currentGroqAbortController = null;
    }
}

module.exports = { name: 'anthropic', isAvailable, streamAnswer, listModels, fetchWithAnthropicRetry };
