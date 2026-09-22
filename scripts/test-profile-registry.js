// Tests the shared profile registry (src/components/profiles.js).
//
// The profile list used to be copy-pasted into six UI locations, which drifted:
// Coding Interview and System Design had working prompts and appeared in the
// start dropdown, but the Profile tab, answer window and history list had never
// heard of them. These checks assert there is exactly one list, that every UI
// site reads from it, and that every profile offered has a real prompt behind it.
//
// Run: node scripts/test-profile-registry.js
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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

// Profiles offered in the UI that have no prompt of their own and silently fall
// back to job_interview. Pre-existing gap, tracked here so it stays visible:
// either give 'exam' a prompt in profilePrompts or drop it from PROFILES.
const KNOWN_MISSING_PROMPT = ['exam'];

(async () => {
    const registry = await import('file://' + path.join(ROOT, 'src/components/profiles.js'));
    const { PROFILES, PROFILE_LABELS, getProfileLabel } = registry;
    const prompts = require(path.join(ROOT, 'src/utils/prompts.js'));

    console.log('— the registry itself —');
    check('exports an ordered PROFILES list', Array.isArray(PROFILES) && PROFILES.length > 0);
    check(
        'every entry has a value and a label',
        PROFILES.every(p => p.value && p.label)
    );
    check('no duplicate values', new Set(PROFILES.map(p => p.value)).size === PROFILES.length);
    check('PROFILE_LABELS matches PROFILES', Object.keys(PROFILE_LABELS).length === PROFILES.length);
    check('getProfileLabel resolves a known value', getProfileLabel('coding') === 'Coding Interview');
    check('getProfileLabel degrades safely', getProfileLabel(undefined) === 'Session');

    console.log('— the modes this app is for are all present —');
    for (const v of ['interview', 'behavioral', 'coding', 'system_design', 'case', 'sales', 'meeting', 'presentation', 'negotiation', 'assistant']) {
        check(
            `offers ${v}`,
            PROFILES.some(p => p.value === v)
        );
    }

    console.log('— every offered profile has a prompt behind it —');
    for (const p of PROFILES) {
        if (KNOWN_MISSING_PROMPT.includes(p.value)) continue;
        const sys = prompts.getSystemPrompt(p.value, '', 'standard');
        const fellBack = p.value !== 'interview' && sys.includes('MODE: GENERAL JOB INTERVIEW');
        check(`${p.value} resolves to its own prompt`, !fellBack, 'silently fell back to job_interview');
    }
    for (const v of KNOWN_MISSING_PROMPT) {
        const listed = PROFILES.some(p => p.value === v);
        const hasPrompt = Object.prototype.hasOwnProperty.call(prompts.profilePrompts, v);
        check(
            `${v} is still a known gap (no prompt, falls back)`,
            listed && !hasPrompt,
            hasPrompt ? 'it has a prompt now — remove it from KNOWN_MISSING_PROMPT' : ''
        );
    }

    console.log('— no profile prompt is unreachable from the UI —');
    const aliases = { job_interview: 'interview' };
    for (const key of Object.keys(prompts.profilePrompts)) {
        const uiValue = aliases[key] || key;
        check(
            `${key} is selectable in the UI`,
            PROFILES.some(p => p.value === uiValue),
            `no PROFILES entry for '${uiValue}'`
        );
    }

    console.log('— every UI site reads from the registry, not its own copy —');
    const sites = {
        'components/views/MainView.js': 'PROFILES',
        'components/views/AICustomizeView.js': 'PROFILES',
        'components/views/AssistantView.js': 'PROFILE_LABELS',
        'components/views/HistoryView.js': 'PROFILE_LABELS',
        'components/app/MetaMaxProApp.js': 'getProfileLabel',
    };
    for (const [rel, symbol] of Object.entries(sites)) {
        const src = read(path.join('src', rel));
        check(`${path.basename(rel)} imports ${symbol}`, new RegExp(`import \\{[^}]*${symbol}[^}]*\\} from '\\.\\./profiles\\.js'`).test(src));
        check(`${path.basename(rel)} has no inlined profile list`, !/'Sales Call'/.test(src), 'still hardcodes labels');
    }

    console.log('— dead duplicate helpers are gone —');
    check('CustomizeView.getProfiles() removed', !/getProfiles\(\)/.test(read('src/components/views/CustomizeView.js')));
    check('AICustomizeView._getProfileName() removed', !/_getProfileName/.test(read('src/components/views/AICustomizeView.js')));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
