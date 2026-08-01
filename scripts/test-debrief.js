// Tests for the end-of-call debrief + dynamic third section features.
// Run: node scripts/test-debrief.js

const path = require('path');
const assert = require('assert');

const prompts = require(path.join(__dirname, '..', 'src', 'utils', 'prompts.js'));

let passed = 0;
let failed = 0;
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

// ── Dynamic third section in standard mode ──

const std = prompts.getSystemPrompt('interview', '', 'standard');

test('standard mode keeps SAY THIS and SHORT VERSION layers', () => {
    assert(std.includes('SAY THIS:'));
    assert(std.includes('SHORT VERSION:'));
});

test('standard mode third section is dynamic (tone-based)', () => {
    assert(std.includes('DYNAMIC'), 'missing DYNAMIC marker');
    assert(std.includes('IF THEY PUSH DEEPER:'));
    assert(std.includes('LIKELY FOLLOW-UP:'));
    assert(std.includes('KEEP IT TIGHT:'));
    assert(std.includes('RAPPORT MOVE:'));
});

test('standard mode instructs to pick exactly one third section', () => {
    assert(/EXACTLY ONE/i.test(std));
});

test('standard mode has a default when tone is unknown', () => {
    assert(/default to IF THEY PUSH DEEPER/i.test(std));
});

test('standard mode retains VAGUENESS BAN and business anchoring', () => {
    assert(std.includes('VAGUENESS BAN'));
    assert(std.includes('business scenario or use case'));
});

// ── Debrief prompt builder ──

const turns = [
    { transcription: 'Tell me about your Workfront experience.', ai_response: 'I have 7 years configuring Workfront...' },
    { transcription: 'How did you handle Fusion errors?', ai_response: 'I built retry logic with exponential backoff...' },
];

test('getDebriefPrompt is exported', () => {
    assert.strictEqual(typeof prompts.getDebriefPrompt, 'function');
});

const { system, user } = prompts.getDebriefPrompt(turns, 'RESUME: Senior Workfront Consultant');

test('debrief system prompt requires all four sections', () => {
    assert(system.includes('HOW THE CALL WENT:'));
    assert(system.includes('WHAT WORKED:'));
    assert(system.includes('WHAT TO IMPROVE:'));
    assert(system.includes('NEXT STEPS:'));
});

test('debrief system prompt covers follow-up email decision', () => {
    assert(system.includes('FOLLOW-UP EMAIL:'));
    assert(/subject line/i.test(system));
});

test('debrief user prompt contains transcript turns and context', () => {
    assert(user.includes('Tell me about your Workfront experience.'));
    assert(user.includes('retry logic'));
    assert(user.includes('Senior Workfront Consultant'));
});

test('debrief handles empty transcript gracefully', () => {
    const r = prompts.getDebriefPrompt([], '');
    assert(r.user.includes('no conversation turns'));
});

// ── Debrief module ──

const debrief = require(path.join(__dirname, '..', 'src', 'utils', 'llm', 'debrief.js'));

test('debrief module exports generateCallDebrief', () => {
    assert.strictEqual(typeof debrief.generateCallDebrief, 'function');
    assert(debrief.MIN_TURNS_FOR_DEBRIEF >= 1);
});

test('generateCallDebrief refuses with too few turns', async () => {
    const { S } = require(path.join(__dirname, '..', 'src', 'utils', 'llm', 'state.js'));
    S.conversationHistory = [];
    return debrief.generateCallDebrief().then(res => {
        assert.strictEqual(res.success, false);
        assert(/not enough/i.test(res.error));
    });
});

// ── IPC wiring (source-level check) ──

const fs = require('fs');
const llmIndexSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'llm', 'index.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'app', 'MetaMaxProApp.js'), 'utf8');

test('generate-call-debrief IPC handler is registered', () => {
    assert(llmIndexSrc.includes("ipcMain.handle('generate-call-debrief'"));
});

test('renderer triggers debrief on session stop', () => {
    assert(appSrc.includes("invoke('generate-call-debrief')"));
});

setTimeout(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}, 500);
