// Mermaid source repair, extracted from AssistantView so it can be unit tested.
//
// Models emit Mermaid that is *nearly* valid — an unquoted label containing a
// slash, a dotted arrow, an ampersand in a subgraph name. One bad line makes
// mermaid.render() throw and the whole architecture diagram disappears, so we
// repair the common cases before rendering rather than show nothing.
//
// This lived inside a setTimeout in a 1700-line Lit component and could not be
// tested. It shipped a bug for exactly that reason: the label-quote rules used
// a greedy `.+`, so on a line with TWO quoted labels —
//     Client["Client Devices"] --> CDN["Cloudflare CDN"]
// the match spanned both of them and the "fix" produced
//     Client["Client Devices] --> CDN[Cloudflare CDN"]
// which is invalid. That is the shape the system-design prompt tells the model
// to emit, so every system-design diagram failed to render. The quantifiers are
// lazy now, and scripts/test-mermaid-sanitizer.js covers it.

// Repair one line of Mermaid source. Exported for testing; callers use
// sanitizeMermaid below.
export function sanitizeMermaidLine(line) {
    // Smart quotes from the model are the single most common hard failure:
    // A[“Label”] does not parse at all. Normalize before anything else.
    line = line.replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"').replace(/[\u2018\u2019\u201A\u201B]/g, "'");
    // Line breaks inside labels: <br> / <br/> render inconsistently and often
    // break quoting. Flatten to a space.
    line = line.replace(/<br\s*\/?>/gi, ' ');
    // Edge labels (-->|writes to|) are a frequent parse failure when they carry
    // punctuation, and the data flow is narrated in prose anyway. Drop them.
    line = line.replace(/--\s*>\s*\|[^|]*\|/g, '-->');
    line = line.replace(/-\s*-\s*\|[^|]*\|\s*>/g, '-->');
    // Mermaid keywords used as node ids are a hard parse error (`end["End"]`).
    // Rename only when the word is immediately followed by a shape opener, or
    // sits bare on the far side of an arrow — so a plain `end` closing a
    // subgraph is never touched.
    line = line.replace(/\b(end|graph|subgraph|class|style|click|flowchart|default)(?=\s*[[({])/gi, (_, w) => 'n_' + w);
    line = line.replace(/(-->\s*)(end|graph|subgraph|class|style|click|flowchart|default)(\s*)$/gi, (_, a, w, t) => a + 'n_' + w + t);
    // Subgraph names must be plain words — mermaid rejects '&' and punctuation.
    line = line.replace(/^(\s*subgraph\s+)(.*)$/g, (_, prefix, name) => {
        const clean = name.replace(/&/g, 'and').replace(/[^a-zA-Z0-9 _-]/g, '');
        return prefix + clean.trim();
    });
    // Normalize arrow styles we don't theme for: -.-> and ==> become -->.
    line = line.replace(/\s*-\..*?\.?->\s*/g, ' --> ');
    line = line.replace(/\s*==+>\s*/g, ' --> ');
    // Quote an UNquoted bracket label containing characters mermaid chokes on.
    // Safe across multiple labels on one line: [^\]"] cannot cross a ']', so
    // each match stays inside its own bracket pair.
    line = line.replace(/\[([^\]"]*[\/\(\):&;][^\]"]*)\]/g, (_, l) => `["${l}"]`);
    // Collapse nested quotes inside an already-quoted label. LAZY — a greedy
    // quantifier here spans two labels and destroys both (see header note).
    line = line.replace(/\["(.+?)"\]/g, (_, l) => `["${l.replace(/"/g, '')}"]`);
    // Same for round (database) shapes: [("Name")] and ("Name").
    line = line.replace(/\("(.+?)"\)/g, (_, l) => `("${l.replace(/"/g, '')}")`);
    // Quote participant names containing punctuation (sequence diagrams).
    line = line.replace(/^(\s*participant\s+)([^"\n]*[\/\(\)\.][^"\n]*)$/g, (_, p, name) => `${p}"${name.trim()}"`);
    return line;
}

// Diagram types mermaid recognizes on the first line. Without one it refuses
// the whole document with "No diagram type detected matching given
// configuration for text" — the most common way a model's diagram vanishes: it
// emits the edges and forgets the header line.
const DIAGRAM_TYPE =
    /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|sankey|xychart|block|architecture)\b/i;

// Zero-width / invisible characters the model sometimes emits — notably a
// U+200B zero-width space before the header. String.trim() does NOT remove
// them, so they defeat the DIAGRAM_TYPE check above: the header goes
// unrecognized, a second header gets prepended, and the parser dies on
// line 2 with what looks exactly like "flowchart LR". Strip them before
// anything else touches the text.
const INVISIBLE_CHARS = /[\u200B-\u200D\u2060\u180E\uFEFF]/g;
export function stripInvisibleChars(s) {
    return String(s || '').replace(INVISIBLE_CHARS, '');
}

// Is there any graph structure here at all? Distinguishes a header-less diagram
// (fixable) from prose the model dropped into a mermaid fence (nothing to draw).
export function looksLikeGraph(text) {
    const t = String(text || '');
    return /-->|==>|-\.->|\bsubgraph\b/.test(t);
}

// Ensure the document starts with a diagram-type line. Everything this app asks
// for is a flowchart, so a header-less but clearly graph-shaped body gets one
// instead of being thrown away.
export function ensureDiagramHeader(code) {
    const src = String(code || '').trim();
    if (!src) return src;
    const lines = src.split('\n');
    const first = (lines[0] || '').trim();
    if (DIAGRAM_TYPE.test(first)) {
        // `flowchart` / `graph` with no direction renders inconsistently.
        if (/^(flowchart|graph)$/i.test(first)) lines[0] = 'flowchart LR';
        // The model sometimes emits the header twice (the "first line is
        // exactly: flowchart LR" rule plus copying the example). A second bare
        // header line is a hard parse error ("Parse error on line 2"), so drop
        // any repeat of it — there is no legitimate bare header mid-diagram.
        const rest = lines.slice(1).filter(l => !/^(flowchart|graph)(\s+[A-Za-z]+)?\s*$/i.test(l.trim()));
        return [lines[0], ...rest].join('\n');
    }
    if (!looksLikeGraph(src)) return src; // prose in a fence; nothing to draw
    return ['flowchart LR', ...lines.map(l => '    ' + l.trim())].join('\n');
}

// Repair a full Mermaid document.
export function sanitizeMermaid(raw) {
    return (
        stripInvisibleChars(raw)
            .replace(/```\s*"?\s*$/, '') // stray closing fence the model left in
            .trim()
            .split('\n')
            // Styling directives routinely reference classes the model never
            // defined, which fails the whole parse for zero visual gain.
            .filter(l => !/^\s*(style|classDef|linkStyle|class)\s/.test(l))
            .map(sanitizeMermaidLine)
            .join('\n')
    );
}

// Progressively simpler versions of a diagram, to try in order when the full
// one fails to parse. One malformed line used to mean NO diagram at all; a
// plainer diagram communicates far more than an error message does.
export function mermaidFallbacks(code) {
    const src = ensureDiagramHeader(String(code || ''));
    const firstLine = (src.split('\n')[0] || '').trim();
    // Never let a fallback inherit a non-header first line — that recreates
    // the very "No diagram type detected" failure we are recovering from.
    const hasHeader = DIAGRAM_TYPE.test(firstLine);
    const header = hasHeader ? firstLine : 'flowchart LR';
    const body = hasHeader ? src.split('\n').slice(1) : src.split('\n');

    // 1. Drop grouping — unbalanced or oddly-named subgraphs are a common break.
    const noSubgraphs = [header, ...body.filter(l => !/^\s*(subgraph\b|end\s*$)/.test(l))].join('\n');

    // 2. Keep only edges and reduce every node to the plain rectangle shape,
    //    which is the most permissive thing mermaid accepts.
    const edgesOnly = [
        header,
        ...body
            .filter(l => l.includes('-->'))
            .map(l =>
                l
                    .replace(/\[\(\s*"?([^"\)\]]*)"?\s*\)\]/g, (_, t) => `["${t.trim()}"]`)
                    .replace(/\{\{?\s*"?([^"}]*)"?\s*\}?\}/g, (_, t) => `["${t.trim()}"]`)
                    .replace(/\(\(\s*"?([^"\)]*)"?\s*\)\)/g, (_, t) => `["${t.trim()}"]`)
                    .replace(/\(\s*"?([^"\)]*)"?\s*\)/g, (_, t) => `["${t.trim()}"]`)
            ),
    ].join('\n');

    return [noSubgraphs, edgesOnly].filter(v => v.trim() !== header && v !== src);
}

// ── Canonical rebuild (the reliable path) ───────────────────────────
//
// Repairing arbitrary Mermaid is whack-a-mole: every fix reveals another shape
// the model emits that the parser rejects, and one bad line loses the whole
// diagram. So instead of trying to make the model's syntax legal, we extract
// only the MEANING — node ids, labels, edges, groups — with tolerant regexes
// and re-emit Mermaid in a canonical form we generate ourselves. Nothing from
// the model's syntax survives into the output, so there is nothing left for the
// parser to choke on.

const RESERVED = new Set(['end', 'graph', 'subgraph', 'class', 'style', 'click', 'flowchart', 'default', 'direction']);

// Any arrow style, with or without an inline |label|.
const ARROW = /\s*(?:-\.[^>]*?->|[-=]{2,}>|-{3,}|--)\s*(?:\|[^|]*\|\s*)?/;

export function safeId(raw) {
    let id = String(raw || '')
        .trim()
        .replace(/[^A-Za-z0-9_]/g, '_')
        .replace(/^_+/, '');
    if (!id) return null;
    if (!/^[A-Za-z]/.test(id)) id = 'n' + id;
    if (RESERVED.has(id.toLowerCase())) id = 'n_' + id;
    return id.slice(0, 40);
}

export function safeLabel(raw, fallback) {
    let label = String(raw == null ? '' : raw)
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]*>/g, ' ') // stray HTML the model added
        .replace(/[\u201C\u201D\u2018\u2019"'`]/g, '') // every quote form
        .replace(/[#<>{}[\]|]/g, ' ') // characters mermaid treats structurally
        .replace(/\s+/g, ' ')
        .trim();
    if (!label)
        label = String(fallback || '')
            .replace(/_/g, ' ')
            .trim();
    return label.slice(0, 48) || 'Node';
}

// Pull an id and a display label out of one side of an edge, whatever shape the
// model wrapped it in: A["x"], A[(x)], A((x)), A{x}, A{{x}}, A([x]), A[[x]], A.
function parseNodeToken(token) {
    const t = String(token || '').trim();
    if (!t || ARROW.test(t + ' ')) return null;
    const m = t.match(/^([^[({\s]+)\s*([[({].*)?$/);
    if (!m) return null;
    const id = safeId(m[1]);
    if (!id) return null;
    let inner = (m[2] || '').trim();
    inner = inner.replace(/^[[({]+/, '').replace(/[\])}]+$/, '');
    return { id, label: safeLabel(inner, m[1]) };
}

// Rebuild a diagram as canonical Mermaid. Returns '' when there is no graph to
// draw, so callers can stay silent rather than show an error.
export function toCanonicalFlowchart(raw) {
    const text = stripInvisibleChars(raw).replace(/```[a-z]*\s*$/i, '');
    const nodes = new Map(); // id -> label
    const edges = [];
    const seenEdge = new Set();
    const groups = [];
    let current = null;

    const addNode = n => {
        if (!n) return null;
        // First label wins unless it was only derived from the id.
        if (!nodes.has(n.id) || nodes.get(n.id) === n.id.replace(/_/g, ' ')) nodes.set(n.id, n.label);
        if (current) current.members.add(n.id);
        return n.id;
    };

    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        if (/^(flowchart|graph)\b/i.test(line)) continue;
        if (/^(style|classDef|linkStyle|class|click|direction)\b/i.test(line)) continue;

        const sub = line.match(/^subgraph\s+(.*)$/i);
        if (sub) {
            const name =
                safeId(
                    sub[1]
                        .replace(/["'\[\]()]/g, '')
                        .split(/\s+/)
                        .join('_')
                ) || 'Group';
            current = { name, title: safeLabel(sub[1], name), members: new Set() };
            groups.push(current);
            continue;
        }
        if (/^end$/i.test(line)) {
            current = null;
            continue;
        }

        if (ARROW.test(line)) {
            const parts = line.split(ARROW).filter(p => p && p.trim());
            const ids = parts.map(p => addNode(parseNodeToken(p))).filter(Boolean);
            for (let i = 0; i < ids.length - 1; i++) {
                const key = ids[i] + '>' + ids[i + 1];
                if (ids[i] !== ids[i + 1] && !seenEdge.has(key)) {
                    seenEdge.add(key);
                    edges.push([ids[i], ids[i + 1]]);
                }
            }
        } else {
            // A standalone node declaration, e.g. Cache[("Redis")]
            if (/[[({]/.test(line)) addNode(parseNodeToken(line));
        }
    }

    if (!nodes.size || !edges.length) return '';

    const out = ['flowchart LR'];
    const grouped = new Set();
    for (const g of groups) {
        const members = [...g.members].filter(id => nodes.has(id) && !grouped.has(id));
        if (!members.length) continue;
        out.push(`    subgraph ${g.name}["${g.title}"]`);
        for (const id of members) {
            out.push(`        ${id}["${nodes.get(id)}"]`);
            grouped.add(id);
        }
        out.push('    end');
    }
    for (const [id, label] of nodes) {
        if (!grouped.has(id)) out.push(`    ${id}["${label}"]`);
    }
    for (const [a, b] of edges) out.push(`    ${a} --> ${b}`);
    return out.join('\n');
}

// ── Render-pipeline helpers ─────────────────────────────────────────────
//
// The model answers in markdown; the renderer needs DOM placeholders. These
// two string functions bridge that gap. Pure functions, no DOM — unit tested
// in scripts/test-mermaid-render.js.

function decodeEntities(code) {
    return String(code)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"');
}

export function encodeDiagram(code) {
    return btoa(unescape(encodeURIComponent(String(code || ''))));
}

export function decodeDiagram(encoded) {
    return decodeURIComponent(escape(atob(String(encoded || ''))));
}

// Convert marked's <pre><code class="language-mermaid"> blocks into
// <div class="mermaid" data-code="base64"> placeholders that the debounced
// renderer in AssistantView picks up. Case-insensitive so ```Mermaid /
// ```MERMAID fences work too.
export function mermaidBlocksToDivs(html, prose) {
    // `prose` is the answer's narration. It rides along on the element so that a
    // spec which will not parse can still be rebuilt from the explanation rather
    // than leaving a grey apology where the architecture should be — see
    // _rebuildFromProse in AssistantView. Without it that whole recovery path is
    // dead code, which is exactly what happened when this helper was extracted.
    const proseAttr = prose ? ' data-prose="' + encodeDiagram(prose) + '"' : '';
    return String(html || '').replace(
        /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/gi,
        (_, code) => '<div class="mermaid" data-code="' + encodeDiagram(decodeEntities(code)) + '"' + proseAttr + '></div>'
    );
}

// If streaming was cut off mid-diagram the ```mermaid fence never closes;
// marked then swallows the whole block as a paragraph and no diagram
// renders. Auto-close a trailing UNCLOSED mermaid fence so a partial
// diagram still renders (it re-renders as more chunks arrive). Leaves
// already-closed fences and non-mermaid fences untouched.
export function closeUnclosedMermaidFence(markdown) {
    const content = String(markdown || '');
    if (content.indexOf('```') === -1) return content;
    const opens = content.match(/```/g).length;
    if (opens % 2 === 0) return content; // all fences closed
    const lastFence = content.lastIndexOf('```');
    const after = content.slice(lastFence + 3);
    if (/^\s*mermaid\b/i.test(after)) return content + '\n```';
    return content;
}
