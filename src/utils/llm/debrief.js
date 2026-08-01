// End-of-call debrief generation.
//
// Reads the finished session's conversation turns from shared state and asks a
// text LLM (Groq first, Gemini fallback) to assess how the call went and produce
// concrete next steps for the candidate, including a ready-to-send follow-up
// email when warranted. Non-streaming: the debrief is generated once and sent to
// the renderer as a single response.

const { S, sendStreamUpdate, flushStreamUpdate } = require('./state');
const { getDebriefPrompt } = require('../prompts');
const { getGroqApiKey, getApiKey } = require('../../storage');

const GROQ_DEBRIEF_MODEL = 'llama-3.3-70b-versatile';
const GEMINI_DEBRIEF_MODEL = 'gemini-flash-latest';
const MIN_TURNS_FOR_DEBRIEF = 2;

async function callGroq(system, user) {
    const apiKey = getGroqApiKey();
    if (!apiKey) return null;
    try {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(30000),
            body: JSON.stringify({
                model: GROQ_DEBRIEF_MODEL,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: user },
                ],
                temperature: 0.4,
                max_tokens: 1536,
            }),
        });
        if (!r.ok) {
            console.warn(`[Debrief] Groq ${r.status}: ${(await r.text()).slice(0, 150)}`);
            return null;
        }
        const json = await r.json();
        return json.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {
        console.warn('[Debrief] Groq error:', e.message);
        return null;
    }
}

async function callGemini(system, user) {
    const apiKey = getApiKey();
    if (!apiKey) return null;
    try {
        const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_DEBRIEF_MODEL}:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(30000),
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: system }] },
                    contents: [{ role: 'user', parts: [{ text: user }] }],
                    generationConfig: { temperature: 0.4, maxOutputTokens: 1536 },
                }),
            }
        );
        if (!r.ok) {
            console.warn(`[Debrief] Gemini ${r.status}: ${(await r.text()).slice(0, 150)}`);
            return null;
        }
        const json = await r.json();
        return json.candidates?.[0]?.content?.parts?.map(p => p.text).join('')?.trim() || null;
    } catch (e) {
        console.warn('[Debrief] Gemini error:', e.message);
        return null;
    }
}

/**
 * Generate the end-of-call debrief from the current session's history.
 * Safe to call after `close-session` — history is only cleared on a new session.
 *
 * @returns {Promise<{success: boolean, debrief?: string, error?: string}>}
 */
async function generateCallDebrief() {
    const turns = Array.isArray(S.conversationHistory) ? S.conversationHistory : [];
    if (turns.length < MIN_TURNS_FOR_DEBRIEF) {
        return { success: false, error: `Not enough conversation to debrief (${turns.length} turn(s) captured).` };
    }

    const { system, user } = getDebriefPrompt(turns, S.currentCustomPrompt || '');
    console.log(`[Debrief] Generating debrief from ${turns.length} turns...`);

    let debrief = await callGroq(system, user);
    if (!debrief) debrief = await callGemini(system, user);
    if (!debrief) return { success: false, error: 'No LLM provider available for debrief generation.' };

    // Push the debrief into the assistant view like a normal answer.
    sendStreamUpdate(`📋 CALL DEBRIEF\n\n${debrief}`);
    flushStreamUpdate();
    console.log('[Debrief] Debrief generated and sent to renderer.');
    return { success: true, debrief };
}

module.exports = { generateCallDebrief, MIN_TURNS_FOR_DEBRIEF };
