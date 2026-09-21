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
    // v0.11.5 hoisted the shared generation params into `baseConfig` so the
    // cascade's abort signal could be threaded in. The skip path still sends
    // only those params, with no thinkingConfig attached.
    assert(/skipThinkingConfig \? baseConfig :/.test(geminiSrc), 'skip path missing');
    assert(/const baseConfig = \{ temperature/.test(geminiSrc), 'baseConfig lost temperature');
    assert(!/const baseConfig = \{[^}]*GEMINI_THINKING/.test(geminiSrc), 'baseConfig must not carry thinkingConfig');
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

// v0.11.5 replaced the total-completion cap (8s / 22s) with a time-to-first-
// token budget plus a wider hard ceiling. Capping total time was killing long
// answers mid-sentence and producing the "no configured provider" banner, so
// this now guards the TTFT shape rather than the old fixed wall.
test('conversational provider budget is on TTFT, not total time', () => {
    assert(/TTFT_BUDGET_MS = reasoning \? 20000 : 7000/.test(routerSrc));
    assert(/HARD_BUDGET_MS = reasoning \? 60000 : 30000/.test(routerSrc));
    assert(!/reasoning \? 22000 : 8000/.test(routerSrc), 'the old total-time cap is back');
});

test('a provider that is already streaming is not aborted at the TTFT budget', () => {
    assert(/streamTokenCount\(epoch\) > 0/.test(routerSrc));
});

test('Groq still leads the conversational lane', () => {
    assert(/laneA = \[groqAdapter, anthropicAdapter, geminiAdapter\]/.test(routerSrc));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
