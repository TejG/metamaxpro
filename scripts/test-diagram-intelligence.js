// Tests the prose → diagram generator (src/components/diagramIntelligence.js).
//
// The contract under test is mostly a SAFETY contract: never invent an edge the
// text did not state, never label a reconstruction as the exact source diagram,
// never throw, and never emit Mermaid that the renderer will reject — a spec
// that fails to parse costs the whole diagram, which is the failure mode
// scripts/test-mermaid-sanitizer.js exists to prevent on the repair side.
//
// Run: node scripts/test-diagram-intelligence.js
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
// The diagram gate is tested against the real system_design prompt, so the two
// cannot drift apart.
const prompts = require(path.join(__dirname, '..', 'src/utils/prompts.js'));
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

const HANDSHAKE =
    'The client sends a SYN to the server, the server replies with SYN-ACK to the client, and then the client sends an ACK to the server.';
const PIPELINE =
    'First the request hits the load balancer, then the API gateway authenticates it, next the service writes to Postgres, and finally the response is cached.';
const MACHINE = 'The task starts from idle to ready, then moves from ready to running, and from running to blocked when it waits on I/O.';
const PROSE = 'Distributed systems are interesting and require careful thought about tradeoffs.';
// A phase 4 walkthrough in the shape the system_design prompt asks for: numbered
// write and read paths naming each component.
const PHASE4 = [
    'Write path: 1. The client sends the post to the API gateway.',
    '2. The gateway authenticates it and forwards it to the write service.',
    '3. The write service commits to the DB primary and publishes to the Kafka topic.',
    '4. The worker fleet reads from the Kafka topic and writes to the object store.',
    'Read path: 1. The client hits the CDN. 2. The CDN calls the API gateway.',
    '3. The gateway routes to the read service, which queries the Redis cache and falls back to the read replica.',
].join(' ');

