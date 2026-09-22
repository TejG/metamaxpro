// Diagram intelligence — turn a prose explanation into a diagram.
//
// The sibling module ./mermaid.js REPAIRS Mermaid a model already emitted. This
// module covers the opposite case: there is no diagram at all. The answer walks
// through a handshake, a pipeline or a state machine in words, and a picture
// lands faster than the paragraph does.
//
// It reads structure out of the text with tolerant, bounded regexes and emits
// Mermaid we generate ourselves — so, as in toCanonicalFlowchart, nothing from
// the prose survives into the output for the parser to choke on. Every result
// also carries an ASCII rendering, used when the diagram engine is unavailable
// (see the `.mermaid-error` path in AssistantView).
//
// Two rules keep it honest:
//   1. It does not invent edges. When the structure cannot be read out of the
//      text it returns an empty spec with a note, never a plausible guess.
//   2. Anything not copied from a real source visual is labeled
//      'ai_reconstructed_diagram', so the UI can never present a reconstruction
//      as the exact diagram the candidate was shown.
//
// Deterministic, pure, and it never throws — callers render whatever comes back.

import { safeId, safeLabel } from './mermaid.js';

/**
 * @typedef {'sequence'|'flowchart'|'architecture'|'state'|'none'} DiagramKind — 'architecture' emits a flowchart of components
 * @typedef {'exact_source_diagram'|'ai_reconstructed_diagram'|'conceptual_diagram'|'low_confidence_diagram'} DiagramConfidenceLabel
 *
 * @typedef {Object} DiagramCandidate
 * @property {DiagramKind} kind
 * @property {number} confidence 0..1
 * @property {string} reason
 *
 * @typedef {Object} GeneratedDiagram
 * @property {DiagramKind} kind
 * @property {string} mermaid Empty when validation failed — render `ascii` instead.
 * @property {string} ascii
 * @property {boolean} valid
 * @property {DiagramConfidenceLabel} confidenceLabel
 * @property {number} confidence
 * @property {string} sourceSpan The transcript span it was derived from (provenance).
 * @property {string} notes
 */

const clean = t =>
    String(t || '')
        .replace(/\s+/g, ' ')
        .trim();

const cap = s => {
    const t = String(s || '').trim();
    return t ? t[0].toUpperCase() + t.slice(1) : t;
};

// ── Candidate detection ──────────────────────────────────────────────────────
//
// All three are /g/. Without the flag String.match returns [fullMatch, ...groups]
// — length 2 for a single-group pattern no matter how many cues the text really
// contained — so all three scores collapsed to the same number and the tie-break
// handed every diagram to 'sequence'. The groups are non-capturing for the same
// reason: the match count has to be a cue count. `->` sits outside the \b group
// because \b never holds next to '-', which made that cue unreachable.
const SEQUENCE_CUES =
    /(?:\b(?:sends?|replies?|responds?|requests?|returns?|acknowledg\w+|then the|message|SYN|ACK|handshake|client|server|protocol)\b|->)/gi;
const FLOW_CUES = /(?:\b(?:step|phase|first|second|third|next|then|finally|process|pipeline|stage|followed by|leads to)\b|->)/gi;
const STATE_CUES = /\b(?:states?|transitions?|from\s+\w+(?:\s+state)?\s+to|becomes|enters|idle|running|waiting|blocked|ready|terminated)\b/gi;

const countCues = (text, re) => (text.match(re) || []).length;

/** Is this text worth drawing, and as what? @returns {DiagramCandidate} */
export function detectDiagramCandidate(text) {
    try {
        const t = clean(text);
        if (t.length < 12) return { kind: 'none', confidence: 0, reason: 'too_short' };
        const seq = countCues(t, SEQUENCE_CUES);
        const flow = countCues(t, FLOW_CUES);
        const state = countCues(t, STATE_CUES);
        const max = Math.max(seq, flow, state);
        if (max === 0) return { kind: 'none', confidence: 0, reason: 'no_structure_cues' };
        const kind = max === seq ? 'sequence' : max === state ? 'state' : 'flowchart';
        return { kind, confidence: Math.min(1, 0.4 + max * 0.15), reason: `cues:${kind}=${max}` };
    } catch {
        return { kind: 'none', confidence: 0, reason: 'error' };
    }
}

