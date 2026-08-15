const { getGroqApiKey } = require('../storage');
const telemetry = require('./llm/telemetry');
const { sendToRenderer } = require('./llm/state');

// Voice Activity Detection parameters
// Lowered default RMS threshold to better detect system audio levels.
const SPEECH_RMS_THRESHOLD = 800; // Was 3000 — lowered to detect quieter system audio
const SILENCE_DURATION_MS = 700;  // Lowered from 1800ms: 700ms still tolerates short mid-sentence
                          // pauses (breathing, "um") but cuts >1s off perceived end-of-speech latency.
const MIN_SPEECH_DURATION_MS = 250; // Quicker response for short utterances
const MAX_BUFFER_DURATION_MS = 45000; // Trigger STT forcefully if they talk for >45s
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

// Rolling-window STT: while speech is active, fire a Groq request every
// ROLLING_WINDOW_MS on the audio-so-far. Any in-flight request is aborted
// when a newer one fires (the older transcript would be stale anyway).
// End-of-speech latency drops from ~1.5s (one full-utterance batch call)
// to ~150-300ms (the last window's transcript is already in hand).
const ROLLING_WINDOW_MS = 1200;
const ROLLING_MIN_BYTES = (300 / 1000) * SAMPLE_RATE * BYTES_PER_SAMPLE; // skip STT below 300ms

let speechBuffer = Buffer.alloc(0);
let isSpeaking = false;
let silenceTimer = null;
let onTranscriptionCallback = null;
let onInterimTranscriptCallback = null; // Fix 3: rolling-window partial transcripts
let isActive = false;
let noiseFloor = 300; // adaptive baseline
let rollingTimer = null;          // setInterval handle for the periodic STT flush
let inflightSttRequest = null;    // AbortController for the in-flight Groq call
// Ceiling for the adaptive noise floor: keeps dynamicThreshold ≤ ~2× the base
// speech threshold, guaranteeing normal speech can always re-trigger the VAD.
const NOISE_FLOOR_MAX = SPEECH_RMS_THRESHOLD;

// Calculate RMS amplitude of a mono 16-bit PCM buffer
function getRms(pcmBuffer) {
    const int16Array = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
    let sum = 0;
    for (let i = 0; i < int16Array.length; i++) {
        sum += int16Array[i] * int16Array[i];
    }
    return Math.sqrt(sum / (int16Array.length || 1));
}

function cancelSilenceTimer() {
    if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
    }
}

