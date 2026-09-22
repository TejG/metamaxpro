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

console.log('— system design: four phases, diagram last —');
for (const n of [1, 2, 3, 4]) check(`has phase ${n}`, new RegExp(`PHASE ${n}`).test(design));
check(
    'phases run scope -> confirm -> design -> diagram',
    /PHASE 1 - SCOPE/.test(design) && /PHASE 2 - CONFIRM/.test(design) && /PHASE 3 - HIGH-LEVEL/.test(design) && /PHASE 4 - ARCHITECTURE/.test(design)
);
check('states the diagram comes last, never first', /diagram is the LAST thing you produce, never the first/.test(design));
check('delivers one phase per turn', /Deliver ONE phase per turn/.test(design));
check('no longer barrels into the design in the same turn', !/While you think about those/.test(design));

check('phase 1 forbids components and the diagram', /No components, no architecture, no diagram/.test(design));
check('phase 1 must not answer its own questions', /Do not answer your own questions/.test(design));
check(
    'phase 1 asks scope, scale, latency, consistency',
    /Functional scope/.test(design) &&
        /Scale and traffic/.test(design) &&
        /Latency and availability/.test(design) &&
        /Consistency and geography/.test(design)
);

check('phase 2 confirms the discovery decisions', /CONFIRMED REQUIREMENTS/.test(design) && /DECISIONS MADE/.test(design));
check('phase 2 names what is out of scope', /out of scope/i.test(design));
check('phase 2 shows the scale arithmetic', /BACK OF THE ENVELOPE/.test(design) && /86400/.test(design));
check('phase 2 still has no diagram', /Still no architecture and no diagram/.test(design));

check('phase 3 covers high-level AND low-level', /HIGH-LEVEL DESIGN/.test(design) && /LOW-LEVEL DESIGN/.test(design));
check('phase 3 covers API surface and data model', /API surface/.test(design) && /Data model/.test(design) && /partition key/.test(design));
check('phase 3 narrates write and read paths', /Write path/.test(design) && /Read path/.test(design));
check('phase 3 still withholds the diagram', /Still no diagram/.test(design));

check('phase 4 has the diagram', design.includes('```mermaid'));
check('phase 4 explains what each block does', /WHAT EACH BLOCK DOES/.test(design) && /Every node in the diagram must appear here/.test(design));
check('phase 4 explains how data flows', /HOW DATA FLOWS/.test(design) && /following the arrows/.test(design));
check('phase 4 covers scaling and failure', /SCALING AND FAILURE/.test(design) && /Hot key or celebrity/.test(design));
check('keeps the instant-pivot pattern', /CHALLENGES A CHOICE/.test(design));

console.log('— mermaid rules match what the renderer can parse —');
check('rules are stated as hard requirements', /hard requirements, not style preferences/.test(design));
check('forbids labelled arrows', /never a labelled arrow/.test(design));
check('forbids reserved words as node ids', /Never use end,/.test(design));
check(
    'forbids style directives, emoji, br and curly quotes',
    /No style, classDef or linkStyle/.test(design) && /No emoji, no <br>, no curly quotes/.test(design)
);
check('caps the node count', /8-14 nodes/.test(design));

console.log('— no emoji anywhere in the prompts —');
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
for (const [k, body] of Object.entries(prompts.profilePrompts)) check(`${k} has no emoji`, !EMOJI.test(body));
for (const [k, body] of Object.entries(prompts.responseModes)) check(`response mode ${k} has no emoji`, !EMOJI.test(body));

console.log('— hint mode still withholds the answer —');
check('coding hint mode withholds the code', /HINT mode[\s\S]{0,200}withhold the code/.test(coding));
check('design hint mode hands control back', /HINT mode[\s\S]{0,260}let the candidate\s*\n?\s*drive/.test(design));

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
    // The UI reads its mode list from the shared registry, so being in the
    // registry is what makes a mode appear everywhere (start dropdown, Profile
    // tab, live bar, answer window, history). scripts/test-profile-registry.js
    // asserts each site actually imports it.
    const { PROFILES, getProfileLabel } = await import('file://' + path.join(ROOT, 'src/components/profiles.js'));
    for (const v of ['coding', 'system_design']) {
        check(
            `${v} is in the shared profile registry`,
            PROFILES.some(p => p.value === v)
        );
        check(`${v} has a human-readable label`, getProfileLabel(v) !== v, getProfileLabel(v));
    }
    // The router's technical-profile check must use the same keys the UI sends.
    const routerSrc = fs.readFileSync(path.join(ROOT, 'src', 'utils', 'llm', 'router.js'), 'utf8');
    check(
        "router keys match the dropdown's values",
        /currentProfile === 'coding'/.test(routerSrc) && /currentProfile === 'system_design'/.test(routerSrc)
    );

    console.log('— system design renders single-column, coding stays side-by-side —');
    const av = fs.readFileSync(path.join(ROOT, 'src/components/views/AssistantView.js'), 'utf8');
    check('renderMarkdown branches on the system_design profile', /const singleColumn = this\.selectedProfile === 'system_design'/.test(av));
    check('system design skips the two-column split', /singleColumn \? rendered : this\._maybeTwoColumn\(rendered\)/.test(av));
    check('system design skips the marker-based component too', /!singleColumn && content && content\.includes\('CODE_COMPONENT_START'\)/.test(av));
    check('coding still reaches _maybeTwoColumn', /_maybeTwoColumn\(html\)/.test(av) && /includes\('<pre'\)/.test(av));

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
