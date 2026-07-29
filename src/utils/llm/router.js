// Text-answer routing: the cross-provider cascade (Groq / Anthropic / Gemini),
// the Anthropic sequential queue, transcription-cleaning middleware, and the
// silence-timer trigger that turns a finished utterance into an answer.
const { S, sendToRenderer, sendStreamUpdate, flushStreamUpdate, discardStreamUpdate } = require('./state');
const {
    SILENCE_THRESHOLD_MS,
    INCOMPLETE_TRAILING_WORDS,
    SESSION_WARMUP_MS,
    questionNeedsReasoning,
    buildLanguageLockInstruction,
} = require('./config');
const { saveConversationTurn, recentHistoryAsAnthropicMessages } = require('./persistence');
const { getAnthropicApiKey, getGroqApiKey, getApiKey } = require('../../storage');
const telemetry = require('./telemetry');
const { getRelevantResumeSections } = require('./contextFilter');

// ── Provider adapters (data-driven cascade) ─────────────────────────
const groqAdapter = require('./providers/groq');
const anthropicAdapter = require('./providers/anthropic');
const geminiAdapter = require('./providers/gemini');

// Warm up the Groq model cache once at startup so the first answer doesn't pay
// the discovery latency. Fire-and-forget — errors are handled inside listModels.
groqAdapter.listModels().catch(() => {});

// kept for external call-sites that check key presence independently
function hasGroqKey() {
    return groqAdapter.isAvailable();
}

function hasAnthropicKey() {
    return anthropicAdapter.isAvailable();
}

function cancelSilenceTimer() {
    if (S.transcriptionSilenceTimer) {
        clearTimeout(S.transcriptionSilenceTimer);
        S.transcriptionSilenceTimer = null;
    }
}

function cancelProvisionalTimer() {
    // no-op: provisional tier removed; kept for call-site compatibility
}

function scheduleGroqTrigger() {
    if (Date.now() - S.sessionReadyAt < SESSION_WARMUP_MS) return;

    cancelSilenceTimer();

    // If the transcript so far trails off on a word that strongly suggests the
    // sentence isn't finished ("...and", "...because", etc.), give it extra
    // time before firing so we don't answer a half-asked question.
    const trailing = S.currentTranscription.trim();
    const looksUnfinished = INCOMPLETE_TRAILING_WORDS.test(trailing);
    const waitMs = looksUnfinished ? SILENCE_THRESHOLD_MS * 2 : SILENCE_THRESHOLD_MS;

    S.transcriptionSilenceTimer = setTimeout(() => {
        S.transcriptionSilenceTimer = null;
        if (S.currentTranscription.trim() !== '') {
            routeAnswer(S.currentTranscription);
            S.currentTranscription = '';
        }
    }, waitMs);
}