// Build a WAV buffer in memory from raw PCM (no file I/O)
function pcmToWavBuffer(pcmBuffer) {
    const channels = 1;
    const bitDepth = 16;
    const byteRate = SAMPLE_RATE * channels * (bitDepth / 8);
    const blockAlign = channels * (bitDepth / 8);
    const dataSize = pcmBuffer.length;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(dataSize + 36, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitDepth, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
}

async function triggerTranscription() {
    cancelSilenceTimer();
    stopRollingWindow();

    if (!onTranscriptionCallback || speechBuffer.length === 0) return;

    const buffer = speechBuffer;
    speechBuffer = Buffer.alloc(0);
    isSpeaking = false;

    const durationMs = (buffer.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000;
    if (durationMs < MIN_SPEECH_DURATION_MS) {
        console.log(`[Whisper VAD] Audio too short (${durationMs.toFixed(0)}ms), skipping`);
        return;
    }

    console.log(`[Whisper VAD] Transcribing ${(durationMs / 1000).toFixed(1)}s of audio...`);
    try { sendToRenderer('update-status', 'Transcribing...'); } catch (_) { /* renderer may be detached */ }

    try {
        telemetry.reset();
        telemetry.mark('speechEnd');

        // Fix 3: prefer the in-flight rolling-window transcript if it's
        // already back — saves a full Groq round-trip at end-of-speech.
        let transcript = await collectInflightTranscript(buffer);

        if (transcript && transcript.trim() !== '') {
            telemetry.mark('transcriptReady');
            console.log(`[Whisper] "${transcript}"`);
            try { sendToRenderer('update-status', 'Listening...'); } catch (_) { /* renderer may be detached */ }
            onTranscriptionCallback(transcript);
        }
    } catch (e) {
        console.error('[Whisper] Transcription error:', e.message);
    }
}

async function transcribeWithGroq(pcmBuffer, { signal } = {}) {
    const apiKey = getGroqApiKey();
    if (!apiKey) throw new Error('No Groq API key configured');

    const wavBuffer = pcmToWavBuffer(pcmBuffer);
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });

    const formData = new FormData();
    formData.append('file', blob, 'audio.wav');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', 'en');
    formData.append('response_format', 'json');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
        signal,
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq Whisper ${response.status}: ${errText.substring(0, 200)}`);
    }

    const json = await response.json();
    return (json.text || '').trim();
}

// ── Fix 3: rolling-window STT ──
//
// While speech is active, kick a Groq request every ROLLING_WINDOW_MS
// against the audio-so-far. The most recent completed response wins —
// older in-flight requests are aborted via AbortController. This gives
// us a transcript that's almost always already in hand the moment
// silence is detected, instead of paying a full Groq round-trip then.
function startRollingWindow() {
    if (rollingTimer) return;
    rollingTimer = setInterval(() => {
        if (!isSpeaking) return;
        if (speechBuffer.length < ROLLING_MIN_BYTES) return;
        // Abort any in-flight request before dispatching a fresh one —
        // the older transcript would be stale by definition.
        if (inflightSttRequest) {
            try { inflightSttRequest.abort(); } catch (_) {}
            inflightSttRequest = null;
        }
        const ac = new AbortController();
        inflightSttRequest = ac;
        // Snapshot the buffer now; speechBuffer continues to grow in
        // processAudioChunk while this request is in flight.
        const snapshot = Buffer.from(speechBuffer);
        transcribeWithGroq(snapshot, { signal: ac.signal })
            .then(text => {
                // Only commit if THIS controller is still the active one
                // (a newer window may have superseded us while in flight).
                if (inflightSttRequest !== ac) return;
                inflightSttRequest = null;
                if (text && text.trim() && onInterimTranscriptCallback) {
                    onInterimTranscriptCallback(text.trim());
                }
            })
            .catch(e => {
                if (e.name !== 'AbortError') {
                    console.warn('[Whisper VAD] rolling-window STT failed:', e.message);
                }
                if (inflightSttRequest === ac) inflightSttRequest = null;
            });
    }, ROLLING_WINDOW_MS);
}

function stopRollingWindow() {
    if (rollingTimer) {
        clearInterval(rollingTimer);
        rollingTimer = null;
    }
    if (inflightSttRequest) {
        try { inflightSttRequest.abort(); } catch (_) {}
        inflightSttRequest = null;
    }
}

// Helper used by triggerTranscription(): wait briefly for any in-flight
// rolling-window request to finish (it has the freshest audio), but if
// it's slow, fall back to a single fresh full-buffer call so we never
// stall the LLM round-trip.
async function collectInflightTranscript(finalBuffer) {
    const ROLLING_WAIT_MS = 250;
    if (inflightSttRequest) {
        const ac = inflightSttRequest;
        try {
            const text = await Promise.race([
                new Promise(resolve => {
                    const tick = () => {
                        if (inflightSttRequest !== ac) resolve(null);
                        else setTimeout(tick, 50);
                    };
                    tick();
                }),
                new Promise(resolve => setTimeout(() => resolve(null), ROLLING_WAIT_MS)),
            ]);
            if (text && text.trim()) return text.trim();
        } catch (_) { /* fall through */ }
    }
    // Either nothing was in-flight, or the in-flight request didn't
    // return in time. Fall back to one batch call on the whole buffer.
    return await transcribeWithGroq(finalBuffer);
}

// Called for each 100ms mono PCM chunk from SystemAudioDump
function processAudioChunk(monoChunk) {
    if (!isActive) return;

    const rms = getRms(monoChunk);

    // Adapt the noise floor when someone is NOT actively speaking.
    // ASYMMETRIC on purpose: drop quickly when the room gets quieter, but rise
    // very slowly when it gets louder. The previous symmetric 0.8/0.2 EMA let
    // ambient/system audio between questions drag the floor up to speech level
    // within seconds — dynamicThreshold then exceeded real speech RMS and the
    // VAD never triggered again after the first question ("listener halts").
    // NOISE_FLOOR_MAX hard-caps the floor so speech can always break through.
    if (!isSpeaking) {
        if (rms < noiseFloor) {
            noiseFloor = noiseFloor * 0.7 + rms * 0.3; // fast decay to quieter ambient
        } else {
            noiseFloor = noiseFloor * 0.98 + rms * 0.02; // very slow rise
        }
        noiseFloor = Math.min(noiseFloor, NOISE_FLOOR_MAX);
    }

    // Dynamic threshold: at least SPEECH_RMS_THRESHOLD, but dynamically scales
    // above ambient room noise (e.g. static/humming). Use a milder multiplier
    // so quieter system audio isn't accidentally treated as silence.
    const dynamicThreshold = Math.max(SPEECH_RMS_THRESHOLD, noiseFloor * 1.8);

    if (process.env.DEBUG_AUDIO) {
        console.log(
            `[Whisper VAD DEBUG] RMS: ${rms.toFixed(0)}, noiseFloor: ${noiseFloor.toFixed(0)}, dynamicThreshold: ${dynamicThreshold.toFixed(0)}`
        );
    }

    if (rms > dynamicThreshold) {
        if (!isSpeaking) {
            isSpeaking = true;
            console.log(`[Whisper VAD] Speech started (RMS: ${rms.toFixed(0)}, Threshold: ${dynamicThreshold.toFixed(0)})`);
            // Surface the VAD trip to the renderer so the status pill
            // reacts the instant we hear something, rather than the
            // user staring at a frozen UI for the whole utterance +
            // STT round trip.
            try { sendToRenderer('update-status', 'Listening...'); } catch (_) { /* renderer may be detached during shutdown */ }
            // Fix 3: start the rolling-window STT timer so a transcript is
            // already in hand by the time silence is detected.
            startRollingWindow();
        }
        cancelSilenceTimer();

        speechBuffer = Buffer.concat([speechBuffer, monoChunk]);

        // Force a transcription trigger if they speak continuously for > MAX_BUFFER_DURATION_MS
        // This prevents capturing forever due to background static noise.
        const maxBytes = (MAX_BUFFER_DURATION_MS / 1000) * SAMPLE_RATE * BYTES_PER_SAMPLE;
        if (speechBuffer.length >= maxBytes) {
            console.log(`[Whisper VAD] Hit max duration (${MAX_BUFFER_DURATION_MS / 1000}s), forcing trigger.`);
            triggerTranscription();
        }
    } else if (isSpeaking) {
        // Silence detected while speech was active — include trailing silence, start countdown
        speechBuffer = Buffer.concat([speechBuffer, monoChunk]);

        if (!silenceTimer) {
            silenceTimer = setTimeout(() => {
                silenceTimer = null;
                triggerTranscription();
            }, SILENCE_DURATION_MS);
        }
    }
}

// Fix 3: accept an options object so callers can register an interim
// transcript callback alongside the final-transcript callback.
//   startWhisperVAD({
//     onFinal: (text) => { ... },   // existing behavior, fires on silence
//     onInterim: (text) => { ... }, // new: fires every ROLLING_WINDOW_MS
//   })
// Back-compat: a bare function is still accepted and treated as onFinal.
function startWhisperVAD(callbackOrOpts) {
    const opts = typeof callbackOrOpts === 'function' ? { onFinal: callbackOrOpts } : (callbackOrOpts || {});
    isActive = true;
    onTranscriptionCallback = typeof opts.onFinal === 'function' ? opts.onFinal : null;
    onInterimTranscriptCallback = typeof opts.onInterim === 'function' ? opts.onInterim : null;
    speechBuffer = Buffer.alloc(0);
    isSpeaking = false;
    cancelSilenceTimer();
    stopRollingWindow();
    console.log('[Whisper VAD] Started — listening for speech...');
}

function stopWhisperVAD() {
    isActive = false;
    cancelSilenceTimer();
    stopRollingWindow();
    speechBuffer = Buffer.alloc(0);
    isSpeaking = false;
    onTranscriptionCallback = null;
    onInterimTranscriptCallback = null;
    console.log('[Whisper VAD] Stopped');
}

module.exports = { startWhisperVAD, stopWhisperVAD, processAudioChunk };
