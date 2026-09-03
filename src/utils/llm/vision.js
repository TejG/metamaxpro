// Screenshot solving: vision requests to Gemini (HTTP), Anthropic (Claude), and Groq (vision),
// with provider-routing that picks the fastest available reasoner first.
const { GoogleGenAI } = require('@google/genai');
const { S, sendStreamUpdate, flushStreamUpdate, discardStreamUpdate } = require('./state');
const { GROQ_VISION_MODELS, buildImageModelFallbacks, isRateLimitError, getRetryDelaySeconds } = require('./config');
const { saveScreenAnalysis, recordScreenTurnInHistory, recentHistoryAsAnthropicMessages, recentHistoryAsGeminiContents } = require('./persistence');
const { fetchWithAnthropicRetry } = require('./router');
const health = require('./providers/health');
const { getAvailableModel, incrementLimitCount, getApiKey, getGroqApiKey, getAnthropicApiKey } = require('../../storage');

const ANTHROPIC_VISION_MODEL = 'claude-sonnet-4-6';

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
    const messages = [...recentHistoryAsAnthropicMessages(), { role: 'user', content: [...imageBlocks, { type: 'text', text: prompt }] }];

    try {
        S.currentGroqAbortController = new AbortController();
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
                signal: S.currentGroqAbortController.signal,
                body: JSON.stringify({
                    model: ANTHROPIC_VISION_MODEL,
                    max_tokens: 4096,
                    system: S.currentSystemPrompt ? [{ type: 'text', text: S.currentSystemPrompt, cache_control: { type: 'ephemeral' } }] : undefined,
                    messages,
                    stream: true,
                }),
            },
            'Sonnet-Vision'
        );

        if (!response) {
            discardStreamUpdate();
            return { success: false, error: 'Request aborted' };
        }
        if (!response.ok) {
            const errText = await response.text();
            console.error('[Anthropic] Vision API error:', response.status, errText);
            // Account-level failure (billing / daily quota): trip the circuit
            // breaker so the next solve skips Anthropic outright instead of
            // paying this failed round-trip before falling back.
            const kind = health.classifyFailure(response.status, errText);
            if (kind) health.markDown('anthropic', kind);
            discardStreamUpdate();
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
                        sendStreamUpdate(fullText);
                    }
                } catch (_) {
                    /* skip malformed SSE lines */
                }
            }
        }

        // An empty stream is a failure, not a success: reporting success would
        // leave the renderer's "..." placeholder unresolved and stop the router
        // from trying the next provider.
        if (!fullText.trim()) {
            discardStreamUpdate();
            return { success: false, error: 'Claude returned an empty response' };
        }

        flushStreamUpdate();
        health.markUp('anthropic');
        saveScreenAnalysis(prompt, fullText, ANTHROPIC_VISION_MODEL);
        recordScreenTurnInHistory(fullText);
        return { success: true, text: fullText, model: ANTHROPIC_VISION_MODEL };
    } catch (error) {
        discardStreamUpdate();
        if (error.name === 'AbortError') return { success: false, error: 'Request cancelled' };
        console.error('[Anthropic] Vision error:', error);
        return { success: false, error: error.message };
    } finally {
        S.currentGroqAbortController = null;
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
        { role: 'system', content: S.currentSystemPrompt || 'You are a helpful assistant.' },
        ...S.groqConversationHistory
            .slice(-8)
            .map(m => ({
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: typeof m.content === 'string' ? m.content : String(m.content || ''),
            }))
            .filter(m => m.content.trim()),
        { role: 'user', content: userContent },
    ];

    let lastError = 'Groq vision error';
    for (const model of GROQ_VISION_MODELS) {
        try {
            S.currentGroqAbortController = new AbortController();
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
                signal: S.currentGroqAbortController.signal,
                body: JSON.stringify({
                    model,
                    messages,
                    stream: true,
                    // Lower temperature for screenshot solving: this path now also
                    // handles aptitude/quantitative questions where a low-temperature,
                    // more deterministic pass at the arithmetic matters a lot more
                    // than phrasing variety.
                    temperature: 0.2,
                }),
            });
            if (!response.ok) {
                const errText = await response.text();
                console.error(`[Groq] Vision API error (${model}):`, response.status, errText);
                lastError = `Groq vision error ${response.status}`;
                discardStreamUpdate();
                // A decommissioned/inaccessible model (404) is a config issue that
                // will fail for every request — try the next candidate immediately
                // rather than giving up. Other errors (4xx auth/429/5xx) aren't
                // fixed by switching models, so bail out to the caller's fallback.
                if (response.status === 404) continue;
                return { success: false, error: lastError };
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
                        if (delta) {
                            fullText += delta;
                            sendStreamUpdate(fullText);
                        }
                    } catch (_) {
                        /* skip malformed SSE lines */
                    }
                }
            }
            // Empty stream — drop the partial and let the next model/provider try.
            if (!fullText.trim()) {
                discardStreamUpdate();
                lastError = 'Groq vision returned an empty response';
                continue;
            }
            flushStreamUpdate();
            saveScreenAnalysis(prompt, fullText, 'groq-vision');
            recordScreenTurnInHistory(fullText);
            return { success: true, text: fullText, model: 'groq-vision' };
        } catch (error) {
            discardStreamUpdate();
            if (error.name === 'AbortError') return { success: false, error: 'Request cancelled' };
            console.error(`[Groq] Vision error (${model}):`, error);
            lastError = error.message;
        } finally {
            S.currentGroqAbortController = null;
        }
    }
    return { success: false, error: lastError };
}