// Answer a question with a cross-provider cascade: try the fastest available
// provider, and if it fails for ANY reason (dead model, 400/413, network, no
// key) fall through to the next one, so a single provider outage never leaves
// the user without an answer.
// This owns the shared concerns (dedup, question/placeholder bubbles, history,
// save); the _stream* helpers only stream tokens and return the text or null.
async function routeAnswer(transcription) {
    const intent = (transcription || '').trim();
    if (!intent) return;

    // Deduplicate: don't re-answer the same question (silence + turnComplete both fire).
    if (intent === S.lastProcessedIntent) {
        console.log('[routeAnswer] Duplicate intent, skipping');
        return;
    }
    S.lastProcessedIntent = intent;

    // Question bubble (left) + answer placeholder (right).
    sendToRenderer('new-question', intent);
    sendToRenderer('new-response', '...');
    sendToRenderer('update-status', 'Thinking...');

    // Task 4: Smart Resume Filtering - include only relevant sections
    let userMessage = intent;
    if (S.resumeText && S.resumeText.trim()) {
        const filteredResume = getRelevantResumeSections(intent, S.resumeText);
        const originalSize = S.resumeText.length;
        const filteredSize = filteredResume.length;
        const reduction = originalSize > 0 ? Math.round(((originalSize - filteredSize) / originalSize) * 100) : 0;

        console.log(`[Task 4] Resume filtering: ${originalSize} → ${filteredSize} chars (${reduction}% reduction)`);

        // Prepend filtered resume to user message
        const contextParts = [];
        contextParts.push(`[RESUME CONTEXT - Relevant Sections]:\n${filteredResume}`);
        if (S.jobDescriptionText && S.jobDescriptionText.trim()) {
            contextParts.push(`[TARGET JOB]:\n${S.jobDescriptionText}`);
        }
        if (S.avoidWordsText && S.avoidWordsText.trim()) {
            contextParts.push(`[AVOID THESE PHRASES]:\n${S.avoidWordsText}`);
        }
        contextParts.push(`[QUESTION]:\n${intent}`);

        userMessage = contextParts.join('\n\n');
    }

    // Push the user turn once into shared history (with language lock).
    const lock = buildLanguageLockInstruction(intent, S.groqConversationHistory);
    S.groqConversationHistory.push({ role: 'user', content: lock ? `${userMessage}\n\n${lock}` : userMessage });
    if (S.groqConversationHistory.length > 20) S.groqConversationHistory = S.groqConversationHistory.slice(-20);

    // Adaptive effort: aptitude/quantitative/logic questions must be worked out,
    // so they get a reasoning-capable model + low temperature + a longer latency
    // budget. Everyday conversational questions stay on the fast path.
    const reasoning = questionNeedsReasoning(intent);
    if (reasoning) sendToRenderer('update-status', 'Working it out…');

    // Temperature control: interview mode uses 0.2 to reduce hallucination risk,
    // reasoning mode uses 0.1 for correctness, standard conversational uses 0.4.
    const isInterviewMode = S.currentProfile === 'job_interview' || S.currentProfile === 'interview' || S.currentProfile === 'meeting';
    const temperature = reasoning ? 0.1 : isInterviewMode ? 0.2 : 0.4;

    // Cascade: first provider that returns text wins. Each provider gets a hard
    // timeout — if it hasn't produced anything (no error, just slow/hanging) we
    // abort it and move on rather than let it silently eat the whole budget.
    // This is what kept 20-30s worst-case replies from happening: previously a
    // stalled provider had no ceiling before falling through to the next one.
    // Reasoning answers need the model to actually think, so they get a wider
    // ceiling (a fast 8s abort would kill the reasoning that makes them correct).
    const PROVIDER_TIMEOUT_MS = reasoning ? 22000 : 8000;
    async function withTimeout(promiseFactory) {
        let timedOut = false;
        const timeout = new Promise(resolve => {
            setTimeout(() => {
                timedOut = true;
                resolve(null);
            }, PROVIDER_TIMEOUT_MS);
        });
        const result = await Promise.race([promiseFactory(), timeout]);
        if (timedOut && S.currentGroqAbortController) {
            S.currentGroqAbortController.abort();
            S.currentGroqAbortController = null;
        }
        return result;
    }

    let answer = null;
    // Provider order is lane-dependent (performance-first):
    // - Conversational (Lane A): Groq first — lowest TTFT (~300-500ms).
    // - Reasoning (Lane B): Anthropic first — strongest reasoner for aptitude/logic.
    // Between providers, discard any pending throttled partial so stale text
    // can't flash over the next provider's output (the "retyping" jitter fix).
    const laneA = [groqAdapter, anthropicAdapter, geminiAdapter];
    const laneB = [anthropicAdapter, groqAdapter, geminiAdapter];
    const lane = reasoning ? laneB : laneA;

    for (const adapter of lane) {
        if (answer != null) break;
        if (!adapter.isAvailable()) continue;
        answer = await withTimeout(() => adapter.streamAnswer({ reasoning, temperature }));
        if (answer == null) discardStreamUpdate();
    }

    if (answer == null || !answer.trim()) {
        sendToRenderer('update-response', '⚠️ Could not get an answer from any configured provider. Check your API keys in Settings.');
        sendToRenderer('update-status', 'Listening...');
        return;
    }

    // Ensure the renderer has the final, complete text (the throttle may be
    // holding the last tokens), THEN persist.
    flushStreamUpdate();
    telemetry.mark('done');

    S.groqConversationHistory.push({ role: 'assistant', content: answer.trim() });
    if (S.groqConversationHistory.length > 20) S.groqConversationHistory = S.groqConversationHistory.slice(-20);
    saveConversationTurn(intent, answer.trim());
    sendToRenderer('update-status', 'Listening...');
}

