// Tests the Mermaid source repair used by the architecture diagram.
//
// Regression guard: the label-quote rules used a greedy `.+`, so a line with
// two quoted labels — the exact shape the system_design prompt mandates —
// had both labels destroyed, mermaid.render() threw, and no diagram rendered.
//
// Run: node scripts/test-mermaid-sanitizer.js
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
let passed = 0,
    failed = 0;
function check(name, cond, extra = '') {
    if (cond) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failed++;
        console.error(`  ✗ ${name}${extra ? '\n      ' + extra : ''}`);
    }
}

// The diagram template is read straight out of the system_design prompt, so the
// prompt and this test can never drift apart.
const prompts = require(path.join(ROOT, 'src/utils/prompts.js'));
const fence = prompts.profilePrompts.system_design.match(/```mermaid\n([\s\S]*?)```/);
if (!fence) {
    console.error('  \u2717 system_design prompt no longer contains a ```mermaid template');
    process.exit(1);
}
const PROMPT_DIAGRAM = fence[1].trimEnd();

// Every quote must still be part of a balanced ["..."] or ("...") label.
function labelsIntact(line) {
    const quotes = (line.match(/"/g) || []).length;
    if (quotes % 2 !== 0) return false;
    const stripped = line
        .replace(/\[\("[^"]*"\)\]/g, '')
        .replace(/\["[^"]*"\]/g, '')
        .replace(/\("[^"]*"\)/g, '');
    return !stripped.includes('"');
}

(async () => {
    const { sanitizeMermaid, sanitizeMermaidLine, mermaidFallbacks, ensureDiagramHeader, looksLikeGraph, toCanonicalFlowchart } = await import(
        'file://' + path.join(ROOT, 'src/components/mermaid.js')
    );

    console.log('— the prompt template survives untouched —');
    const out = sanitizeMermaid(PROMPT_DIAGRAM);
    const inLines = PROMPT_DIAGRAM.split('\n')
        .map(l => l.trim())
        .filter(Boolean);
    const outLines = out
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
    check('same number of lines', inLines.length === outLines.length, `${inLines.length} → ${outLines.length}`);
    const corrupted = outLines.filter(l => !labelsIntact(l));
    check('no line has unbalanced or orphaned quotes', corrupted.length === 0, corrupted.join('\n      '));
    // Derived from the template rather than hardcoded, so this follows the
    // prompt instead of pinning one particular set of node names.
    const multiLabel = PROMPT_DIAGRAM.split('\n').filter(l => (l.match(/"/g) || []).length >= 4);
    check('the template has at least one line carrying two labels', multiLabel.length > 0);
    check(
        'every multi-label line round-trips unchanged',
        multiLabel.every(l => sanitizeMermaidLine(l) === l),
        multiLabel.filter(l => sanitizeMermaidLine(l) !== l).join(' | ')
    );
    const srcLabels = [...PROMPT_DIAGRAM.matchAll(/"([^"]+)"/g)].map(m => m[1]);
    check('the template defines a reasonable number of labels', srcLabels.length >= 6, String(srcLabels.length));
    check(
        'every node label from the template survives',
        srcLabels.every(l => out.includes(`"${l}"`)),
        srcLabels.filter(l => !out.includes(`"${l}"`)).join(', ')
    );

    console.log('— multiple quoted labels on one line (the bug) —');
    for (const line of [
        'Client["Client Devices"] --> CDN["Cloudflare CDN"]',
        'A["One"] --> B["Two"] --> C["Three"]',
        'Cache[("Redis")] --> DB[("Postgres")]',
    ]) {
        const got = sanitizeMermaidLine(line);
        check(`preserved: ${line.slice(0, 44)}`, got === line, `got: ${got}`);
    }

    console.log('— the repairs it is actually supposed to make —');
    check(
        'quotes an unquoted label with a slash',
        sanitizeMermaidLine('A[Read/Write] --> B[Plain]') === 'A["Read/Write"] --> B[Plain]',
        sanitizeMermaidLine('A[Read/Write] --> B[Plain]')
    );
    check(
        'quotes two unquoted special labels independently',
        sanitizeMermaidLine('A[a/b] --> B[c:d]') === 'A["a/b"] --> B["c:d"]',
        sanitizeMermaidLine('A[a/b] --> B[c:d]')
    );
    // Indentation is preserved per-line; only sanitizeMermaid() trims the document.
    check(
        'strips ampersand from subgraph names',
        sanitizeMermaidLine('  subgraph Data & Async') === '  subgraph Data and Async',
        JSON.stringify(sanitizeMermaidLine('  subgraph Data & Async'))
    );
    check('document-level sanitize trims surrounding blank space', sanitizeMermaid('\n  flowchart LR\n  A --> B\n ') === 'flowchart LR\n  A --> B');
    check(
        'normalizes dotted arrows and keeps labels',
        sanitizeMermaidLine('A["A"] -.-> B["B"]') === 'A["A"] --> B["B"]',
        sanitizeMermaidLine('A["A"] -.-> B["B"]')
    );
    check('normalizes thick arrows', sanitizeMermaidLine('A["A"] ==> B["B"]') === 'A["A"] --> B["B"]', sanitizeMermaidLine('A["A"] ==> B["B"]'));
    check(
        'collapses genuinely nested quotes',
        sanitizeMermaidLine('A["say "hi" now"]') === 'A["say hi now"]',
        sanitizeMermaidLine('A["say "hi" now"]')
    );
    check('drops a stray closing fence', sanitizeMermaid('flowchart LR\n  A --> B\n```') === 'flowchart LR\n  A --> B');
    check('tolerates empty input', sanitizeMermaid('') === '' && sanitizeMermaid(null) === '');

    console.log('— real-world breakages models actually emit —');
    check(
        'smart quotes become straight quotes',
        sanitizeMermaidLine('A[\u201cAPI Gateway\u201d] --> B[\u201cCache\u201d]') === 'A["API Gateway"] --> B["Cache"]',
        sanitizeMermaidLine('A[\u201cAPI Gateway\u201d] --> B[\u201cCache\u201d]')
    );
    check(
        'labelled arrows are stripped',
        sanitizeMermaidLine('A["X"] -->|writes (fast)| B["Y"]') === 'A["X"] --> B["Y"]',
        sanitizeMermaidLine('A["X"] -->|writes (fast)| B["Y"]')
    );
    check(
        '<br/> inside a label is flattened',
        sanitizeMermaidLine('A["Read<br/>Service"] --> B["Y"]') === 'A["Read Service"] --> B["Y"]',
        sanitizeMermaidLine('A["Read<br/>Service"] --> B["Y"]')
    );
    check('style directives are dropped', sanitizeMermaid('flowchart LR\n  A --> B\n  style A fill:#f00') === 'flowchart LR\n  A --> B');
    check('classDef directives are dropped', sanitizeMermaid('flowchart LR\n  A --> B\n  classDef hot fill:#f00') === 'flowchart LR\n  A --> B');
    check(
        'reserved word as a node id is renamed',
        sanitizeMermaidLine('start["Start"] --> end["End"]') === 'start["Start"] --> n_end["End"]',
        sanitizeMermaidLine('start["Start"] --> end["End"]')
    );
    check(
        'bare reserved id after an arrow is renamed',
        sanitizeMermaidLine('A["A"] --> end') === 'A["A"] --> n_end',
        sanitizeMermaidLine('A["A"] --> end')
    );
    check('a subgraph-closing end is NOT renamed', sanitizeMermaid('flowchart LR\n  subgraph S\n    A["X"] --> B["Y"]\n  end').endsWith('\n  end'));

    console.log('— missing diagram-type header (the reported failure) —');
    const hdr = t => ensureDiagramHeader(sanitizeMermaid(t));
    check(
        'a header-less body gets flowchart LR',
        hdr('Client --> CDN\n  CDN --> GW').startsWith('flowchart LR\n'),
        JSON.stringify(hdr('Client --> CDN'))
    );
    check('the edges survive the header being added', hdr('Client --> CDN').includes('Client --> CDN'));
    check('header-less subgraphs are recovered', hdr('subgraph S\n  A["X"] --> B["Y"]\nend').startsWith('flowchart LR'));
    check('an existing header is left alone', hdr('flowchart LR\n  A --> B') === 'flowchart LR\n  A --> B');
    check('graph TD is a valid header and kept', hdr('graph TD\n  A --> B') === 'graph TD\n  A --> B');
    check('bare flowchart gets a direction', hdr('flowchart\n  A --> B').startsWith('flowchart LR'));
    check('prose in a fence is NOT turned into a diagram', hdr('The client calls the CDN.') === 'The client calls the CDN.');
    check('empty input stays empty', hdr('') === '' && hdr('   ') === '');

    console.log('— looksLikeGraph gates what we even try to render —');
    check('arrows count as a graph', looksLikeGraph('A --> B'));
    check('subgraph counts as a graph', looksLikeGraph('subgraph S'));
    check('prose does not', !looksLikeGraph('The client calls the CDN.'));
    check('an empty fence does not', !looksLikeGraph('') && !looksLikeGraph('\n  '));
    check(
        'fallbacks never inherit a non-header first line',
        mermaidFallbacks('Client --> CDN\nCDN --> GW\nsubgraph S\nend').every(v => v.startsWith('flowchart LR')),
        JSON.stringify(mermaidFallbacks('Client --> CDN\nCDN --> GW\nsubgraph S\nend'))
    );

    console.log('— fallback chain for diagrams that still will not parse —');
    const full = 'flowchart LR\n  subgraph S\n    A["X"] --> B[("DB")]\n  end';
    const fb = mermaidFallbacks(sanitizeMermaid(full));
    check('produces at least two simpler variants', fb.length >= 2, String(fb.length));
    check('variant 1 drops the grouping', !/subgraph/.test(fb[0]) && fb[0].includes('A["X"]'), JSON.stringify(fb[0]));
    check('variant 2 reduces shapes to plain rectangles', !/\[\(/.test(fb[1]) && fb[1].includes('B["DB"]'), JSON.stringify(fb[1]));
    check(
        'every variant keeps the flowchart header',
        fb.every(v => v.startsWith('flowchart LR'))
    );
    check(
        'no variants offered when there is nothing to simplify',
        mermaidFallbacks('flowchart LR\n  A --> B').every(v => v !== 'flowchart LR')
    );

    console.log('— canonical rebuild: generated by us, so it cannot fail to parse —');
    const canon = toCanonicalFlowchart;
    const NASTY = {
        'header-less edges': 'Client --> CDN\n CDN --> Gateway',
        'smart quotes': 'flowchart LR\n A[\u201cAPI GW\u201d] --> B[\u201cCache\u201d]',
        'labelled arrows': 'flowchart LR\n A["G"] -->|writes (fast)| B[("DB")]',
        'reserved id': 'flowchart LR\n s["S"] --> end["E"]',
        'unclosed quote': 'flowchart LR\n A["Broken --> B["Y"]',
        'nested shapes': 'flowchart LR\n A[[Sub]] --> B{{Hex}} --> C([Round])',
        'html in label': 'flowchart LR\n A["Read<br/><b>Svc</b>"] --> B["Y"]',
        'pipe and hash': 'flowchart LR\n A["a|b"] --> B["#1 svc"]',
        'numeric ids': 'flowchart LR\n 1["One"] --> 2["Two"]',
        'dots and dashes in ids': 'flowchart LR\n svc.read["Read"] --> db-primary["DB"]',
        'chained arrows': 'flowchart LR\n A["A"] --> B["B"] --> C["C"]',
        'mixed arrows': 'flowchart LR\n A["A"] -.-> B["B"] ==> C["C"] --- D["D"]',
        semicolons: 'flowchart LR;\n A["A"] --> B["B"];',
        'windows newlines': 'flowchart LR\r\n A["A"] --> B["B"]\r\n',
        'subgraph with ampersand': 'flowchart LR\n subgraph Data & Async\n  A["X"] --> B["Y"]\n end',
    };
    // Structural invariants that make a flowchart parseable. Verified against
    // the real mermaid library in Electron; asserted cheaply here.
    for (const [name, raw] of Object.entries(NASTY)) {
        const out = canon(raw);
        const lines = out.split('\n');
        const bad = [];
        if (!out) bad.push('produced nothing');
        if (lines[0] !== 'flowchart LR') bad.push('bad header: ' + JSON.stringify(lines[0]));
        for (const l of lines.slice(1)) {
            const t = l.trim();
            if (!t || t === 'end') continue;
            const isSubgraph = /^subgraph [A-Za-z][A-Za-z0-9_]*\["[^"]*"\]$/.test(t);
            const isNode = /^[A-Za-z][A-Za-z0-9_]*\["[^"]*"\]$/.test(t);
            const isEdge = /^[A-Za-z][A-Za-z0-9_]* --> [A-Za-z][A-Za-z0-9_]*$/.test(t);
            if (!isSubgraph && !isNode && !isEdge) bad.push('unrecognized line: ' + JSON.stringify(t));
        }
        check(`canonical form is well-formed: ${name}`, bad.length === 0, bad.join('; '));
    }

    console.log('— canonical rebuild keeps the meaning —');
    const cc = canon(
        'flowchart LR\n subgraph Storage\n  Read["Read Svc"] -->|hits| Cache[("Redis (hot)")]\n end\n Cache ==> Primary[("DB Primary")]'
    );
    check('keeps every node label', /Read Svc/.test(cc) && /Redis \(hot\)/.test(cc) && /DB Primary/.test(cc), cc);
    check('keeps every edge', /Read --> Cache/.test(cc) && /Cache --> Primary/.test(cc), cc);
    check('keeps the grouping', /subgraph Storage\["Storage"\]/.test(cc), cc);
    check('emits no quote characters inside labels', !/\["[^"]*"[^"\n]*"/.test(cc), cc);
    check('deduplicates repeated edges', (canon('flowchart LR\n A --> B\n A --> B').match(/A --> B/g) || []).length === 1);
    check('drops self-edges', !/A --> A/.test(canon('flowchart LR\n A --> A\n A --> B')));
    check('returns empty for prose', canon('The client calls the CDN.') === '');
    check('returns empty for an empty fence', canon('') === '' && canon('   ') === '');
    check('returns empty when there are nodes but no edges', canon('flowchart LR\n A["Lonely"]') === '');

    console.log('— the renderer uses it, and never dumps raw source —');
    const av = fs.readFileSync(path.join(ROOT, 'src/components/views/AssistantView.js'), 'utf8');
    // The fence-extraction helper lives in the shared module (single mermaid
    // pipeline); AssistantView calls it via mermaidBlocksToDivs.
    const mm = fs.readFileSync(path.join(ROOT, 'src/components/mermaid.js'), 'utf8');
    check('AssistantView imports the shared sanitizer', /import \{[^}]*sanitizeMermaid[^}]*\} from '\.\.\/mermaid\.js'/.test(av));
    check('no inlined copy of the sanitizer remains', !/subgraph\\s\+/.test(av), 'AssistantView still has its own subgraph regex');
    check('diagram failure does not render a code block', !/<pre[^>]*>\$\{code\}<\/pre>/.test(av));
    check('diagram failure shows a readable message instead', /class="mermaid-error"/.test(av));
    check('the error message is styled', /\.mermaid-error \{/.test(av));
    check('renderer tries the fallback variants', /\.\.\.mermaidFallbacks\(code\), rebuilt && rebuilt\.mermaid\]/.test(av));
    check('a missing mermaid library is reported, not silent', /!window\.mermaid && container\.querySelector\('\.mermaid'\)/.test(av));
    check('the failure message names the parse reason', /Diagram unavailable \(\$\{reason\}\)/.test(av));
    check('renderer supplies a missing diagram header', /ensureDiagramHeader\(sanitizeMermaid\(raw\)\)/.test(av));
    // Still skipped — unless the prose rebuild has something to draw, which is
    // the whole point of carrying the narration alongside the fence.
    check(
        'renderer skips non-diagram content instead of erroring',
        /!looksLikeGraph\(code\) && !\(rebuilt && rebuilt\.mermaid\)\) continue;/.test(av)
    );
    check('fence extraction is case-insensitive', /language-mermaid[\s\S]{0,60}\/gi,/.test(mm));
    check('renderer tries the canonical rebuild', /toCanonicalFlowchart\(raw\)/.test(av));
    check('canonical is tried before the crude fallbacks', av.indexOf('toCanonicalFlowchart(raw)') < av.indexOf('...mermaidFallbacks(code)'));
    check('variants are de-duplicated', /new Set\(\[code, toCanonicalFlowchart\(raw\)/.test(av));
    check(
        'the full mermaid message is kept, not just its first line',
        /replace\(\/\\s\+\/g, ' '\)/.test(av) && !/\(e && e\.message\) \|\| 'unknown'\)\.split\('\\n'\)\[0\]/.test(av)
    );
    check('the failing source is logged for diagnosis', /all variants failed\. source was/.test(av));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
