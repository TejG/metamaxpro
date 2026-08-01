// Session persistence + conversation history management.
// Owns: session lifecycle (initializeNewSession), saving turns/analyses to
// disk, and mapping the shared history into each provider's message format.
const { S, sendToRenderer } = require('./state');
const { saveSession: persistSession } = require('../../storage');

// Conversation management functions
function initializeNewSession(profile = null, customPrompt = null) {
    S.currentSessionId = Date.now().toString();
    S.currentTranscription = '';
    S.conversationHistory = [];
    S.screenAnalysisHistory = [];
    S.groqConversationHistory = [];
    if (S.transcriptionSilenceTimer) {
        clearTimeout(S.transcriptionSilenceTimer);
        S.transcriptionSilenceTimer = null;
    }
    S.sessionReadyAt = 0;
    S.lastProcessedIntent = '';
    S.anthropicQueue = [];
    S.anthropicProcessing = false;
    S.currentProfile = profile;
    S.currentCustomPrompt = customPrompt;

    // Parse context sections for smart resume filtering (Task 4)
    parseContextSections(customPrompt);

    console.log('New conversation session started:', S.currentSessionId, 'profile:', profile);

    // Persist session context to disk immediately (no IPC round-trip)
    if (profile) {
        console.log('[STORAGE DEBUG] persistSession -> context', { sessionId: S.currentSessionId, profile, customPrompt: customPrompt || '' });
        persistSession(S.currentSessionId, { profile, customPrompt: customPrompt || '' });
        sendToRenderer('save-session-context', {
            sessionId: S.currentSessionId,
            profile: profile,
            customPrompt: customPrompt || '',
        });
    }
}

/**
 * Parse context prompt into resume/JD/avoid sections for smart filtering.
 * Extracts RESUME / BACKGROUND, TARGET JOB DESCRIPTION, and WORDS/PHRASES TO AVOID
 * sections from the combined context string.
 */
function parseContextSections(contextPrompt) {
    if (!contextPrompt || typeof contextPrompt !== 'string') {
        S.resumeText = '';
        S.jobDescriptionText = '';
        S.avoidWordsText = '';
        return;
    }

    const resumeMatch = contextPrompt.match(/RESUME \/ BACKGROUND:\n([\s\S]*?)(?=\n\n(?:TARGET JOB|WORDS\/PHRASES|$))/);
    const jdMatch = contextPrompt.match(/TARGET JOB DESCRIPTION:\n([\s\S]*?)(?=\n\n(?:WORDS\/PHRASES|$))/);
    const avoidMatch = contextPrompt.match(/WORDS\/PHRASES TO AVOID[^\n]*:\n([\s\S]*?)$/);

    S.resumeText = resumeMatch ? resumeMatch[1].trim() : '';
    S.jobDescriptionText = jdMatch ? jdMatch[1].trim() : '';
    S.avoidWordsText = avoidMatch ? avoidMatch[1].trim() : '';

    console.log('[Task 4] Parsed context sections:', {
        resumeLength: S.resumeText.length,
        jdLength: S.jobDescriptionText.length,
        avoidWordsLength: S.avoidWordsText.length,
    });
}

function saveConversationTurn(transcription, aiResponse) {
    if (!S.currentSessionId) {
        initializeNewSession();
    }

    const conversationTurn = {
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: aiResponse.trim(),
    };

    S.conversationHistory.push(conversationTurn);

    // Write directly to disk from main process — survives crashes and renderer busy states
    console.log('[STORAGE DEBUG] persistSession -> conversation turn', {
        sessionId: S.currentSessionId,
        newTurn: conversationTurn,
        totalTurns: S.conversationHistory.length,
    });
    persistSession(S.currentSessionId, { conversationHistory: S.conversationHistory });
    console.log('Saved conversation turn:', conversationTurn);

    // Also notify renderer (for HistoryView live updates)
    sendToRenderer('save-conversation-turn', {
        sessionId: S.currentSessionId,
        turn: conversationTurn,
        fullHistory: S.conversationHistory,
    });
}

