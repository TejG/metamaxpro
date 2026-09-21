// Tests the Coding Interview and System Design modes: the two-phase
// clarify-before-answering prompts, and the generation budget they need.
//
// Run: node scripts/test-interview-modes.js
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const src = (...p) => path.join(ROOT, 'src', 'utils', 'llm', ...p);
const stub = (id, exports) => {
    require.cache[id] = { id, filename: id, loaded: true, exports };
};

const wc = { isDestroyed: () => false, send: () => {} };
const win = { isDestroyed: () => false, webContents: wc };
stub(require.resolve('electron', { paths: [ROOT] }), {
    BrowserWindow: { getAllWindows: () => [win], getFocusedWindow: () => win },
});
stub(require.resolve(src('persistence.js')), {
    initializeNewSession: () => {},
    saveConversationTurn: () => {},
    recentHistoryAsAnthropicMessages: () => [{ role: 'user', content: 'q' }],
    recentHistoryAsGeminiContents: () => [],
    recordScreenTurnInHistory: () => {},
});

const prompts = require(path.join(ROOT, 'src', 'utils', 'prompts.js'));
const { S } = require(src('state.js'));

// Capture the options the cascade hands each provider.
let lastOpts = null;
const adapters = {};
for (const name of ['groq', 'anthropic', 'gemini']) {
    adapters[name] = {
        name,
        isAvailable: () => true,
        streamAnswer: async opts => {
            lastOpts = opts;
            return 'answer';
        },
        listModels: async () => [],
    };
    stub(require.resolve(src('providers', name + '.js')), adapters[name]);
}
const router = require(src('router.js'));

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

console.log('— both modes resolve to their own prompt —');
const coding = prompts.profilePrompts.coding;
const design = prompts.profilePrompts.system_design;
for (const key of ['coding', 'system_design']) {
    const full = prompts.getSystemPrompt(key, '', 'standard');
    check(`${key} does not fall back to job_interview`, !full.includes('MODE: GENERAL JOB INTERVIEW'));
    check(`${key} prompt is reachable via getSystemPrompt`, full.includes(prompts.profilePrompts[key].trim().split('\n')[0]));
}