// Build a context-aware image request: the session persona (resume + JD +
// human-tone rules) as systemInstruction, prior conversation as history, then
// the image(s) + task prompt as the final user turn.
function buildImageRequest(imageParts, taskPrompt) {
    const contents = [...recentHistoryAsGeminiContents(), { role: 'user', parts: [...imageParts, { text: taskPrompt }] }];
    // A screenshot is almost always a PROBLEM to solve (a coding task, an
    // aptitude/MCQ question, a diagram) rather than small talk. Thinking is off
    // so the answer starts streaming in ~1.5s — on-screen questions are read
    // live, and a slow-but-considered answer is worse than a fast one — while
    // the low temperature keeps the arithmetic/logic deterministic.
    const config = {
        thinkingConfig: { thinkingBudget: 0 },
        temperature: 0.1,
    };
    if (S.currentSystemPrompt && S.currentSystemPrompt.trim()) {
        config.systemInstruction = S.currentSystemPrompt;
    }
    return { contents, config };
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

        // One attempt per candidate model: retrying the SAME model after a fixed
        // backoff rarely helps (404s are permanent, 429s outlive the backoff) and
        // it doubled the worst-case wait before the next fallback was tried.
        let response = null;
        let lastErr = null;
        for (const candidateModel of MODEL_FALLBACKS) {
            model = candidateModel;
            try {
                console.log(`[Gemini] trying model ${model}`);
                response = await ai.models.generateContentStream({ model: model, contents: contents, config });
                lastErr = null;
                break; // got a response for this model
            } catch (err) {
                lastErr = err;
                const msg = err && (err.message || err.toString());
                console.error(`[Gemini] generateContentStream failed for model ${model}:`, msg, err && err.stack ? err.stack : err);

                const isNotFound = msg && msg.toLowerCase().includes('not found') && msg.toLowerCase().includes('model');
                if (isNotFound) {
                    console.log(`[Gemini] model ${model} not available for this API version, trying next fallback`);
                } else if (isRateLimitError(err)) {
                    console.log(`[Gemini] model ${model} rate-limited (429), trying next fallback`);
                }
            }
        }

        if (!response) {
            // All candidate models failed — surface the underlying cause so the
            // catch below can produce a friendly rate-limit message.
            console.error(
                '[Gemini] All candidate models failed for image generation. Last error:',
                lastErr && (lastErr.message || lastErr.toString())
            );
            throw lastErr || new Error('No response from Gemini generateContentStream');
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
                sendStreamUpdate(fullText);
            }
        }

        if (!fullText.trim()) {
            discardStreamUpdate();
            return { success: false, error: 'Gemini returned an empty response' };
        }

        flushStreamUpdate();
        console.log(`[Gemini] Image response completed from ${model}`);

        // Save screen analysis to history
        saveScreenAnalysis(prompt, fullText, model);
        // Keep the shared conversation aware of this screen exchange
        recordScreenTurnInHistory(fullText);

        return { success: true, text: fullText, model: model };
    } catch (error) {
        discardStreamUpdate();
        console.error('[Gemini] Error sending image to Gemini HTTP:', error && error.stack ? error.stack : error);
        if (isRateLimitError(error)) {
            const secs = getRetryDelaySeconds(error);
            const wait = secs ? ` Try again in about ${secs}s.` : '';
            return {
                success: false,
                error: `Gemini rate limit reached on the free tier.${wait} If this keeps happening, add billing to your Google AI Studio key for higher limits.`,
            };
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
                sendStreamUpdate(fullText);
            }
        }

        if (!fullText.trim()) {
            discardStreamUpdate();
            return { success: false, error: 'Gemini returned an empty response' };
        }

        flushStreamUpdate();
        console.log(`Multi-image response completed from ${usedModel}`);
        saveScreenAnalysis(prompt, fullText, usedModel);
        recordScreenTurnInHistory(fullText);

        return { success: true, text: fullText, model: usedModel };
    } catch (error) {
        discardStreamUpdate();
        console.error('Error sending images to Gemini HTTP:', error && error.stack ? error.stack : error);
        if (isRateLimitError(error)) {
            const secs = getRetryDelaySeconds(error);
            const wait = secs ? ` Try again in about ${secs}s.` : '';
            return {
                success: false,
                error: `Gemini rate limit reached on the free tier.${wait} If this keeps happening, add billing to your Google AI Studio key for higher limits.`,
            };
        }
        // Some errors come with nested 'cause' or 'error' fields from the library
        const message = (error && (error.message || error.toString())) || 'Unknown error';
        return { success: false, error: message };
    }
}