function saveScreenAnalysis(prompt, response, model) {
    if (!S.currentSessionId) {
        initializeNewSession();
    }

    const analysisEntry = {
        timestamp: Date.now(),
        prompt: prompt,
        response: response.trim(),
        model: model,
    };

    S.screenAnalysisHistory.push(analysisEntry);

    // Write directly to disk from main process
    console.log('[STORAGE DEBUG] persistSession -> screen analysis', {
        sessionId: S.currentSessionId,
        newEntry: analysisEntry,
        total: S.screenAnalysisHistory.length,
    });
    persistSession(S.currentSessionId, { screenAnalysisHistory: S.screenAnalysisHistory });
    console.log('Saved screen analysis:', analysisEntry);

    // Also notify renderer (for HistoryView live updates)
    sendToRenderer('save-screen-analysis', {
        sessionId: S.currentSessionId,
        analysis: analysisEntry,
        fullHistory: S.screenAnalysisHistory,
        profile: S.currentProfile,
        customPrompt: S.currentCustomPrompt,
    });
}

function getCurrentSessionData() {
    return {
        sessionId: S.currentSessionId,
        history: S.conversationHistory,
    };
}

// Build context message for session restoration
function buildContextMessage() {
    const lastTurns = S.conversationHistory.slice(-20);
    const validTurns = lastTurns.filter(turn => turn.transcription?.trim() && turn.ai_response?.trim());

    if (validTurns.length === 0) return null;

    const contextLines = validTurns.map(turn => `[Interviewer]: ${turn.transcription.trim()}\n[Your answer]: ${turn.ai_response.trim()}`);

    return `Session reconnected. Here's the conversation so far:\n\n${contextLines.join('\n\n')}\n\nContinue from here.`;
}

// ── History mappers (provider message formats) ──────────────────────

// Map recent conversation into Anthropic messages (role user/assistant),
// dropping leading assistant turns so the array starts with a user turn.
function recentHistoryAsAnthropicMessages(maxTurns = 8) {
    if (!Array.isArray(S.groqConversationHistory) || S.groqConversationHistory.length === 0) return [];
    const msgs = S.groqConversationHistory
        .slice(-maxTurns)
        .map(m => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: typeof m.content === 'string' ? m.content : String(m.content || ''),
        }))
        .filter(m => m.content.trim());
    while (msgs.length && msgs[0].role === 'assistant') msgs.shift();
    return msgs;
}

// Map the recent conversation into Gemini `contents` turns so a screenshot
// answer is coherent with what has already been said in the session.
// Gemini uses the role name 'model' (not 'assistant').
function recentHistoryAsGeminiContents(maxTurns = 8) {
    if (!Array.isArray(S.groqConversationHistory) || S.groqConversationHistory.length === 0) return [];
    return S.groqConversationHistory
        .slice(-maxTurns)
        .map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: typeof m.content === 'string' ? m.content : String(m.content || '') }],
        }))
        .filter(t => t.parts[0].text.trim());
}

// Record a screenshot exchange in the shared conversation history so subsequent
// audio answers stay aware of what was shown/answered on screen. Includes an
// OCR excerpt of the screen content (when available, stashed by the vision
// router on S.lastScreenOcrExcerpt) so a later screenshot showing a failed
// run/test can be recognized as a follow-up to THIS exchange.
function recordScreenTurnInHistory(answer) {
    if (!answer || !answer.trim()) return;
    const excerpt = (S.lastScreenOcrExcerpt || '').trim();
    const userContent = excerpt
        ? `(I shared a screenshot. On-screen content excerpt: "${excerpt.slice(0, 400)}")`
        : '(I shared my screen and asked for help with what was shown.)';
    S.lastScreenOcrExcerpt = null;
    S.groqConversationHistory.push({ role: 'user', content: userContent });
    S.groqConversationHistory.push({ role: 'assistant', content: answer.trim() });
    if (S.groqConversationHistory.length > 20) {
        S.groqConversationHistory = S.groqConversationHistory.slice(-20);
    }
}

module.exports = {
    initializeNewSession,
    saveConversationTurn,
    saveScreenAnalysis,
    getCurrentSessionData,
    buildContextMessage,
    recentHistoryAsAnthropicMessages,
    recentHistoryAsGeminiContents,
    recordScreenTurnInHistory,
};
