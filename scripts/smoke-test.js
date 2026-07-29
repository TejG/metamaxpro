#!/usr/bin/env node
/**
 * Smoke test — verifies the LLM pipeline modules load and behave correctly
 * without launching Electron. Run with: npm test
 */

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ✗ ${name}: ${err.message}`);
    }
}
function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
}

console.log('\n1. Module loading');
let gemini, state, router, config, prompts;
check('llm/index.js facade loads', () => {
    gemini = require('../src/utils/llm');
});
check('llm/state.js loads', () => {
    state = require('../src/utils/llm/state.js');
});
check('llm/router.js loads', () => {
    router = require('../src/utils/llm/router.js');
});
check('llm/config.js loads', () => {
    config = require('../src/utils/llm/config.js');
});
check('llm/vision.js loads', () => {
    require('../src/utils/llm/vision.js');
});
check('llm/audio.js loads', () => {
    require('../src/utils/llm/audio.js');
});
check('llm/persistence.js loads', () => {
    require('../src/utils/llm/persistence.js');
});
check('llm/telemetry.js loads', () => {
    require('../src/utils/llm/telemetry.js');
});
check('providers/groq.js loads', () => {
    require('../src/utils/llm/providers/groq.js');
});
check('providers/anthropic.js loads', () => {
    require('../src/utils/llm/providers/anthropic.js');
});
check('providers/gemini.js loads', () => {
    require('../src/utils/llm/providers/gemini.js');
});
check('prompts.js loads', () => {
    prompts = require('../src/utils/prompts.js');
});

console.log('\n2. Export surface');
const EXPECTED_EXPORTS = ['setupGeminiIpcHandlers', 'stopMacOSAudioCapture', 'sendToRenderer', 'initializeNewSession', 'saveConversationTurn'];
check('facade exposes required exports', () => {
    for (const name of EXPECTED_EXPORTS) {
        assert(typeof gemini[name] === 'function', `missing export: ${name}`);
    }
});
check('facade export count is 16', () => {
    assert(Object.keys(gemini).length === 16, `got ${Object.keys(gemini).length}`);
});

console.log('\n3. Stream throttle (state.js)');
check('sendStreamUpdate / flushStreamUpdate / discardStreamUpdate exported', () => {
    assert(typeof state.sendStreamUpdate === 'function', 'sendStreamUpdate missing');
    assert(typeof state.flushStreamUpdate === 'function', 'flushStreamUpdate missing');
    assert(typeof state.discardStreamUpdate === 'function', 'discardStreamUpdate missing');
});

console.log('\n4. Telemetry (telemetry.js)');
check('telemetry exports reset / mark / getLog', () => {
    const tel = require('../src/utils/llm/telemetry.js');
    assert(typeof tel.reset === 'function', 'reset missing');
    assert(typeof tel.mark === 'function', 'mark missing');
    assert(typeof tel.getLog === 'function', 'getLog missing');
});
check('telemetry records a full cycle and logs it', () => {
    const tel = require('../src/utils/llm/telemetry.js');
    tel.reset();
    tel.mark('speechEnd');
    tel.mark('transcriptReady');
    tel.mark('ttft', 'groq:test');
    tel.mark('done');
    const log = tel.getLog();
    assert(log.length >= 1, 'no log entries');
    const entry = log[log.length - 1];
    assert(entry.provider === 'groq:test', 'provider not recorded');
    assert(typeof entry.total === 'number', 'total not a number');
});

console.log('\n5. ProviderAdapter interface');
check('groq adapter has required interface', () => {
    const g = require('../src/utils/llm/providers/groq.js');
    assert(g.name === 'groq', 'name missing');
    assert(typeof g.isAvailable === 'function', 'isAvailable missing');
    assert(typeof g.streamAnswer === 'function', 'streamAnswer missing');
    assert(typeof g.listModels === 'function', 'listModels missing');
});
check('anthropic adapter has required interface', () => {
    const a = require('../src/utils/llm/providers/anthropic.js');
    assert(a.name === 'anthropic', 'name missing');
    assert(typeof a.isAvailable === 'function');
    assert(typeof a.streamAnswer === 'function');
    assert(typeof a.listModels === 'function');
    assert(typeof a.fetchWithAnthropicRetry === 'function', 'fetchWithAnthropicRetry missing');
});
check('gemini adapter has required interface', () => {
    const g = require('../src/utils/llm/providers/gemini.js');
    assert(g.name === 'gemini', 'name missing');
    assert(typeof g.isAvailable === 'function');
    assert(typeof g.streamAnswer === 'function');
    assert(typeof g.listModels === 'function');
});

console.log('\n4. System prompts');
check('getSystemPrompt returns non-empty text per profile', () => {
    assert(typeof prompts.getSystemPrompt === 'function', 'getSystemPrompt missing');
    for (const profile of ['interview', 'sales', 'meeting', 'presentation', 'negotiation']) {
        const p = prompts.getSystemPrompt(profile, '', false);
        assert(typeof p === 'string' && p.length > 100, `empty/short prompt for ${profile}`);
    }
});
check('prompts include live audio awareness', () => {
    const p = prompts.getSystemPrompt('interview', '', false);
    assert(/LIVE AUDIO AWARENESS/i.test(p), 'LIVE AUDIO AWARENESS section missing');
});

console.log('\n6. Cascade order (router.js source check)');
check('Lane A is Groq-first (adapter-based)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../src/utils/llm/router.js'), 'utf8');
    // laneA is the non-reasoning array; find its definition and verify groqAdapter comes first.
    const laneADef = src.match(/const laneA\s*=\s*\[[\s\S]*?\];/);
    assert(laneADef, 'could not locate laneA definition');
    const groqIdx = laneADef[0].indexOf('groqAdapter');
    const anthIdx = laneADef[0].indexOf('anthropicAdapter');
    assert(groqIdx !== -1 && (anthIdx === -1 || groqIdx < anthIdx), 'Groq is not first in Lane A');
});
check('router discards stale partials between providers', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../src/utils/llm/router.js'), 'utf8');
    assert(src.includes('discardStreamUpdate'), 'discardStreamUpdate not used in router');
    assert(src.includes('flushStreamUpdate'), 'flushStreamUpdate not used in router');
});

console.log(failures === 0 ? '\nAll smoke tests passed ✅\n' : `\n${failures} smoke test(s) FAILED ❌\n`);
process.exit(failures === 0 ? 0 : 1);
