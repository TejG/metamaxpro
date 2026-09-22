#!/usr/bin/env node
/**
 * Regression test for the system-design architecture diagram pipeline.
 *
 * Covers the "diagrams never render in the UI" failure modes:
 *  1. mermaid fenced blocks become <div class="mermaid" data-code> placeholders
 *     (incl. ```Mermaid with capital M, which marked emits as language-Mermaid)
 *  2. a stream cut off mid-diagram (unclosed ```mermaid fence) is auto-closed
 *     so a partial diagram still renders instead of vanishing
 *  3. base64 round-trip preserves the diagram source exactly
 *  4. the line sanitizers repair real-world model output (subgraph & names,
 *     dotted/thick arrows, unquoted labels with special chars)
 *  5. end-to-end: sample system-design answer -> fence close -> marked ->
 *     placeholders -> decode, for both closed and truncated diagrams
 *  6. router wires recommendedGenerationSettings for the system_design
 *     profile (temperature 0.15) instead of the 0.4 conversational default
 *
 * Run: node scripts/test-mermaid-render.js
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

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

// --- load the shared module (UMD, no DOM needed) ---
const MF = require(path.join(ROOT, 'src', 'utils', 'mermaidFormat.js'));

// --- load the vendored marked exactly as the renderer does ---
function loadMarked() {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'assets', 'marked-4.3.0.min.js'), 'utf8');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return sandbox.marked;
}
const marked = loadMarked();

const DIAGRAM = [
    'flowchart LR',
    '    subgraph Ingress',
    '        Client["Client Devices"] --> CDN["Cloudflare CDN"]',
    '        CDN --> LB["Load Balancer"]',
    '    end',
    '    subgraph Storage',
    '        LB --> Cache[("Redis Cache")]',
    '        Cache --> DB[("Postgres Primary")]',
    '    end',
].join('\n');

console.log('\n1. mermaidBlocksToDivs');
check('converts marked mermaid output to a .mermaid placeholder', () => {
    const html = marked.parse('## Diagram\n```mermaid\n' + DIAGRAM + '\n```\n');
    const out = MF.mermaidBlocksToDivs(html);
    assert(out.includes('class="mermaid"'), 'no .mermaid div produced');
    assert(!out.includes('<pre><code class="language-mermaid">'), 'raw pre block leaked through');
});
check('round-trips the diagram source exactly', () => {
    const html = marked.parse('```mermaid\n' + DIAGRAM + '\n```');
    const out = MF.mermaidBlocksToDivs(html);
    const m = out.match(/data-code="([^"]+)"/);
    assert(m, 'no data-code payload');
    assert(MF.decodeDiagram(m[1]).trim() === DIAGRAM, 'diagram source changed in round-trip');
});
check('handles ```Mermaid with capital M', () => {
    const html = marked.parse('```Mermaid\n' + DIAGRAM + '\n```');
    assert(/language-[Mm]ermaid/.test(html), 'marked did not emit a mermaid class: ' + html.slice(0, 80));
    const out = MF.mermaidBlocksToDivs(html);
    assert(out.includes('class="mermaid"'), 'capital-M fence not converted');
});
check('leaves non-mermaid code blocks alone', () => {
    const html = marked.parse('```python\nprint("hi")\n```');
    const out = MF.mermaidBlocksToDivs(html);
    assert(!out.includes('class="mermaid"'), 'python block wrongly converted');
    assert(out.includes('language-python'), 'python block altered');
});

console.log('\n2. closeUnclosedMermaidFence');
check('auto-closes a truncated mermaid diagram', () => {
    const truncated = 'Some prose\n```mermaid\nflowchart LR\n    A --> B';
    const fixed = MF.closeUnclosedMermaidFence(truncated);
    assert(fixed.endsWith('\n```'), 'fence not closed');
    const html = marked.parse(fixed);
    assert(html.includes('language-mermaid'), 'closed fence did not become a code block');
});
check('leaves closed fences untouched', () => {
    const closed = '```mermaid\n' + DIAGRAM + '\n```\nDone.';
    assert(MF.closeUnclosedMermaidFence(closed) === closed, 'closed fence was modified');
});
check('leaves unclosed non-mermaid fences untouched', () => {
    const open = '```python\nprint("hi")';
    assert(MF.closeUnclosedMermaidFence(open) === open, 'non-mermaid fence was modified');
});
check('leaves fence-free text untouched', () => {
    const text = 'Just a normal answer.';
    assert(MF.closeUnclosedMermaidFence(text) === text, 'plain text was modified');
});

console.log('\n3. sanitizeMermaidCode');
function sanitize(diagram) {
    const encoded = Buffer.from(diagram, 'utf8').toString('base64');
    return MF.sanitizeMermaidCode(encoded);
}
check('cleans subgraph names with & and special chars', () => {
    const out = sanitize('flowchart LR\n    subgraph Data & Async\n        A --> B\n    end');
    assert(out.includes('subgraph Data and Async'), 'subgraph not cleaned: ' + out.split('\n')[1]);
});
check('normalizes dotted and thick arrows to -->', () => {
    const out = sanitize('flowchart LR\n    A -.-> B\n    B ==> C');
    assert(!out.includes('-.->') && !out.includes('==>'), 'arrows not normalized: ' + out);
    assert((out.match(/-->/g) || []).length === 2, 'expected 2 solid arrows');
});
check('quotes unquoted labels containing parens', () => {
    const out = sanitize('flowchart LR\n    A[Redis (cache)] --> B');
    assert(out.includes('["Redis (cache)"]'), 'label not quoted: ' + out);
});
check('keeps valid diagrams intact', () => {
    const out = sanitize(DIAGRAM);
    assert(out.includes('flowchart LR'), 'diagram header lost');
    assert(out.includes('Client["Client Devices"]'), 'valid label altered');
    assert(out.includes('Cache[("Redis Cache")]'), 'db shape altered');
});
check('does not merge multiple quoted labels on one line', () => {
    // Regression: the nested-quote fixers were greedy (.+) and fused two
    // labels on the same line into one, e.g.
    //   A["x"] --> B["y"]  became  A["x --> By"]
    const out = sanitize('flowchart LR\n    A["Web Tier"] --> B["App Tier"] --> C[("DB")]');
    assert(out.includes('A["Web Tier"]'), 'first label fused: ' + out.split('\n')[1]);
    assert(out.includes('B["App Tier"]'), 'second label fused: ' + out.split('\n')[1]);
    assert(out.includes('C[("DB")]'), 'db label fused: ' + out.split('\n')[1]);
});

console.log('\n4. end-to-end render pipeline');
function pipeline(markdown) {
    const normalized = MF.closeUnclosedMermaidFence(markdown);
    const html = marked.parse(normalized);
    const converted = MF.mermaidBlocksToDivs(html);
    const m = converted.match(/data-code="([^"]+)"/);
    assert(m, 'pipeline produced no .mermaid placeholder');
    return MF.sanitizeMermaidCode(m[1]);
}
check('closed diagram survives the full pipeline', () => {
    const code = pipeline('## Architecture\n```mermaid\n' + DIAGRAM + '\n```\nThat is the design.');
    assert(code.startsWith('flowchart LR'), 'diagram source broken: ' + code.slice(0, 40));
});
check('truncated diagram still yields renderable source', () => {
    const code = pipeline('## Architecture\n```mermaid\nflowchart LR\n    Client["Web"] --> LB["ALB"]\n    LB --> Svc["API');
    assert(code.startsWith('flowchart LR'), 'truncated diagram lost: ' + code.slice(0, 40));
});

console.log('\n5. prompt + router wiring');
check('system_design prompt demands a closed, compact diagram', () => {
    const prompts = require(path.join(ROOT, 'src', 'utils', 'prompts.js'));
    const sd = prompts.profilePrompts.system_design;
    assert(sd.includes('DIAGRAM PRIORITY'), 'diagram-priority block missing');
    assert(/unclosed/i.test(sd), 'no unclosed-fence warning in prompt');
    assert(sd.includes('```mermaid'), 'prompt has no mermaid fence example');
});
check('recommendedGenerationSettings has a cool temperature for system_design', () => {
    const prompts = require(path.join(ROOT, 'src', 'utils', 'prompts.js'));
    const s = prompts.recommendedGenerationSettings.system_design;
    assert(s && s.temperature <= 0.2, 'system_design temperature not cool: ' + JSON.stringify(s));
});
check('router applies profile settings instead of the 0.4 default', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'utils', 'llm', 'router.js'), 'utf8');
    assert(src.includes('recommendedGenerationSettings'), 'router does not import recommendedGenerationSettings');
    assert(src.includes('isSystemDesign'), 'router has no system_design branch');
    assert(/HARD_BUDGET_MS = longAnswer \? 60000 : 30000/.test(src), 'system_design missing the extended stream budget');
});

console.log(failures === 0 ? '\nAll mermaid render tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
