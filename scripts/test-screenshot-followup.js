// Tests for screenshot follow-up handling + coding verification fixes.
// Run: node scripts/test-screenshot-followup.js

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
const rendererSrc = fs.readFileSync(path.join(root, 'src', 'utils', 'renderer.js'), 'utf8');
const visionSrc = fs.readFileSync(path.join(root, 'src', 'utils', 'llm', 'vision.js'), 'utf8');

// ── Screenshot prompt: follow-up branch ──

test('screenshot prompt has follow-up detection branch', () => {
    assert(rendererSrc.includes('FOLLOW-UP TO A PREVIOUS ANSWER'));
    assert(/DEBUG follow-up/.test(rendererSrc));
});

test('follow-up branch requires tracing failing input through previous code', () => {
    assert(/trace the failing input through the previous code/i.test(rendererSrc));
});

test('follow-up branch forbids repeating same code', () => {
    assert(/Do NOT output the same code again/.test(rendererSrc));
});

// ── Screenshot prompt: mandatory verification ──

test('coding rules include mandatory example tracing before output', () => {
    assert(rendererSrc.includes('MANDATORY VERIFICATION'));
    assert(/mentally execute your solution against EVERY example/i.test(rendererSrc));
});

test('coding rules warn about classic runtime killers', () => {
    assert(/off-by-one/.test(rendererSrc));
});

// ── History: OCR excerpt for follow-up recognition ──

const { S } = require(path.join(root, 'src', 'utils', 'llm', 'state.js'));
const persistence = require(path.join(root, 'src', 'utils', 'llm', 'persistence.js'));

test('recordScreenTurnInHistory embeds OCR excerpt when available', () => {
    S.groqConversationHistory = [];
    S.lastScreenOcrExcerpt = 'Two Sum: given an array of integers nums and target...';
    persistence.recordScreenTurnInHistory('def twoSum(...): ...');
    const userTurn = S.groqConversationHistory[0];
    assert(userTurn.content.includes('Two Sum'), 'excerpt missing from history turn');
    assert.strictEqual(S.lastScreenOcrExcerpt, null, 'excerpt not cleared after use');
});

test('recordScreenTurnInHistory falls back to generic text without excerpt', () => {
    S.groqConversationHistory = [];
    S.lastScreenOcrExcerpt = null;
    persistence.recordScreenTurnInHistory('some answer');
    assert(S.groqConversationHistory[0].content.includes('shared my screen'));
});

test('vision router stashes OCR excerpt on state', () => {
    assert(visionSrc.includes('S.lastScreenOcrExcerpt ='));
});

// ── Reasoning for coding screenshots ──

test('OCR text-LLM route enables reasoning for coding exercises', () => {
    assert(visionSrc.includes('looksLikeCodingExercise'));
    assert(/reasoning:\s*looksLikeCode/.test(visionSrc));
});

const config = require(path.join(root, 'src', 'utils', 'llm', 'config.js'));

test('Gemini thinking budget raised for code tracing', () => {
    assert(config.GEMINI_THINKING.thinkingConfig.thinkingBudget >= 4096);
});

test('looksLikeCodingExercise detects coding text', () => {
    assert.strictEqual(typeof config.looksLikeCodingExercise, 'function');
    assert(config.looksLikeCodingExercise('Write a function that returns the two indices'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