// ── Transcription-cleaning middleware ───────────────────────────────

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
    if (S.currentProviderMode === 'anthropic') {
        return cleanTranscriptionWithAnthropic(rawText, state);
    }

    const groqApiKey = getGroqApiKey();
    if (!groqApiKey) return { intent: rawText, response: null, state };

    try {
        const apiResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${groqApiKey}`,
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

// Imported from the Anthropic adapter so cleanTranscription can reuse the same
// retry/backoff logic without duplicating it.
const { fetchWithAnthropicRetry } = require('./providers/anthropic');

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

// ── Anthropic sequential queue (anthropic provider mode) ────────────

// Enqueue a transcription for sequential Anthropic processing.
// Keeps at most 2 pending items — drops the oldest pending entry when the backlog
// exceeds that limit so we never answer questions that are several turns stale.
function queueForAnthropic(transcription) {
    if (!transcription || transcription.trim() === '') return;

    if (S.anthropicQueue.length >= 2) {
        // Drop oldest pending — it's stale relative to what the interviewer just said
        S.anthropicQueue.shift();
    }
    S.anthropicQueue.push(transcription.trim());

    if (!S.anthropicProcessing) {
        drainAnthropicQueue();
    }
}

async function drainAnthropicQueue() {
    if (S.anthropicProcessing) return;
    S.anthropicProcessing = true;

    while (S.anthropicQueue.length > 0) {
        const next = S.anthropicQueue.shift();
        await sendToAnthropic(next);
    }

    S.anthropicProcessing = false;
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

    console.log(`[Anthropic STT] [final] | "${intent.substring(0, 80)}"`);

    if (intent === S.lastProcessedIntent) {
        console.log('[Anthropic] Duplicate intent, skipping');
        return;
    }
    S.lastProcessedIntent = intent;

    // Show the transcribed question (left), then an answer placeholder (right).
    sendToRenderer('new-question', intent);
    sendToRenderer('new-response', '...');

    const questionToAnswer = intent;
    const languageLockInstruction = buildLanguageLockInstruction(questionToAnswer, S.groqConversationHistory);
    const questionForModel = languageLockInstruction ? `${questionToAnswer}\n\n${languageLockInstruction}` : questionToAnswer;

    S.groqConversationHistory.push({ role: 'user', content: questionForModel.trim() });
    if (S.groqConversationHistory.length > 20) {
        S.groqConversationHistory = S.groqConversationHistory.slice(-20);
    }

    // Build messages array (Anthropic format: no system in messages array)
    const messages = S.groqConversationHistory.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
    }));

    console.log(`[Anthropic] Sending to claude-sonnet-4-6: "${questionToAnswer.substring(0, 80)}..."`);
    sendToRenderer('update-status', 'Thinking...');

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
                    model: 'claude-sonnet-4-6',
                    max_tokens: 4096,
                    system: [
                        {
                            type: 'text',
                            text: S.currentSystemPrompt || 'You are a helpful assistant.',
                            cache_control: { type: 'ephemeral' },
                        },
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
                        sendStreamUpdate(fullText);
                    }
                } catch (_) {
                    // skip malformed SSE lines
                }
            }
        }

        flushStreamUpdate();
        if (fullText) {
            S.groqConversationHistory.push({ role: 'assistant', content: fullText });
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
        S.currentGroqAbortController = null;
    }
}

module.exports = {
    hasGroqKey,
    hasAnthropicKey,
    cancelSilenceTimer,
    cancelProvisionalTimer,
    scheduleGroqTrigger,
    routeAnswer,
    cleanTranscription,
    fetchWithAnthropicRetry,
    queueForAnthropic,
    sendToAnthropic,
};