// Route screenshot solving directly to a vision-capable provider based on available keys.
// Gemini Flash Vision (fastest & native multimodal) -> Anthropic -> Groq Vision.
async function routeImagesToProvider(images, prompt) {
    if (!images || images.length === 0) {
        return { success: false, error: 'No images provided for analysis' };
    }

    console.log(`[Vision] Direct Vision routing for ${images.length} image(s)...`);

    const attempts = [];
    // Skip Anthropic entirely while the circuit breaker is open (billing/quota
    // failure seen recently) — a solve is latency-critical and that round-trip
    // is a guaranteed loss.
    const anthropicUsable = getAnthropicApiKey() && !health.isDown('anthropic');

    // In Anthropic-specific mode, try Anthropic first; otherwise prioritize fast Gemini
    if (S.currentProviderMode === 'anthropic' && anthropicUsable) {
        attempts.push(() => sendImagesToAnthropic(images, prompt));
        if (getApiKey()) attempts.push(() => sendMultipleImagesToGeminiHttp(images, prompt));
        if (getGroqApiKey()) attempts.push(() => sendImagesToGroqVision(images, prompt));
    } else {
        if (getApiKey()) attempts.push(() => sendMultipleImagesToGeminiHttp(images, prompt));
        if (anthropicUsable) attempts.push(() => sendImagesToAnthropic(images, prompt));
        if (getGroqApiKey()) attempts.push(() => sendImagesToGroqVision(images, prompt));
    }

    if (attempts.length === 0) {
        return { success: false, error: 'No vision-capable API key configured (Gemini, Anthropic, or Groq required)' };
    }

    let lastError = 'Vision request failed';
    for (const attempt of attempts) {
        try {
            const result = await attempt();
            if (result && result.success) {
                return result;
            }
            lastError = (result && result.error) || lastError;
            console.log('[Vision] Provider attempt failed, trying fallback:', lastError);
        } catch (err) {
            lastError = err.message || lastError;
            console.error('[Vision] Provider threw exception:', err);
        }
        // Drop anything this provider streamed so a partial answer can't bleed
        // into the next provider's output.
        discardStreamUpdate();
    }

    return { success: false, error: lastError };
}

module.exports = {
    sendImagesToAnthropic,
    sendImagesToGroqVision,
    buildImageRequest,
    sendImageToGeminiHttp,
    sendMultipleImagesToGeminiHttp,
    routeImagesToProvider,
};
