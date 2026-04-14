const { getGroqApiKey } = require('../storage');

// Voice Activity Detection parameters
const SPEECH_RMS_THRESHOLD = 3000;   // Higher threshold to ignore breathing/mic noise
const SILENCE_DURATION_MS = 1800;   // Increased to 1.8 seconds to allow for natural mid-sentence pauses
const MIN_SPEECH_DURATION_MS = 250; // Quicker response for short utterances
const MAX_BUFFER_DURATION_MS = 45000; // Trigger STT forcefully if they talk for >45s
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

let speechBuffer = Buffer.alloc(0);
let isSpeaking = false;
let silenceTimer = null;
let onTranscriptionCallback = null;
let isActive = false;
let noiseFloor = 300; // adaptive baseline

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

    try {
        const transcript = await transcribeWithGroq(buffer);
        if (transcript && transcript.trim() !== '') {
            console.log(`[Whisper] "${transcript}"`);
            onTranscriptionCallback(transcript);
        }
    } catch (e) {
        console.error('[Whisper] Transcription error:', e.message);
    }
}

async function transcribeWithGroq(pcmBuffer) {
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
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: formData,
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq Whisper ${response.status}: ${errText.substring(0, 200)}`);
    }

    const json = await response.json();
    return (json.text || '').trim();
}

// Called for each 100ms mono PCM chunk from SystemAudioDump
function processAudioChunk(monoChunk) {
    if (!isActive) return;

    const rms = getRms(monoChunk);

    // Slowly adapt the noise floor when someone is NOT actively speaking
    if (!isSpeaking) {
        noiseFloor = (noiseFloor * 0.8) + (rms * 0.2);
    }
    
    // Dynamic threshold: at least SPEECH_RMS_THRESHOLD, but dynamically scales 
    // above ambient room noise (e.g. static/humming).
    const dynamicThreshold = Math.max(SPEECH_RMS_THRESHOLD, noiseFloor * 2.5);

    if (rms > dynamicThreshold) {
        if (!isSpeaking) {
            isSpeaking = true;
            console.log(`[Whisper VAD] Speech started (RMS: ${rms.toFixed(0)}, Threshold: ${dynamicThreshold.toFixed(0)})`);
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

function startWhisperVAD(callback) {
    isActive = true;
    onTranscriptionCallback = callback;
    speechBuffer = Buffer.alloc(0);
    isSpeaking = false;
    cancelSilenceTimer();
    console.log('[Whisper VAD] Started — listening for speech...');
}

function stopWhisperVAD() {
    isActive = false;
    cancelSilenceTimer();
    speechBuffer = Buffer.alloc(0);
    isSpeaking = false;
    onTranscriptionCallback = null;
    console.log('[Whisper VAD] Stopped');
}

module.exports = { startWhisperVAD, stopWhisperVAD, processAudioChunk };
