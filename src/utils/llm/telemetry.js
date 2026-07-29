// Per-answer latency telemetry.
// Tracks four pipeline stages for every answer cycle:
//   speechEnd       — VAD detected end of speech, transcription API called
//   transcriptReady — Groq Whisper returned the transcript
//   ttft            — first token received from the LLM provider (Time To First Token)
//   done            — streamer finished, full answer available
//
// Usage:
//   telemetry.mark('speechEnd');
//   telemetry.mark('transcriptReady');
//   telemetry.mark('ttft', 'groq');
//   telemetry.mark('done');     ← logs the summary and saves to the ring buffer
//
// Call telemetry.reset() at the start of each new answer cycle (routeAnswer).
// Read telemetry.getLog() to inspect the last LOG_SIZE entries (e.g. via IPC).

const LOG_SIZE = 50;
const log = [];

let _cycle = null;

function reset() {
    _cycle = { speechEnd: null, transcriptReady: null, ttft: null, done: null, provider: null };
}

function mark(stage, meta = null) {
    if (!_cycle) reset();
    _cycle[stage] = Date.now();
    if (meta) _cycle.provider = meta;

    if (stage === 'done') _flush();
}

function _flush() {
    if (!_cycle) return;

    const { speechEnd, transcriptReady, ttft, done, provider } = _cycle;
    const entry = {
        ts: new Date().toISOString(),
        provider: provider || '?',
        speechToTranscript: transcriptReady && speechEnd ? transcriptReady - speechEnd : null,
        transcriptToTTFT: ttft && transcriptReady ? ttft - transcriptReady : null,
        ttftToDone: done && ttft ? done - ttft : null,
        total: done && speechEnd ? done - speechEnd : done && transcriptReady ? done - transcriptReady : null,
    };

    log.push(entry);
    if (log.length > LOG_SIZE) log.shift();

    const fmt = ms => (ms == null ? '—' : `${ms}ms`);
    console.log(
        `[Telemetry] provider=${entry.provider}` +
            ` speech→transcript=${fmt(entry.speechToTranscript)}` +
            ` transcript→TTFT=${fmt(entry.transcriptToTTFT)}` +
            ` TTFT→done=${fmt(entry.ttftToDone)}` +
            ` total=${fmt(entry.total)}`
    );

    _cycle = null;
}

function getLog() {
    return log.slice();
}

module.exports = { reset, mark, getLog };