// ── Validation ───────────────────────────────────────────────────────────────
//
// Structural only — there is no Mermaid parser available outside the renderer,
// and the point is to catch a malformed spec BEFORE it reaches mermaid.render()
// and throws away the whole answer's diagram.
const KNOWN_HEADER = /^(sequenceDiagram|flowchart (TD|LR|TB|RL)|graph (TD|LR|TB|RL)|stateDiagram(-v2)?|classDiagram|mindmap)\b/;

/** @returns {{valid: boolean, reason: string}} */
export function validateMermaid(mermaid) {
    try {
        const src = String(mermaid || '').trim();
        if (!src) return { valid: false, reason: 'empty' };
        const header = src.split('\n')[0].trim();
        if (!KNOWN_HEADER.test(header)) return { valid: false, reason: 'unknown_header' };
        const opens = (src.match(/[[({]/g) || []).length;
        const closes = (src.match(/[\])}]/g) || []).length;
        if (opens !== closes) return { valid: false, reason: 'unbalanced_brackets' };
        // A diagram with no edges renders as an empty box — treat it as a failure
        // so the caller falls back to ASCII rather than showing a blank frame.
        if (/^sequenceDiagram/.test(header) && !/->>|-->>/.test(src)) return { valid: false, reason: 'no_messages' };
        if (/^(flowchart|graph)/.test(header) && !/-->|---/.test(src)) return { valid: false, reason: 'no_edges' };
        if (/^stateDiagram/.test(header) && !/-->/.test(src)) return { valid: false, reason: 'no_transitions' };
        return { valid: true, reason: 'ok' };
    } catch {
        return { valid: false, reason: 'error' };
    }
}

// ── Spec generation ──────────────────────────────────────────────────────────

