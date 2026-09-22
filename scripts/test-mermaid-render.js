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
 *  4. the ESM line sanitizers repair real-world model output (smart quotes,
 *     <br>, edge labels, subgraph & names, dotted/thick arrows, nested quotes)
 *  5. mermaidFallbacks() yields progressively simpler renderable variants
 *  6. end-to-end: sample system-design answer -> fence close -> marked ->
 *     placeholders -> decode -> sanitize, for closed and truncated diagrams
 *  7. prompt + router wiring: system_design profile uses the cool temperature
 *     and the extended stream budget; the prompt is spoken, streamlined, and
 *     demands a complete closed diagram
 *  8. diagram spacing: mermaid init carries flowchart spacing config and the
 *     view CSS pads labels so text doesn't crowd box edges
 *
 * Run: node scripts/test-mermaid-render.js
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { pathToFileURL } = require('url');

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

// --- load the vendored marked exactly as the renderer does ---
function loadMarked() {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'assets', 'marked-4.3.0.min.js'), 'utf8');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return sandbox.marked;
}

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

async function main() {
    // ESM pipeline module (the single mermaid pipeline used by the renderer).
    const M = await import(pathToFileURL(path.join(ROOT, 'src', 'components', 'mermaid.js')).href);
    const marked = loadMarked();

    console.log('\n1. mermaidBlocksToDivs');
    check('converts marked mermaid output to a .mermaid placeholder', () => {
        const html = marked.parse('## Diagram\n```mermaid\n' + DIAGRAM + '\n```\n');
        const out = M.mermaidBlocksToDivs(html);
        assert(out.includes('class="mermaid"'), 'no .mermaid div produced');
        assert(!out.includes('<pre><code class="language-mermaid">'), 'raw pre block leaked through');
    });
    check('round-trips the diagram source exactly', () => {
        const html = marked.parse('```mermaid\n' + DIAGRAM + '\n```');
        const out = M.mermaidBlocksToDivs(html);
        const m = out.match(/data-code="([^"]+)"/);
        assert(m, 'no data-code payload');
        assert(M.decodeDiagram(m[1]).trim() === DIAGRAM, 'diagram source changed in round-trip');
    });
    check('handles ```Mermaid with capital M', () => {
        const html = marked.parse('```Mermaid\n' + DIAGRAM + '\n```');
        assert(/language-[Mm]ermaid/.test(html), 'marked did not emit a mermaid class: ' + html.slice(0, 80));
        const out = M.mermaidBlocksToDivs(html);
        assert(out.includes('class="mermaid"'), 'capital-M fence not converted');
    });
    check('leaves non-mermaid code blocks alone', () => {
        const html = marked.parse('```python\nprint("hi")\n```');
        const out = M.mermaidBlocksToDivs(html);
        assert(!out.includes('class="mermaid"'), 'python block wrongly converted');
        assert(out.includes('language-python'), 'python block altered');
    });

    console.log('\n2. closeUnclosedMermaidFence');
    check('auto-closes a truncated mermaid diagram', () => {
        const truncated = 'Some prose\n```mermaid\nflowchart LR\n    A --> B';
        const fixed = M.closeUnclosedMermaidFence(truncated);
        assert(fixed.endsWith('\n```'), 'fence not closed');
        const html = marked.parse(fixed);
        assert(html.includes('language-mermaid'), 'closed fence did not become a code block');
    });
    check('leaves closed fences untouched', () => {
        const closed = '```mermaid\n' + DIAGRAM + '\n```\nDone.';
        assert(M.closeUnclosedMermaidFence(closed) === closed, 'closed fence was modified');
    });
    check('leaves unclosed non-mermaid fences untouched', () => {
        const open = '```python\nprint("hi")';
        assert(M.closeUnclosedMermaidFence(open) === open, 'non-mermaid fence was modified');
    });
    check('leaves fence-free text untouched', () => {
        const text = 'Just a normal answer.';
        assert(M.closeUnclosedMermaidFence(text) === text, 'plain text was modified');
    });

    console.log('\n3. sanitizeMermaid (ESM repair path used by the render loop)');
    check('cleans subgraph names with & and special chars', () => {
        const out = M.sanitizeMermaid('flowchart LR\n    subgraph Data & Async\n        A --> B\n    end');
        assert(out.includes('subgraph Data and Async'), 'subgraph not cleaned: ' + out.split('\n')[1]);
    });
    check('normalizes dotted and thick arrows to -->', () => {
        const out = M.sanitizeMermaid('flowchart LR\n    A -.-> B\n    B ==> C');
        assert(!out.includes('-.->') && !out.includes('==>'), 'arrows not normalized: ' + out);
        assert((out.match(/-->/g) || []).length === 2, 'expected 2 solid arrows');
    });
    check('fixes smart quotes inside labels', () => {
        const out = M.sanitizeMermaid('flowchart LR\n    A[“Web Tier”] --> B');
        assert(out.includes('A["Web Tier"]'), 'smart quotes not fixed: ' + out.split('\n')[1]);
    });
    check('drops edge labels that break parsing', () => {
        const out = M.sanitizeMermaid('flowchart LR\n    A -->|writes, async| B');
        assert(!out.includes('|writes'), 'edge label not dropped: ' + out.split('\n')[1]);
        assert(out.includes('A --> B'), 'edge broken: ' + out.split('\n')[1]);
    });
    check('keeps valid diagrams intact', () => {
        const out = M.sanitizeMermaid(DIAGRAM);
        assert(out.includes('flowchart LR'), 'diagram header lost');
        assert(out.includes('Client["Client Devices"]'), 'valid label altered');
        assert(out.includes('Cache[("Redis Cache")]'), 'db shape altered');
    });
    check('does not merge multiple quoted labels on one line', () => {
        // Regression: the nested-quote fixers were greedy (.+) and fused two
        // labels on the same line into one, e.g.
        //   A["x"] --> B["y"]  became  A["x --> By"]
        const out = M.sanitizeMermaid('flowchart LR\n    A["Web Tier"] --> B["App Tier"] --> C[("DB")]');
        assert(out.includes('A["Web Tier"]'), 'first label fused: ' + out.split('\n')[1]);
        assert(out.includes('B["App Tier"]'), 'second label fused: ' + out.split('\n')[1]);
        assert(out.includes('C[("DB")]'), 'db label fused: ' + out.split('\n')[1]);
    });

    console.log('\n4. mermaidFallbacks');
    check('produces simpler variants that drop subgraphs but keep edges', () => {
        const fallbacks = M.mermaidFallbacks(DIAGRAM);
        assert(fallbacks.length >= 1, 'no fallbacks produced');
        assert(!/subgraph/i.test(fallbacks[0]), 'first fallback still has subgraphs');
        assert(/-->/.test(fallbacks[0]), 'first fallback lost the edges');
    });
    check('never inherits a non-header first line', () => {
        const fallbacks = M.mermaidFallbacks('not a diagram at all');
        assert(fallbacks.every(f => /^flowchart LR/.test(f.trim())), 'fallback missing header: ' + JSON.stringify(fallbacks));
    });

    console.log('\n5. end-to-end render pipeline');
    function pipeline(markdown) {
        const normalized = M.closeUnclosedMermaidFence(markdown);
        const html = marked.parse(normalized);
        const converted = M.mermaidBlocksToDivs(html);
        const m = converted.match(/data-code="([^"]+)"/);
        assert(m, 'pipeline produced no .mermaid placeholder');
        return M.sanitizeMermaid(M.decodeDiagram(m[1]));
    }
    check('closed diagram survives the full pipeline', () => {
        const code = pipeline('## Architecture\n```mermaid\n' + DIAGRAM + '\n```\nThat is the design.');
        assert(code.startsWith('flowchart LR'), 'diagram source broken: ' + code.slice(0, 40));
    });
    check('truncated diagram still yields renderable source', () => {
        const code = pipeline('## Architecture\n```mermaid\nflowchart LR\n    Client["Web"] --> LB["ALB"]\n    LB --> Svc["API');
        assert(code.startsWith('flowchart LR'), 'truncated diagram lost: ' + code.slice(0, 40));
    });
    check('a doubled header is collapsed so every candidate has exactly one', () => {
        // Regression: the model sometimes emits "flowchart LR" twice; the real
        // parser rejects that with "Parse error on line 2". ensureDiagramHeader
        // must collapse the repeat on every candidate the renderer tries.
        const raw = 'flowchart LR\nflowchart LR\n    Client["Web"] --> LB["ALB"]\n    LB --> Svc["API"]';
        const code = M.ensureDiagramHeader(M.sanitizeMermaid(raw));
        const candidates = [code, M.toCanonicalFlowchart(raw), ...M.mermaidFallbacks(code)].filter(Boolean);
        assert(candidates.length > 0, 'no candidates produced');
        for (const c of candidates) {
            const headers = c.split('\n').filter(l => /^(flowchart|graph)\b/i.test(l.trim()));
            assert(headers.length === 1, 'candidate kept a doubled header:\n' + c);
        }
    });

    console.log('\n6. prompt + router wiring');
    check('system_design prompt demands a complete closed diagram, spoken', () => {
        const prompts = require(path.join(ROOT, 'src', 'utils', 'prompts.js'));
        const sd = prompts.profilePrompts.system_design;
        assert(/never\s*\n?leave the fence unclosed/i.test(sd), 'no unclosed-fence warning in prompt');
        assert(/highest-priority output/.test(sd), 'diagram-priority block missing');
        assert(/Speak, don't write/.test(sd), 'spoken-language rules missing');
        assert(!/PHASE DETECTION/.test(sd), 'old 4-phase machinery still present');
        assert(!/SAY THIS/.test(sd), 'old report-style SAY THIS template still present');
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

    console.log('\n7. diagram spacing');
    check('mermaid init carries flowchart spacing config', () => {
        const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
        assert(/nodeSpacing:\s*\d+/.test(html), 'nodeSpacing missing from mermaid.initialize');
        assert(/rankSpacing:\s*\d+/.test(html), 'rankSpacing missing from mermaid.initialize');
        assert(/htmlLabels:\s*true/.test(html), 'htmlLabels missing from mermaid.initialize');
    });
    check('view CSS pads labels so text clears the box edges', () => {
        const css = fs.readFileSync(path.join(ROOT, 'src', 'components', 'views', 'AssistantView.js'), 'utf8');
        assert(/\.mermaid svg \.label[\s\S]{0,400}?padding:\s*10px 16px/.test(css), 'label padding missing from mermaid CSS');
    });
    check('no UMD duplicate pipeline remains', () => {
        assert(!fs.existsSync(path.join(ROOT, 'src', 'utils', 'mermaidFormat.js')), 'deleted UMD module still exists');
        const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
        assert(!/mermaidFormat/.test(html), 'index.html still loads the UMD module');
        const view = fs.readFileSync(path.join(ROOT, 'src', 'components', 'views', 'AssistantView.js'), 'utf8');
        assert(!/window\.MermaidFormat/.test(view), 'AssistantView still references window.MermaidFormat');
    });

    console.log(failures === 0 ? '\nAll mermaid render tests passed.' : `\n${failures} test(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('Test harness error:', err);
    process.exit(1);
});
