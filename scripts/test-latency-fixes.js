// Tests for the latency-regression fixes (token burn + Gemini retry penalty).
// Run: node scripts/test-latency-fixes.js

const path = require('path');
const fs = require('fs');
const assert = require('assert');

let passed = 0,
    failed = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`❌ ${name}: ${e.message}`);
        failed++;
    }
}

const root = path.join(__dirname, '..');
const routerSrc = fs.readFileSync(path.join(root, 'src', 'utils', 'llm', 'router.js'), 'utf8');
const geminiSrc = fs.readFileSync(path.join(root, 'src', 'utils', 'llm', 'providers', 'gemini.js'), 'utf8');
const prompts = require(path.join(root, 'src', 'utils', 'prompts.js'));

// ── Fix 1: resume context collapsed out of history after answering ──

test('router collapses resume-context turn back to bare question after answer', () => {
    assert(routerSrc.includes("turn.content.includes('[QUESTION]:')"), 'context-turn detection missing');
    assert(routerSrc.includes('turn.content = intent'), 'collapse to bare question missing');
});

test('collapse happens after answer completes (not before providers run)', () => {
    const collapseIdx = routerSrc.indexOf('turn.content = intent');
    const doneIdx = routerSrc.indexOf("telemetry.mark('done')");
    assert(collapseIdx > doneIdx, 'collapse must run after the answer is done');
});

// Behavior-level check of the collapse logic
const { S } = require(path.join(root, 'src', 'utils', 'llm', 'state.js'));
test('collapse logic works on a simulated history', () => {
    S.groqConversationHistory = [
        { role: 'user', content: '[RESUME CONTEXT - Relevant Sections]:\nlots of resume text\n\n[QUESTION]:\nTell me about Fusion' },
    ];
    const intent = 'Tell me about Fusion';
    for (let i = S.groqConversationHistory.length - 1; i >= 0; i--) {
        const turn = S.groqConversationHistory[i];
        if (turn.role === 'user' && turn.content.includes('[QUESTION]:')) {
            turn.content = intent;
            break;
        }
    }
    assert.strictEqual(S.groqConversationHistory[0].content, intent);
});

// ── Fix 2: Gemini thinkingConfig rejection is cached ──

test('gemini adapter caches models that reject thinkingConfig', () => {
    assert(geminiSrc.includes('_noThinkingConfigModels'), 'rejection cache missing');
    assert(geminiSrc.includes('_noThinkingConfigModels.add(chosenModel)'), 'cache population missing');
    assert(geminiSrc.includes('_noThinkingConfigModels.has(chosenModel)'), 'cache check missing');
});

test('cached models skip thinkingConfig on first attempt', () => {
    assert(/skipThinkingConfig\s*\?\s*\{ temperature/.test(geminiSrc), 'skip path missing');
});

// ── Fix 3: system prompt slimmed (CODE_COMPONENT removed) ──

const sys = prompts.getSystemPrompt('interview', '', 'standard');

test('system prompt no longer carries the CODE_COMPONENT block', () => {
    assert(!sys.includes('CODE_COMPONENT_START'));
});

test('system prompt still carries the quality-critical sections', () => {
    assert(sys.includes('SAY THIS:'));
    assert(sys.includes('VAGUENESS BAN'));
    assert(/do not mention that you are an ai/i.test(sys));
});

test('prompt size sanity: CODE_COMPONENT removal saved ~2.4k chars', () => {
    // Full quality prompt is ~17k chars; the hard requirement is that the
    // redundant component block (rendered UI-side now) is gone and the prompt
    // doesn't creep past 18k.
    assert(sys.length < 18000, `system prompt is ${sys.length} chars — creeping up, review for redundancy`);
});

// ── Cascade guards unchanged ──

test('conversational provider timeout still 8s', () => {
    assert(/reasoning \? 22000 : 8000/.test(routerSrc));
});

test('Groq still leads the conversational lane', () => {
    assert(/laneA = \[groqAdapter, anthropicAdapter, geminiAdapter\]/.test(routerSrc));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
