// Tests the answer cascade's latency budget and stream ownership.
//
// Regression guard for the "Could not get an answer from any configured
// provider" banner that appeared mid-session while every provider was healthy:
// the budget capped TOTAL completion time (8s conversational), so a long answer
// over a big resume/JD context got aborted mid-sentence, all three providers
// were killed the same way, and the banner blamed the API keys.
//
// Run: node scripts/test-answer-cascade.js
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = (...p) => path.join(ROOT, 'src', 'utils', 'llm', ...p);
const stub = (id, exports) => {
    require.cache[id] = { id, filename: id, loaded: true, exports };
};

// Electron isn't running, so capture IPC instead of sending it.
const sent = [];
const webContents = { isDestroyed: () => false, send: (channel, data) => sent.push([channel, data]) };
const win = { isDestroyed: () => false, webContents };
stub(require.resolve('electron', { paths: [ROOT] }), {
    BrowserWindow: { getAllWindows: () => [win], getFocusedWindow: () => win },
});

// Keep the test hermetic — no session history written to the real config dir.
stub(require.resolve(src('persistence.js')), {
    initializeNewSession: () => {},
    saveConversationTurn: () => {},
    recentHistoryAsAnthropicMessages: () => [{ role: 'user', content: 'q' }],
    recentHistoryAsGeminiContents: () => [],
    recordScreenTurnInHistory: () => {},
});

const state = require(src('state.js'));
const { S, sendStreamUpdate } = state;

const adapters = {};
for (const name of ['groq', 'anthropic', 'gemini']) {
    adapters[name] = { name, isAvailable: () => true, streamAnswer: async () => null, listModels: async () => [] };
    stub(require.resolve(src('providers', name + '.js')), adapters[name]);
}

const router = require(src('router.js'));
const health = require(src('providers', 'health.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lastResponse = () => {
    for (let i = sent.length - 1; i >= 0; i--) if (sent[i][0] === 'update-response') return sent[i][1];
    return null;
};
function reset() {
    sent.length = 0;
    S.groqConversationHistory = [];
    S.lastProcessedIntent = '';
    S.resumeText = '';
    S.currentSystemPrompt = 'test';
    health._resetForTests();
    for (const a of Object.values(adapters)) {
        a.isAvailable = () => true;
        a.streamAnswer = async () => null;
    }
}

let passed = 0,
    failed = 0;
function check(name, cond, extra = '') {
    if (cond) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failed++;
        console.error(`  ✗ ${name}${extra ? ' → ' + extra : ''}`);
    }
}

(async () => {
    console.log('— a silent provider is abandoned, the cascade moves on —');
    reset();
    let aborted = false;
    adapters.groq.streamAnswer = async ({ controller }) => {
        controller.signal.addEventListener('abort', () => {
            aborted = true;
        });
        await sleep(60000); // never emits a token
        return 'too late';
    };
    adapters.anthropic.streamAnswer = async ({ epoch }) => {
        sendStreamUpdate('anthropic answer', epoch);
        return 'anthropic answer';
    };
    let started = Date.now();
    await router.routeAnswer('what is a taxonomy');
    check('silent provider is aborted at the TTFT budget', aborted);
    check('cascade falls through to the next provider', lastResponse() === 'anthropic answer', String(lastResponse()));
    check('one dead provider costs ~7s, not 3 × 8s', Date.now() - started < 12000, `${Date.now() - started}ms`);

    console.log('— a provider that is streaming is allowed to finish —');
    reset();
    adapters.groq.streamAnswer = async ({ epoch, controller }) => {
        let out = '';
        for (let i = 0; i < 18; i++) {
            if (controller.signal.aborted) return null;
            out += `chunk${i} `;
            sendStreamUpdate(out, epoch);
            await sleep(500); // 9s total — past the old 8s total-time cap
        }
        return out.trim();
    };
    started = Date.now();
    await router.routeAnswer('explain workfront planning');
    const slow = lastResponse();
    check('a 9s streaming answer is not killed mid-sentence', !!slow && slow.includes('chunk17'), String(slow));
    check('no failure banner for a healthy slow provider', !!slow && !slow.includes('⚠️'), String(slow));
    console.log(`    (completed in ${Date.now() - started}ms)`);

    console.log('— an abandoned stream cannot overwrite the answer —');
    reset();
    adapters.groq.streamAnswer = async ({ epoch }) => {
        await sleep(8000); // blows the budget in silence, then keeps typing
        for (let i = 0; i < 5; i++) {
            sendStreamUpdate('STALE GROQ TEXT', epoch);
            await sleep(200);
        }
        return 'stale';
    };
    adapters.anthropic.streamAnswer = async ({ epoch }) => {
        sendStreamUpdate('winning answer', epoch);
        return 'winning answer';
    };
    await router.routeAnswer('another question');
    await sleep(3000); // let the abandoned stream fire after we moved on
    check('late tokens from a superseded epoch are dropped', lastResponse() === 'winning answer', String(lastResponse()));

    console.log('— the failure banner tells the truth —');
    reset();
    await router.routeAnswer('a third question');
    const banner = lastResponse();
    check('names the providers that failed', /groq/.test(banner) && /anthropic/.test(banner) && /gemini/.test(banner), String(banner));
    check('does not claim the keys are missing when they are not', !/No AI provider is configured/.test(banner), String(banner));

    reset();
    for (const a of Object.values(adapters)) a.isAvailable = () => false;
    await router.routeAnswer('a fourth question');
    check('says so when no provider really is configured', /No AI provider is configured/.test(lastResponse()), String(lastResponse()));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