console.log('— coding: clarify before any code —');
check('has a phase gate', /PHASE 1/.test(coding) && /PHASE 2/.test(coding));
check('phase 1 forbids code, not just discourages it', /not even\s*\n?\s*pseudocode|no code, not even/i.test(coding));
check('drops the old "do not ask clarifying questions" rule', !/Do not automatically ask clarifying questions/.test(coding));
check('caps the number of questions so the interviewer waits', /Four questions maximum/i.test(coding));
check('handles orally dictated / cut-off transcripts', /dictat/i.test(coding) && /cut off/i.test(coding));
check('requires an approach menu of 2-3 options', /APPROACHES ON THE TABLE/.test(coding) && /weakest first/i.test(coding));
check('names concrete techniques to choose among', /two pointers/i.test(coding) && /sliding window/i.test(coding));
check('requires time AND space complexity per approach', (coding.match(/Time O\(\.\.\.\), Space O\(\.\.\.\)/g) || []).length >= 3);
check('requires a justified choice of approach', /WHAT I'M GOING WITH AND WHY/.test(coding));
check('requires complete runnable code, no placeholders', /No placeholders/.test(coding) && /omitted helper functions/.test(coding));
check('requires a dry run walkthrough', /DRY RUN/.test(coding));
check('requires edge cases and final complexity', /EDGE CASES HANDLED/.test(coding) && /COMPLEXITY & THE NEXT MOVE/.test(coding));
check('keeps the honesty rule about not executing code', /Never claim the code was executed/.test(coding));
check('keeps the deterministic language lock', /LANGUAGE LOCK/.test(coding) && /never switch/i.test(coding));
check('still handles screenshot problems', /SCREENSHOT/i.test(coding));

console.log('— system design: clarify before drawing —');
check('has a phase gate', /PHASE 1/.test(design) && /PHASE 2/.test(design));
check('phase 1 forbids the diagram explicitly', /NO Mermaid diagram/.test(design));
check('no longer barrels into the design in the same turn', !/While you think about those/.test(design));
check('tells the model to stop and wait after clarifying', /stop after\s*\n?\s*the assumptions offer and wait/i.test(design));
check(
    'asks about scope, scale, latency and consistency',
    /Functional scope/.test(design) && /Scale & traffic/.test(design) && /Latency & SLA/.test(design) && /Consistency & geography/.test(design)
);
check('keeps the scale math section', /Back-of-envelope/.test(design));
check('keeps the Mermaid diagram and its strict syntax rules', design.includes('```mermaid') && /STRICT Mermaid Syntax Rules/.test(design));
check('keeps write-path / read-path narration', /Write path/.test(design) && /Read path/.test(design));
check('keeps the deep dives and the instant pivot', /Hot partition/.test(design) && /instant pivot/i.test(design));

console.log('— hint mode still withholds the answer —');
check('coding hint mode withholds the code', /HINT mode[\s\S]{0,200}withhold the code/.test(coding));
check('design hint mode stops after the diagram', /HINT mode[\s\S]{0,200}let the candidate drive/.test(design));

console.log('— generation budget (a full code answer must not truncate) —');
(async () => {
    async function ask(profile, question) {
        S.currentProfile = profile;
        S.groqConversationHistory = [];
        S.lastProcessedIntent = '';
        S.resumeText = '';
        S.currentSystemPrompt = 'x';
        lastOpts = null;
        await router.routeAnswer(question);
        return lastOpts;
    }

    // "write a function to reverse a linked list" matches no arithmetic signal,
    // so without the profile check it would get 1024 tokens at temperature 0.4.
    const c = await ask('coding', 'write a function to reverse a linked list');
    check('coding gets the reasoning budget', c && c.reasoning === true, JSON.stringify(c && { reasoning: c.reasoning }));
    check('coding runs at low temperature for correctness', c && c.temperature === 0.1, String(c && c.temperature));

    const d = await ask('system_design', 'design a url shortener');
    check('system_design gets the reasoning budget', d && d.reasoning === true, String(d && d.reasoning));
    check('system_design runs at low temperature', d && d.temperature === 0.1, String(d && d.temperature));

    // Guard the fast path: conversational profiles must NOT be slowed down.
    const b = await ask('job_interview', 'tell me about a time you led a project');
    check('behavioral questions stay on the fast path', b && b.reasoning === false, String(b && b.reasoning));
    check('interview temperature unchanged at 0.2', b && b.temperature === 0.2, String(b && b.temperature));

    console.log('— the modes are selectable in the UI —');
    const read = f => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    const main = read('components/views/MainView.js');
    const customize = read('components/views/CustomizeView.js');
    const app = read('components/app/MetaMaxProApp.js');
    for (const v of ['coding', 'system_design']) {
        check(`MainView dropdown offers ${v}`, new RegExp(`value: '${v}'`).test(main));
        check(`CustomizeView offers ${v}`, new RegExp(`value: '${v}'`).test(customize));
        check(`live bar has a label for ${v}`, new RegExp(`${v}:`).test(app));
    }
    // The router's technical-profile check must use the same keys the UI sends.
    const routerSrc = fs.readFileSync(path.join(ROOT, 'src', 'utils', 'llm', 'router.js'), 'utf8');
    check(
        "router keys match the dropdown's values",
        /currentProfile === 'coding'/.test(routerSrc) && /currentProfile === 'system_design'/.test(routerSrc)
    );

    // These two modes carry the largest profile blocks in the app and the system
    // prompt is resent on every question, so guard against unchecked creep.
    console.log('— prompt size —');
    for (const [key, cap] of [
        ['coding', 19000],
        ['system_design', 21000],
    ]) {
        const len = prompts.getSystemPrompt(key, '', 'standard').length;
        check(`${key} system prompt under ${cap} chars`, len < cap, `${len} chars`);
        console.log(`    ${key}: ${len} chars`);
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