// Every label must be inside a balanced ["..."] pair with nothing structural in
// it — the same invariant the sanitizer test enforces on repaired diagrams.
function labelsIntact(src) {
    const quotes = (src.match(/"/g) || []).length;
    if (quotes % 2 !== 0) return false;
    const labels = src.match(/\["([^"]*)"\]/g) || [];
    if (labels.some(l => /[#<>|[\]{}]/.test(l.slice(2, -2)))) return false;
    return !src.replace(/\["[^"]*"\]/g, '').includes('"');
}

(async () => {
    const {
        detectDiagramCandidate,
        validateMermaid,
        generateSequence,
        generateFlowchart,
        generateState,
        generateArchitecture,
        generateDiagram,
        diagramProse,
    } = await import('file://' + path.join(ROOT, 'src/components/diagramIntelligence.js'));
    const { toCanonicalFlowchart, sanitizeMermaid } = await import('file://' + path.join(ROOT, 'src/components/mermaid.js'));

    console.log('— detection picks the right diagram kind —');
    check('a protocol exchange is a sequence', detectDiagramCandidate(HANDSHAKE).kind === 'sequence', detectDiagramCandidate(HANDSHAKE).kind);
    check('an ordered pipeline is a flowchart', detectDiagramCandidate(PIPELINE).kind === 'flowchart', detectDiagramCandidate(PIPELINE).kind);
    check('a state machine is a state diagram', detectDiagramCandidate(MACHINE).kind === 'state', detectDiagramCandidate(MACHINE).kind);
    check('plain prose is not diagram-worthy', detectDiagramCandidate(PROSE).kind === 'none', detectDiagramCandidate(PROSE).reason);
    check('a fragment is not diagram-worthy', detectDiagramCandidate('hi there').kind === 'none');
    check('confidence rises with the cue count', detectDiagramCandidate(HANDSHAKE).confidence > detectDiagramCandidate('the next step').confidence);
    check('confidence never exceeds 1', detectDiagramCandidate(HANDSHAKE + PIPELINE + MACHINE).confidence <= 1);

    // REGRESSION: the cue regexes had no /g/ flag, so String.match returned
    // [fullMatch, group1] and every score was 2 whenever it matched at all. With
    // all three tied, the tie-break sent every diagram down the sequence path —
    // this pipeline, which has no actors to extract, produced nothing at all.
    console.log('— cue scores are real counts, not the group-array length —');
    check('scores differentiate kinds', detectDiagramCandidate(PIPELINE).reason !== detectDiagramCandidate(MACHINE).reason);
    check(
        'the score is the cue count',
        /cues:flowchart=[3-9]/.test(detectDiagramCandidate(PIPELINE).reason),
        detectDiagramCandidate(PIPELINE).reason
    );
    check('a flow-heavy text does not fall through to sequence', generateDiagram({ text: PIPELINE }).kind === 'flowchart');
    check('a flow-heavy text still yields a diagram', generateDiagram({ text: PIPELINE }).mermaid !== '');

    console.log('— sequence diagrams —');
    const seq = generateSequence(HANDSHAKE);
    check('extracts the three-way handshake', seq.steps === 3, `steps=${seq.steps}`);
    check('starts with the sequenceDiagram header', seq.mermaid.startsWith('sequenceDiagram'));
    check('declares its participants', /participant Client/.test(seq.mermaid) && /participant Server/.test(seq.mermaid));
    check(
        'every participant is declared before use',
        seq.mermaid
            .split('\n')
            .filter(l => /->>/.test(l))
            .every(l => {
                const [from, to] = l.trim().split('->>');
                return seq.mermaid.includes(`participant ${from.trim()}`) && seq.mermaid.includes(`participant ${to.split(':')[0].trim()}`);
            })
    );
    check('uses arrow messages', (seq.mermaid.match(/->>/g) || []).length === 3);
    check('keeps the SYN/SYN-ACK/ACK names', /SYN/.test(seq.mermaid) && /ACK/.test(seq.mermaid));
    check('the canonical handshake fallback fires on a bare mention', generateSequence('This covers the SYN, SYN-ACK and ACK exchange.').steps === 3);
    check('no messages means no spec', generateSequence('The client is idle.').mermaid === '');
    check('message labels carry no colon', !seq.mermaid.split('\n').some(l => (l.match(/:/g) || []).length > 1));

    console.log('— flowcharts —');
    const flow = generateFlowchart(PIPELINE);
    check('extracts the ordered phases', flow.steps === 4, `steps=${flow.steps}`);
    check('starts with the flowchart header', flow.mermaid.startsWith('flowchart TD'));
    check('chains every phase', (flow.mermaid.match(/-->/g) || []).length === flow.steps - 1);
    check('declares a node per phase', (flow.mermaid.match(/^\s+N\d+\[/gm) || []).length === flow.steps);
    check('one phase is not a diagram', generateFlowchart('then the request arrives').mermaid === '');

    // REGRESSION: an over-long fragment used to be filtered out, which welded
    // its two neighbours into an edge the text never stated. Truncate, never drop.
    const longPhase = 'First ' + 'a'.repeat(200) + ' then the second thing happens finally the third thing happens';
    const longFlow = generateFlowchart(longPhase);
    check('an over-long phase is truncated, not dropped', longFlow.steps === 3, `steps=${longFlow.steps}`);
    check('no edge is fabricated across a dropped phase', (longFlow.mermaid.match(/-->/g) || []).length === longFlow.steps - 1);

    console.log('— state diagrams —');
    const st = generateState(MACHINE);
    check('extracts the transitions', st.steps === 3, `steps=${st.steps}`);
    check('starts with the stateDiagram header', st.mermaid.startsWith('stateDiagram-v2'));
    check('deduplicates repeated transitions', generateState('from idle to ready, from idle to ready').steps === 1);
    check('drops self-transitions', generateState('from idle to idle').mermaid === '');
    check('no transitions means no spec', generateState('The system has several states.').mermaid === '');

    console.log('— generated specs are well-formed —');
    for (const [name, spec] of [
        ['sequence', seq],
        ['flowchart', flow],
        ['state', st],
    ]) {
        check(`${name} passes validation`, validateMermaid(spec.mermaid).valid, validateMermaid(spec.mermaid).reason);
        check(`${name} labels are intact`, labelsIntact(spec.mermaid));
        check(`${name} brackets are balanced`, (spec.mermaid.match(/[[({]/g) || []).length === (spec.mermaid.match(/[\])}]/g) || []).length);
        check(`${name} has an ascii fallback`, spec.ascii.trim() !== '');
    }
    check('the repair pass leaves a generated flowchart alone', sanitizeMermaid(flow.mermaid) === flow.mermaid);
    check('a generated flowchart survives the canonical rebuild', toCanonicalFlowchart(flow.mermaid) !== '');

    console.log('— validation rejects what the renderer would reject —');
    check('empty is invalid', !validateMermaid('').valid);
    check('a missing header is invalid', validateMermaid('A --> B').reason === 'unknown_header');
    check('a bare flowchart keyword is invalid', validateMermaid('flowchart\nA --> B').reason === 'unknown_header');
    check('unbalanced brackets are invalid', validateMermaid('flowchart TD\n A["x" --> B').reason === 'unbalanced_brackets');
    check('a flowchart with no edges is invalid', validateMermaid('flowchart TD\n A["x"]').reason === 'no_edges');
    check('a sequence with no messages is invalid', validateMermaid('sequenceDiagram\n participant A').reason === 'no_messages');
    check('a state diagram with no transitions is invalid', validateMermaid('stateDiagram-v2\n Idle').reason === 'no_transitions');
    check('a valid spec is accepted', validateMermaid('flowchart LR\n A["x"] --> B["y"]').valid);

    console.log('— it never invents structure —');
    const cuesOnly = generateDiagram({ text: 'The protocol involves a client and a server and a handshake message.' });
    check('cues without steps yield no spec', cuesOnly.mermaid === '');
    check('cues without steps say why', /not inventing edges/.test(cuesOnly.notes), cuesOnly.notes);
    check('cues without steps keep the detected kind', cuesOnly.kind !== 'none');
    check('prose yields nothing at all', generateDiagram({ text: PROSE }).kind === 'none');
    check(
        'every node in the output traces to the input',
        flow.mermaid
            .split('\n')
            .filter(l => /N\d+\["/.test(l))
            .every(l => {
                const label = l.match(/\["([^"]*)"\]/)[1];
                return PIPELINE.toLowerCase().includes(label.slice(0, 12).toLowerCase());
            })
    );

    console.log('— provenance labels never overclaim —');
    const recon = generateDiagram({ text: HANDSHAKE });
    const exact = generateDiagram({ text: HANDSHAKE, fromSourceVisual: true });
    check('a reconstruction is labeled as one', recon.confidenceLabel === 'ai_reconstructed_diagram', recon.confidenceLabel);
    check('a reconstruction says so in its notes', /not copied from a source visual/.test(recon.notes));
    check('only a source visual is called exact', exact.confidenceLabel === 'exact_source_diagram');
    check(
        'nothing else is ever called exact',
        [HANDSHAKE, PIPELINE, MACHINE, PROSE].every(t => generateDiagram({ text: t }).confidenceLabel !== 'exact_source_diagram')
    );
    check('the source span is recorded for provenance', recon.sourceSpan.length > 0 && HANDSHAKE.startsWith(recon.sourceSpan.slice(0, 40)));
    check('the source span is bounded', generateDiagram({ text: 'a '.repeat(500) }).sourceSpan.length <= 200);
    check(
        'a failed validation falls back to ascii',
        (() => {
            const d = generateDiagram({ text: HANDSHAKE });
            return d.valid ? d.mermaid !== '' : d.mermaid === '' && d.ascii !== '';
        })()
    );

    console.log('— it never throws —');
    const HOSTILE = [
        undefined,
        null,
        '',
        '   ',
        0,
        42,
        [],
        {},
        { text: null },
        { text: 42 },
        { text: '```mermaid' },
        { text: '"\'<>|#{}[]()' },
        { text: '→ ↓ 你好 🙂 from идle to rеady' },
        { text: 'SYN '.repeat(400) },
        { text: 'then '.repeat(400) },
        { text: 'from a to b '.repeat(200) },
    ];
    let threw = null;
    for (const h of HOSTILE) {
        try {
            const out = generateDiagram(h && h.text !== undefined ? h : { text: h });
            if (!out || typeof out.kind !== 'string' || typeof out.mermaid !== 'string' || typeof out.ascii !== 'string')
                threw = `bad shape for ${JSON.stringify(h)}`;
            if (out.mermaid && !validateMermaid(out.mermaid).valid) threw = `emitted invalid mermaid for ${JSON.stringify(h)}`;
        } catch (e) {
            threw = `${JSON.stringify(h)} → ${e.message}`;
            break;
        }
    }
    check('hostile and empty inputs are survivable', threw === null, threw || '');
    check(
        'the bare generators tolerate junk',
        (() => {
            try {
                [generateSequence, generateFlowchart, generateState].forEach(f => [undefined, null, '', 42, {}].forEach(v => f(v)));
                return true;
            } catch {
                return false;
            }
        })()
    );

    // The gaps in SEND_RE are bounded ({0,80}) precisely so a long sentence with
    // no period cannot drive quadratic backtracking.
    const t0 = Date.now();
    generateDiagram({ text: 'the client sends a request ' + 'and waits '.repeat(2000) + 'to the server' });
    const elapsed = Date.now() - t0;
    check('a long punctuation-free sentence does not stall', elapsed < 1000, `${elapsed}ms`);

    console.log('— step caps hold —');
    check('sequence steps are capped', generateSequence('the client sends a request to the server. '.repeat(40)).steps <= 12);
    check('state transitions are capped', generateState(Array.from({ length: 40 }, (_, i) => `from s${i}x to s${i}y`).join(', ')).steps <= 12);
    check('flowchart phases are capped', generateFlowchart('then something happens here '.repeat(40)).steps <= 8);

    console.log('— the module fits the codebase —');
    const src = fs.readFileSync(path.join(ROOT, 'src/components/diagramIntelligence.js'), 'utf8');
    check('it reuses the shared id/label sanitizers', /import \{ safeId, safeLabel \} from '\.\/mermaid\.js'/.test(src));
    check('it does not duplicate a label sanitizer', !/function safeLabel/.test(src));
    const mer = fs.readFileSync(path.join(ROOT, 'src/components/mermaid.js'), 'utf8');
    check('mermaid.js exports them', /export function safeId/.test(mer) && /export function safeLabel/.test(mer));
    check('the cue regexes are global', (src.match(/_CUES =\s*$|_CUES =/g) || []).length === 3 && (src.match(/\/gi;/g) || []).length >= 3);

    console.log('— architecture rebuilt from a phase 4 walkthrough —');
    const arch = generateArchitecture(PHASE4);
    const archSrc = arch.mermaid;
    check('emits a left-to-right flowchart', archSrc.startsWith('flowchart LR'), archSrc.split('\n')[0]);
    check('finds the whole request path', arch.steps >= 9, `edges=${arch.steps}`);
    check('passes validation', validateMermaid(archSrc).valid, validateMermaid(archSrc).reason);
    check('labels are intact', labelsIntact(archSrc));
    // Each of these was a separate extraction bug: an acronym role (CDN), an
    // acronym-qualified role (API gateway), a direct object with no "to"
    // (queries the Redis cache), and a verb doubling as a modifier (the WRITE
    // service commits...), which used to drop its whole clause.
    for (const label of [
        'Client',
        'API Gateway',
        'Write Service',
        'DB Primary',
        'Kafka Topic',
        'Worker Fleet',
        'Object Store',
        'CDN',
        'Read Service',
        'Redis Cache',
        'Read Replica',
    ]) {
        check(`draws "${label}"`, archSrc.includes(`["${label}"]`), archSrc);
    }
    check('an article is never part of a label', !/\["(The|A|An) /.test(archSrc), archSrc);
    check('a preposition is never part of a label', !/\["(From|To|With|Into) /.test(archSrc), archSrc);
    check('node ids are case-insensitive', !/\n\s+[A-Z]\w*\["/.test(archSrc), archSrc);
    check('"the gateway" merges into "the API gateway"', (archSrc.match(/\["API Gateway"\]/g) || []).length === 1 && !/\["Gateway"\]/.test(archSrc));
    check('read and write services stay separate', /\["Read Service"\]/.test(archSrc) && /\["Write Service"\]/.test(archSrc));
    check('an elided subject attaches to the previous component', /read_service --> redis_cache/.test(archSrc), archSrc);
    check('"reads FROM x" points at the reader', /kafka_topic --> worker_fleet/.test(archSrc), archSrc);
    check('and not the other way', !/worker_fleet --> kafka_topic/.test(archSrc));
    check(
        'every node drawn has an edge',
        archSrc
            .split('\n')
            .filter(l => /^\s+\w+\["/.test(l))
            .every(l => {
                const id = l.trim().split('[')[0];
                return new RegExp(`(^|\\s)${id} -->|--> ${id}$`, 'm').test(archSrc);
            }),
        archSrc
    );
    check(
        'edges are deduplicated',
        (() => {
            const e = archSrc
                .split('\n')
                .filter(l => l.includes('-->'))
                .map(l => l.trim());
            return new Set(e).size === e.length;
        })()
    );
    check('there is an ascii rendering of the same graph', arch.ascii.split('\n').length === arch.steps);
    check('the facade reaches it via prefer', generateDiagram({ text: PHASE4, prefer: 'architecture' }).mermaid === archSrc);
    check('prefer cannot force a diagram out of prose', generateDiagram({ text: PROSE, prefer: 'architecture' }).mermaid === '');
    check(
        'prefer is still labeled a reconstruction',
        generateDiagram({ text: PHASE4, prefer: 'architecture' }).confidenceLabel === 'ai_reconstructed_diagram'
    );
    check(
        'no architecture in a scoping question',
        generateArchitecture('Are we building the whole product or one feature? What scale are we targeting?').mermaid === ''
    );
    check('the repair pass leaves it alone', sanitizeMermaid(archSrc) === archSrc);

    console.log('— flowchart direction is selectable —');
    check('defaults to top-down', generateFlowchart(PIPELINE).mermaid.startsWith('flowchart TD'));
    check('honours LR', generateFlowchart(PIPELINE, { direction: 'LR' }).mermaid.startsWith('flowchart LR'));
    check(
        'a numbered list is a step list',
        generateFlowchart('1. Scope the problem. 2. Confirm the decisions. 3. Design it. 4. Draw it.').steps === 4
    );
    check('a decimal is not a step marker', !/\["99/.test(generateFlowchart('First we target 99.99% uptime then we shard the database').mermaid));

    console.log('— the system design view wires it up —');
    const av = fs.readFileSync(path.join(ROOT, 'src/components/views/AssistantView.js'), 'utf8');
    check('the view imports the generator', /import \{[^}]*generateDiagram[^}]*\} from '\.\.\/diagramIntelligence\.js'/.test(av));
    check('it asks for an architecture, not a guess', /prefer: 'architecture'/.test(av));
    check('answers carry their prose next to the diagram', /mermaidBlocksToDivs\(rendered, prose\)/.test(av));
    // The attribute itself is emitted by the shared helper, so assert it there
    // too: extracting that helper once already dropped the attribute and left
    // the whole rebuild path as dead code that no test noticed.
    const merSrc = fs.readFileSync(path.join(ROOT, 'src/components/mermaid.js'), 'utf8');
    check('the shared helper emits it', /data-prose="' \+ encodeDiagram\(prose\)/.test(merSrc));
    check('the helper omits it when there is no prose', /const proseAttr = prose \? /.test(merSrc));
    check('the view uses the shared prose extractor', /import \{ generateDiagram, diagramProse \}/.test(av) && !/_diagramProse/.test(av));
    check('only System Design carries it', /const prose = singleColumn \? diagramProse\(content\) : '';/.test(av));
    check('a reconstruction needs diagram intent', /AssistantView\.DIAGRAM_INTENT\.test\(content\)/.test(av));
    check('intent means the phase 4 headings', /WHAT EACH BLOCK DOES\|HOW DATA FLOWS/.test(av));

    // The gate is read straight out of the view and tested against the real
    // prompt, so the two cannot drift. The prompt used to withhold the diagram
    // until a fourth phase; it now asks for one in every answer, as part 2 of
    // four. Either way the rule is the same: the gate must fire for an answer
    // that MEANT to draw an architecture, and for nothing else.
    const intentSrc = av.match(/static DIAGRAM_INTENT = (\/.*\/i);/);
    check('the gate is a findable regex', !!intentSrc);
    if (intentSrc) {
        const INTENT = eval(intentSrc[1]); // eslint-disable-line no-eval
        const prompt = prompts.profilePrompts.system_design;
        check('the prompt still asks for a diagram', /```mermaid/.test(prompt));
        check('the prompt trips the gate', INTENT.test(prompt));
        // Each heading the gate keys on must still exist in the prompt. Rename
        // one and the gate silently stops firing — no error, just no diagram.
        const headings = intentSrc[1]
            .replace(/^\/\\b\(|\)\\b\/i$/g, '')
            .split('|')
            .map(h => h.replace(/\\/g, ''));
        check('the gate keys on at least two headings', headings.length >= 2, headings.join(' / '));
        for (const h of headings) check(`the prompt still says "${h}"`, prompt.includes(h), h);
        check(
            'a scoping-only answer draws nothing',
            !INTENT.test("I'll assume ten million daily users and a read-heavy workload - stop me if that's off. What consistency do you need?")
        );
        check('ordinary prose draws nothing', !INTENT.test(PROSE));
        check("another profile's answer draws nothing", !INTENT.test(prompts.profilePrompts.behavioral));
    }
    check("it never overwrites the model's own fence", /!\/class="mermaid"\/\.test\(rendered\) &&/.test(av));
    check('the rebuild is the LAST render variant', av.indexOf('...mermaidFallbacks(code), rebuilt') > 0);
    check('a drawn rebuild is labeled', /data-reconstructed/.test(av) && /_diagramNoteHtml/.test(av));
    check('the label names it a rebuild', /Rebuilt from the explanation above/.test(av));
    check('ascii shows when every variant fails', /this\._asciiDiagramHtml\(el\) \|\|\s*`<div class="mermaid-error">Diagram unavailable/.test(av));
    check(
        'ascii shows when the engine never loaded',
        /this\._asciiDiagramHtml\(el\) \|\|\s*`<div class="mermaid-error">Diagram engine failed/.test(av)
    );
    check('ascii is html-escaped', /replace\(\/<\/g, '&lt;'\)/.test(av));
    check('the ascii block is styled', /\.mermaid-ascii \{/.test(av) && /\.diagram-note \{/.test(av));
    check('the rebuild cannot throw into the render loop', /_rebuildFromProse\(el\) \{[\s\S]{0,400}catch \{/.test(av));

    // End to end over the real pipeline: a markdown answer in the shape the
    // system_design prompt asks for, through prose extraction, to a spec the
    // renderer will accept.
    console.log('— a whole answer becomes a diagram —');
    const ANSWER = [
        '## 1. THE DIAGRAM',
        '',
        '```mermaid',
        'flowchart LR',
        '    this is not valid mermaid at all {{{',
        '```',
        '',
        '## 2. WHAT EACH BLOCK DOES',
        '- **API Gateway**: authenticates every request',
        '- **Write Service**: owns the durable write',
        '',
        '## 3. HOW DATA FLOWS',
        PHASE4,
    ].join('\n');
    const prose = diagramProse(ANSWER);
    check('the broken fence is stripped from the prose', !prose.includes('{{{') && !prose.includes('flowchart LR'));
    check('the narration survives', prose.includes('the API gateway') && prose.includes('Kafka topic'));
    check('markdown markup is gone', !/[#*`|]/.test(prose), prose.slice(0, 80));
    const e2e = generateDiagram({ text: prose, prefer: 'architecture' });
    check('the answer yields a valid diagram', e2e.valid && e2e.mermaid.startsWith('flowchart LR'), e2e.notes);
    check('it is the same graph as the walkthrough', e2e.mermaid === generateArchitecture(PHASE4).mermaid);
    check('it is labeled a reconstruction', e2e.confidenceLabel === 'ai_reconstructed_diagram');
    check(
        'the renderer would accept every variant',
        [e2e.mermaid, toCanonicalFlowchart(e2e.mermaid)].every(v => validateMermaid(v).valid)
    );
    check(
        'an answer with no walkthrough yields nothing',
        generateDiagram({ text: diagramProse('## 1. THE DIAGRAM\n\nSee above.'), prefer: 'architecture' }).mermaid === ''
    );
    check(
        'prose extraction tolerates junk',
        [undefined, null, 0, {}, '```'].every(v => typeof diagramProse(v) === 'string')
    );

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
