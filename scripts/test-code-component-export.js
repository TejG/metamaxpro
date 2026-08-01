// Tests for: CODE_COMPONENT two-column format, per-response copy buttons,
// and transcript export.
// Run: node scripts/test-code-component-export.js

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
const prompts = require(path.join(root, 'src', 'utils', 'prompts.js'));
const assistantSrc = fs.readFileSync(path.join(root, 'src', 'components', 'views', 'AssistantView.js'), 'utf8');
const historySrc = fs.readFileSync(path.join(root, 'src', 'components', 'views', 'HistoryView.js'), 'utf8');
const llmIndexSrc = fs.readFileSync(path.join(root, 'src', 'utils', 'llm', 'index.js'), 'utf8');

// ── Prompt: CODE_COMPONENT instructions ──

test('CODE_COMPONENT_PROMPT is exported', () => {
    assert(typeof prompts.CODE_COMPONENT_PROMPT === 'string' && prompts.CODE_COMPONENT_PROMPT.length > 100);
});

const sys = prompts.getSystemPrompt('interview', '', 'standard');

test('system prompt includes the CODE_COMPONENT format', () => {
    assert(sys.includes('CODE_COMPONENT_START'));
    assert(sys.includes('LEFT_EXPLANATION:'));
    assert(sys.includes('RIGHT_CODE:'));
    assert(sys.includes('CODE_COMPONENT_END'));
});

test('component only triggers for technical questions', () => {
    assert(/behavioral, situational, general knowledge, or non-technical/.test(sys));
    assert(/do NOT use this component/i.test(sys));
});

test('component rules: never mix code into spoken explanation', () => {
    assert(/Never put the code inside the spoken explanation/.test(sys));
});

test('standard mode layers still intact alongside the component', () => {
    assert(sys.includes('SAY THIS:'));
    assert(sys.includes('SHORT VERSION:'));
    assert(sys.includes('VAGUENESS BAN'));
});

// ── UI: two-column renderer ──

test('AssistantView parses CODE_COMPONENT markers', () => {
    assert(assistantSrc.includes('_renderCodeComponent'));
    assert(assistantSrc.includes("includes('CODE_COMPONENT_START')"));
});

test('renderer extracts left/right/language and tolerates malformed input', () => {
    assert(/LEFT_EXPLANATION:\\s\*/.test(assistantSrc));
    assert(/RIGHT_CODE:\\s\*/.test(assistantSrc));
    assert(/LANGUAGE:\\s\*/.test(assistantSrc));
    assert(assistantSrc.includes('return null'), 'no malformed fallback');
});

test('two-column CSS exists (cc-left / cc-right, responsive stack)', () => {
    assert(assistantSrc.includes('.cc-left'));
    assert(assistantSrc.includes('.cc-right'));
    assert(assistantSrc.includes('flex-direction: column'));
});

test('deterministic two-column: any code block + prose renders side-by-side', () => {
    assert(assistantSrc.includes('_maybeTwoColumn'));
    assert(assistantSrc.includes("includes('<pre')"), 'should detect rendered code blocks');
    assert(/proseText\.length < 40/.test(assistantSrc), 'should skip code-only answers');
});

// ── UI: copy buttons ──

test('per-response copy button attached to answer bubbles', () => {
    assert(assistantSrc.includes('msg-copy-btn'));
    assert(assistantSrc.includes(".querySelectorAll('.chat-msg.answer:not(.error)')"));
});

test('explanation column gets its own copy button', () => {
    assert(assistantSrc.includes(".querySelectorAll('.code-component .cc-left')"));
});

test('copy helper prefers Electron clipboard with navigator fallback', () => {
    assert(assistantSrc.includes('async _copyText('));
    assert(/clipboard\.writeText/.test(assistantSrc));
    assert(/navigator\.clipboard\.writeText/.test(assistantSrc));
});

// ── Export transcript ──

test('export-session-transcript IPC handler registered', () => {
    assert(llmIndexSrc.includes("ipcMain.handle('export-session-transcript'"));
});

test('export uses native save dialog and writes markdown', () => {
    assert(llmIndexSrc.includes('showSaveDialog'));
    assert(llmIndexSrc.includes("extensions: ['md']"));
    assert(llmIndexSrc.includes('writeFileSync'));
});

test('export covers conversation turns AND screen analyses', () => {
    assert(llmIndexSrc.includes('## Conversation'));
    assert(llmIndexSrc.includes('## Screen Analyses'));
});

test('export works for current session (no id) and saved sessions (by id)', () => {
    assert(llmIndexSrc.includes('S.currentSessionId') && llmIndexSrc.includes('getSession(sessionId)'));
});

test('HistoryView has an export button wired to the IPC handler', () => {
    assert(historySrc.includes('exportTranscript'));
    assert(historySrc.includes("invoke('export-session-transcript'"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