// A message sits after ':' and runs to end of line, so anything structural in
// it breaks the statement.
const messageLabel = raw =>
    String(raw || '')
        .replace(/[:;#<>|"'`]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);

// ── Actor / clause extraction (shared by sequence and architecture) ──────────
//
// The clause is the unit, not the sentence. A single-regex version that walked a
// whole sentence with bounded `[^.]{0,80}?` gaps between actor, verb, payload and
// destination looks tidy but cannot work: matched case-insensitively every
// discriminating class in it collapses — `[A-Z][a-z]+` matches "the",
// `[a-z]{3,}` matches "with" — and "The client sends a SYN to the server" parses
// as `The->>The: SYN`. Splitting into clauses first lets each part be matched
// precisely with case intact, and bounds the backtracking by construction.

// Actor words. The component nouns matter as much as the protocol roles: a
// system-design walkthrough says "publishes to the Kafka topic", not "sends to
// the server".
// prettier-ignore
const ROLES = ['client', 'server', 'sender', 'receiver', 'host', 'node', 'browser', 'user', 'peer', 'proxy',
               'gateway', 'service', 'database', 'cache', 'worker', 'leader', 'follower', 'replica', 'broker', 'api',
               'primary', 'topic', 'queue', 'bucket', 'store', 'index', 'cluster', 'shard', 'balancer', 'cdn',
               'blob', 'table', 'stream', 'fleet', 'consumer', 'producer', 'frontend', 'backend', 'app'];
// A role appears lowercase, Capitalized, or (for acronyms) UPPERCASE — "the CDN"
// is the ordinary way to write it. The generic actor atom `[A-Z][a-z]+` must stay
// case-SENSITIVE, since case is the only thing separating a proper-noun actor
// from an ordinary word, so the two cannot share an /i/ flag.
const ROLE_ALT = ROLES.map(r => `[${r[0].toUpperCase()}${r[0]}]${r.slice(1)}|${r.toUpperCase()}`).join('|');
const ACTOR_ATOM = `(?:${ROLE_ALT}|[A-Z][a-z]+)`;

// An article and up to two modifiers may sit before a component ("the API
// gateway", "the Kafka topic"). The modifier is captured for the LABEL; the
// emitters decide how much of it keys the node.
//
// Modifiers are GREEDY so the longest phrase wins: lazy matching stopped "the
// API gateway" at "API" — an acronym role in its own right — and drew a node
// called API instead of the gateway. Backtracking still finds the short form
// when there is no longer one. A modifier may not be a preposition, or "reads
// from the Kafka topic" yields a component called "From The Kafka".
// Function words are matched case-tolerantly on purpose. A sentence-initial
// "The client" left the capital-T article unconsumed, so it became a MODIFIER
// and the box read "The Client" — a second node for a component already drawn
// as "Client" elsewhere in the same answer.
const caseTolerant = w => `[${w[0].toUpperCase()}${w[0]}]${w.slice(1)}`;
const ARTICLE_ALT = ['the', 'a', 'an', 'its'].map(caseTolerant).join('|');
// prettier-ignore
const PREP_ALT = ['from', 'to', 'with', 'by', 'into', 'onto', 'via', 'at', 'in', 'on', 'for', 'of', 'and', 'then',
                  'but', 'so', 'the', 'a', 'an'].map(caseTolerant).join('|');
const NOT_MODIFIER = `(?!(?:${PREP_ALT})\\b)`;
const QUALIFIED = `(?:(?:${ARTICLE_ALT})\\s+)?((?:${NOT_MODIFIER}[A-Za-z]+\\s+){0,2}(${ACTOR_ATOM}))`;
// The subject is the last qualified phrase before the verb, so "the worker
// fleet" is one component and not merely "Fleet".
const SUBJECT_RE = new RegExp(`\\b${QUALIFIED}\\b`, 'g');
const TO_RE = new RegExp(`\\bto\\s+${QUALIFIED}\\b`, 'g');
// "the worker fleet reads FROM the Kafka topic" — the data flows toward the
// subject, so this edge points the other way. Drawing it forwards is just wrong.
const FROM_RE = new RegExp(`^\\s*from\\s+${QUALIFIED}\\b`);
// A direct object sitting immediately after the verb: "queries the Redis cache".
// The ACTOR constraint is what keeps this from swallowing a payload — in "sends
// the post to the gateway", "post" is not an actor, so only the `to` clause counts.
const OBJECT_RE = new RegExp(`^\\s*${QUALIFIED}\\b`);

// Protocol verbs plus the verbs a request path is actually narrated with.
// prettier-ignore
const VERB_RE =
    /\b(sends?|sent|repl(?:ies|y)|responds?|returns?|requests?|acknowledges?|acks?|transmits?|forwards?|issues?|pushes|emits?|posts?|writes?|reads?|commits?|publishes|persists?|stores?|streams?|queries|fetches|calls?|hits?|routes?|proxies|uploads?|flushes|replicates?|fans? out|falls? back)\b/i;

// Some verbs are also the modifier in a component name: "the WRITE service
// commits to the DB primary" is not a clause about writing. The first verb match
// won there, so the subject became "The" and the whole clause — two real edges —
// was dropped. Only these genuinely ambiguous words get re-examined.
// prettier-ignore
const AMBIGUOUS_VERB = new Set(['write', 'writes', 'read', 'reads', 'store', 'stores', 'stream', 'streams', 'post',
    'posts', 'request', 'requests', 'call', 'calls', 'route', 'routes', 'proxy', 'proxies', 'replicate']);

// A capitalized function word is not an actor, and a function word is not a
// payload. "Write path" and "Read path" are section headings, not components.
// prettier-ignore
const NOT_ACTOR = new Set(['the', 'then', 'this', 'that', 'these', 'those', 'when', 'after', 'before', 'next', 'first',
    'second', 'third', 'finally', 'with', 'and', 'but', 'for', 'if', 'it', 'its', 'as', 'at', 'in', 'on', 'so', 'now',
    'here', 'there', 'each', 'both', 'once', 'while', 'during', 'only', 'also', 'they', 'their', 'them', 'which',
    'because', 'since', 'from', 'to', 'path', 'step', 'phase', 'write', 'read']);
// prettier-ignore
const NOT_MESSAGE = new Set([...NOT_ACTOR, 'back', 'out', 'over', 'into', 'onto', 'using', 'via', 'another', 'some',
    'any', 'more', 'less', 'same', 'other', 'new', 'old']);

const isActor = word => !!word && !NOT_ACTOR.has(String(word).trim().toLowerCase());

/** Every qualified component phrase in a segment, in order. */
const actorsIn = segment => {
    const found = [];
    SUBJECT_RE.lastIndex = 0;
    let m;
    while ((m = SUBJECT_RE.exec(segment)) !== null) {
        if (isActor(m[2])) found.push({ word: m[2], phrase: m[1] });
    }
    return found;
};

// The verb of the clause: the first match that is not really a noun modifier.
const NEXT_ACTOR_RE = new RegExp(`^\\s+(${ACTOR_ATOM})\\b`);
const VERB_ALL_RE = new RegExp(VERB_RE.source, 'gi');
function findVerb(clause) {
    VERB_ALL_RE.lastIndex = 0;
    let m;
    while ((m = VERB_ALL_RE.exec(clause)) !== null) {
        if (AMBIGUOUS_VERB.has(m[0].toLowerCase())) {
            const next = clause.slice(m.index + m[0].length).match(NEXT_ACTOR_RE);
            if (next && isActor(next[1])) continue; // it modifies the noun after it
        }
        return m;
    }
    return null;
}

// The payload is an acronym if one is present (SYN, SYN-ACK, GET) — matched
// case-sensitively, which is the whole point — otherwise the last content word
// before the destination.
const payloadIn = segment => {
    const acronym = segment.match(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*\b/);
    if (acronym && acronym[0].length >= 2) return acronym[0];
    const words = (segment.match(/\b[a-z][a-z-]{2,}\b/g) || []).filter(w => !NOT_MESSAGE.has(w));
    return words.length ? words[words.length - 1] : '';
};

// Capitalize for display without flattening an acronym: "API gateway" reads as
// "API Gateway", never "Api Gateway".
const titleCase = str => String(str || '').replace(/\S+/g, w => (w === w.toUpperCase() ? w : cap(w)));

// A clause whose subject is elided — "…routes to the read service, which queries
// the Redis cache" — inherits the previous clause's destination as its subject.
// Only a bare connector may stand in for the subject, so this never reattaches a
// clause that simply had no actor in it.
const ELIDED_SUBJECT = /^\s*(?:and|then|which|that|it|this|but|so)?\s*$/i;

/**
 * "<actor> <verb> <payload> to <actor>" within one clause.
 * @param {string} clause
 * @param {boolean} hasImplicit Whether a previous destination exists to stand in
 *   for an elided subject.
 * @returns {{from: {word: string, phrase: string}|null, fromImplicit: boolean, msg: string,
 *   dests: Array<{word: string, phrase: string, viaTo: boolean, reversed: boolean}>}|null}
 *   The raw pieces — the sequence and architecture emitters format them differently.
 */
function parseClause(clause, hasImplicit) {
    const verb = findVerb(clause);
    if (!verb) return null;
    const head = clause.slice(0, verb.index);
    const tail = clause.slice(verb.index + verb[0].length);
    // The subject is the actor nearest the verb, not the first in the clause: in
    // "Write path - 1. the client sends ..." the actor is the client.
    const subjects = actorsIn(head);
    const fromImplicit = !subjects.length && !!hasImplicit && ELIDED_SUBJECT.test(head);
    const from = subjects.length ? subjects[subjects.length - 1] : null;
    if (!from && !fromImplicit) return null;

    const dests = [];
    let firstTo = -1;
    TO_RE.lastIndex = 0;
    let m;
    while ((m = TO_RE.exec(tail)) !== null) {
        if (isActor(m[2])) {
            if (firstTo < 0) firstTo = m.index;
            dests.push({ word: m[2], phrase: m[1], viaTo: true, reversed: false });
        }
        if (dests.length >= 4) break;
    }
    const src = tail.match(FROM_RE);
    if (src && isActor(src[2])) {
        dests.unshift({ word: src[2], phrase: src[1], viaTo: false, reversed: true });
    } else {
        const obj = tail.match(OBJECT_RE);
        if (obj && isActor(obj[2])) dests.unshift({ word: obj[2], phrase: obj[1], viaTo: false, reversed: false });
    }
    if (!dests.length) return null;

    // No explicit payload → name the message after the verb rather than drop a
    // step the text clearly stated.
    const msg = messageLabel(payloadIn(firstTo >= 0 ? tail.slice(0, firstTo) : tail) || verb[1].toLowerCase());
    return { from, fromImplicit, msg, dests };
}

// A colon ends a clause too. Without it the glossary section of an answer —
// "API Gateway: authenticates every request" / "Write Service: owns the durable
// write" — ran together into one clause, and "request" was read as its verb with
// "Write Service" as the thing requested. That drew an edge between two blocks
// which the answer never connected.
const clausesOf = text =>
    clean(text)
        .split(/[.;,:]|\bthen\b/i)
        .filter(c => c && c.trim().length >= 6);

/** @returns {{mermaid: string, ascii: string, steps: number}} */
export function generateSequence(text) {
    const t = clean(text);
    const steps = [];
    let lastTo = '';
    for (const clause of clausesOf(t)) {
        const parsed = parseClause(clause, !!lastTo);
        if (!parsed) continue;
        const from = parsed.fromImplicit ? lastTo : safeId(parsed.from.word);
        // A message needs a recipient, so only `to` destinations count here — a
        // direct object is data flowing into a component, not a message sent.
        for (const d of parsed.dests.filter(x => x.viaTo)) {
            const to = safeId(d.word);
            // Repeats are not deduplicated: the same message sent twice is
            // meaningful in a sequence, unlike a duplicate edge in a flowchart.
            if (from && to && parsed.msg) {
                steps.push({ from: cap(from), to: cap(to), msg: parsed.msg });
                lastTo = to;
            }
            if (steps.length >= 12) break;
        }
        if (steps.length >= 12) break;
    }
    // Canonical handshake fallback: the three-way TCP exchange gets named far
    // more often than it gets narrated as "X sends Y to Z".
    if (steps.length === 0 && /\bSYN\b/.test(t) && /\bACK\b/.test(t)) {
        steps.push({ from: 'Client', to: 'Server', msg: 'SYN' });
        steps.push({ from: 'Server', to: 'Client', msg: 'SYN-ACK' });
        steps.push({ from: 'Client', to: 'Server', msg: 'ACK' });
    }
    if (steps.length === 0) return { mermaid: '', ascii: '', steps: 0 };

    const actors = [...new Set(steps.flatMap(s => [s.from, s.to]))];
    const lines = ['sequenceDiagram'];
    for (const a of actors) lines.push(`    participant ${a}`);
    for (const s of steps) lines.push(`    ${s.from}->>${s.to}: ${s.msg}`);
    const ascii = steps.map(s => `${s.from} --${s.msg}--> ${s.to}`).join('\n');
    return { mermaid: lines.join('\n'), ascii, steps: steps.length };
}

// ── Architecture extraction ──────────────────────────────────────────────────
//
// The system-design answer's Phase 4 walkthrough narrates a component path:
// "the client sends the post to the API gateway. The gateway forwards it to the
// write service, which commits to the DB primary and publishes to the Kafka
// topic." That is a graph, not a conversation, so it re-emits the same clause
// parse as boxes and arrows instead of participants and messages.
export function generateArchitecture(text) {
    const nodes = new Map(); // id -> label
    const edges = [];
    const seen = new Set();

    // A component is keyed on its qualified phrase ("write service"), so the read
    // and the write service stay two boxes. A later BARE mention ("the service")
    // merges into the qualified node when exactly one matches — otherwise it
    // would draw a third, disconnected box for something already on the diagram.
    // Ids are keyed case-INSENSITIVELY. The glossary section of an answer writes
    // "Write Service" and the walkthrough writes "write service"; keyed on case
    // those became two boxes for one component, side by side on the diagram.
    const put = (word, phrase) => {
        const qualified = safeId(phrase || word);
        const bare = safeId(word);
        if (!qualified || !bare) return null;
        let id = qualified.toLowerCase();
        if (id === bare.toLowerCase() && !nodes.has(id)) {
            const suffix = '_' + bare.toLowerCase();
            const matches = [...nodes.keys()].filter(k => k.endsWith(suffix));
            if (matches.length === 1) id = matches[0];
        }
        const label = safeLabel(titleCase(phrase || word), word);
        if (!nodes.has(id) || label.length > nodes.get(id).length) nodes.set(id, label);
        return id;
    };

    // The elided subject carries the previous destination's resolved NODE ID, not
    // its word: re-resolving "the service" when both a read and a write service
    // exist is ambiguous, and would draw a third, disconnected box.
    let lastToId = '';
    for (const clause of clausesOf(text)) {
        const parsed = parseClause(clause, !!lastToId);
        if (!parsed) continue;
        const from = parsed.fromImplicit ? lastToId : put(parsed.from.word, parsed.from.phrase);
        if (!from) continue;
        for (const d of parsed.dests) {
            const to = put(d.word, d.phrase);
            if (!to || to === from) continue;
            lastToId = to;
            const [a, b] = d.reversed ? [to, from] : [from, to];
            const key = `${a}>${b}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push([a, b]);
            if (edges.length >= 16) break;
        }
        if (edges.length >= 16) break;
    }
    if (!edges.length) return { mermaid: '', ascii: '', steps: 0 };

    // LR, matching the flowchart the system_design prompt asks the model for — an
    // architecture is wider than it is tall. Only connected nodes are drawn: a
    // box with no arrow on it tells the candidate nothing.
    const drawn = new Set(edges.flat());
    const lines = ['flowchart LR'];
    for (const [id, label] of nodes) {
        if (drawn.has(id)) lines.push(`    ${id}["${label}"]`);
    }
    for (const [a, b] of edges) lines.push(`    ${a} --> ${b}`);
    const ascii = edges.map(([a, b]) => `${nodes.get(a)} --> ${nodes.get(b)}`).join('\n');
    return { mermaid: lines.join('\n'), ascii, steps: edges.length };
}

/**
 * Ordered phases: "first / then / next / finally", "A leads to B", or a numbered
 * list — which is how a walkthrough of a request path is usually written.
 * @param {string} text
 * @param {{direction?: 'TD'|'LR'|'TB'|'RL'}} [opts] LR reads better for an
 *   architecture path, TD for a list of steps.
 */
export function generateFlowchart(text, opts) {
    const direction = (opts && opts.direction) || 'TD';
    const t = clean(text);
    const phases = t
        // `\d+\.\s` needs the trailing space so a decimal ("99.99% uptime")
        // is not read as a step marker.
        .split(/\b(?:first|second|third|then|next|after that|finally|followed by|leads to)\b|->|\b\d+\.\s+/i)
        .map(p =>
            clean(p)
                .replace(/^[,:;-]+/, '')
                // The split markers leave connective debris behind — a phase
                // reading "the response is cached." or "...to Postgres, and".
                .replace(/[,;:.\s]+$/, '')
                .replace(/\s+and$/i, '')
                .replace(/[,;:.\s]+$/, '')
                .trim()
        )
        // Over-long fragments are truncated by safeLabel, not dropped: dropping
        // one welds its neighbours together and asserts an edge the text never
        // stated. A shortened node is honest, a fabricated edge is not.
        .filter(p => p.length >= 4)
        .slice(0, 8);
    if (phases.length < 2) return { mermaid: '', ascii: '', steps: 0 };

    const lines = [`flowchart ${direction}`];
    phases.forEach((p, i) => lines.push(`    N${i}["${safeLabel(p, `Step ${i + 1}`)}"]`));
    for (let i = 0; i < phases.length - 1; i++) lines.push(`    N${i} --> N${i + 1}`);
    // ASCII is never parsed, so it keeps the untruncated phase text.
    const ascii = phases.map((p, i) => `${i + 1}. ${p}`).join('\n  ↓\n');
    return { mermaid: lines.join('\n'), ascii, steps: phases.length };
}

const TRANSITION_RE =
    /\bfrom\s+([A-Za-z]{3,})\s+(?:state\s+)?to\s+([A-Za-z]{3,})\b|\b([A-Za-z]{3,})\s+(?:state\s+)?(?:transitions?|moves?|goes?|changes?)\s+to\s+([A-Za-z]{3,})\b/gi;

/** State machines: "from X to Y", "X transitions to Y". */
export function generateState(text) {
    const t = clean(text);
    const transitions = [];
    const seen = new Set();
    TRANSITION_RE.lastIndex = 0;
    let m;
    while ((m = TRANSITION_RE.exec(t)) !== null) {
        const from = safeId(m[1] || m[3]);
        const to = safeId(m[2] || m[4]);
        const key = `${from}>${to}`;
        if (from && to && from !== to && !seen.has(key)) {
            seen.add(key);
            transitions.push({ from: cap(from), to: cap(to) });
        }
        if (transitions.length >= 12) break;
    }
    if (transitions.length === 0) return { mermaid: '', ascii: '', steps: 0 };

    const lines = ['stateDiagram-v2'];
    for (const tr of transitions) lines.push(`    ${tr.from} --> ${tr.to}`);
    const ascii = transitions.map(tr => `[${tr.from}] --> [${tr.to}]`).join('\n');
    return { mermaid: lines.join('\n'), ascii, steps: transitions.length };
}

/**
 * The narration inside a markdown answer, with the diagram source and the markup
 * taken out — this is what a diagram gets rebuilt from. Fenced blocks go first:
 * the model's own (broken) Mermaid is not prose, and feeding it back in would
 * extract components out of its syntax instead of out of the explanation.
 */
export function diagramProse(content) {
    return String(content || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`]+`/g, ' ')
        .replace(/^\s*[-*+]\s+/gm, ' ')
        .replace(/[#*_>|[\]]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Facade: detect → generate → validate → label.
 * @param {{text: string, fromSourceVisual?: boolean, title?: string,
 *   direction?: 'TD'|'LR'|'TB'|'RL', prefer?: DiagramKind|'auto'}} input
 *   `prefer` forces an extractor instead of trusting detection — the system
 *   design view asks for 'architecture'. It cannot force a diagram out of prose:
 *   detection still has to find structure first.
 *   `fromSourceVisual` is true only when the structure came from an actual
 *   screenshot of a diagram; that is the one case we may call it exact.
 * @returns {GeneratedDiagram}
 */
export function generateDiagram(input) {
    const opts = input || {};
    const sourceSpan = clean(opts.text).slice(0, 200);
    const empty = {
        kind: 'none',
        mermaid: '',
        ascii: '',
        valid: false,
        confidenceLabel: 'low_confidence_diagram',
        confidence: 0,
        sourceSpan,
        notes: 'no diagram-worthy structure detected',
    };
    try {
        const candidate = detectDiagramCandidate(opts.text);
        // Detection still gates everything, including an explicit `prefer`: prose
        // with no structure in it must yield nothing, whatever the caller asked for.
        if (candidate.kind === 'none') return empty;
        const kind = opts.prefer && opts.prefer !== 'auto' ? opts.prefer : candidate.kind;

        const built =
            kind === 'architecture'
                ? generateArchitecture(opts.text)
                : kind === 'sequence'
                  ? generateSequence(opts.text)
                  : kind === 'state'
                    ? generateState(opts.text)
                    : generateFlowchart(opts.text, { direction: opts.direction });

        if (!built.mermaid || built.steps === 0) {
            return { ...empty, kind, notes: 'structure cues present but no extractable steps — not inventing edges' };
        }

        const { valid, reason } = validateMermaid(built.mermaid);

        let confidenceLabel;
        if (opts.fromSourceVisual) confidenceLabel = 'exact_source_diagram';
        else if (candidate.confidence >= 0.7 && built.steps >= 2) confidenceLabel = 'ai_reconstructed_diagram';
        else if (built.steps >= 2) confidenceLabel = 'conceptual_diagram';
        else confidenceLabel = 'low_confidence_diagram';

        const notes = opts.fromSourceVisual
            ? 'Diagram copied/derived from a source visual.'
            : 'AI-reconstructed from the lecture explanation (not copied from a source visual).';

        return {
            kind,
            mermaid: valid ? built.mermaid : '',
            ascii: built.ascii,
            valid,
            confidenceLabel,
            confidence: candidate.confidence,
            sourceSpan,
            notes: valid ? notes : `${notes} (mermaid validation failed: ${reason} — using ASCII fallback)`,
        };
    } catch {
        return empty;
    }
}
