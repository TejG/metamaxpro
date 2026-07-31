// macOS system-audio capture: spawns the bundled SystemAudioDump helper,
// converts/resamples the PCM stream, and routes chunks to the active provider
// (Gemini Live / whisper VAD / cloud / local).
const { spawn } = require('child_process');
const { saveDebugAudio } = require('../../audioUtils');
const { S, sendToRenderer, getLocalAi } = require('./state');
const { sendCloudAudio } = require('../cloud');
const { processAudioChunk: processWhisperChunk, stopWhisperVAD } = require('../whisper');

function killExistingSystemAudioDump() {
    return new Promise(resolve => {
        console.log('Checking for existing SystemAudioDump processes...');

        // Kill any existing SystemAudioDump processes
        const killProc = spawn('pkill', ['-f', 'SystemAudioDump'], {
            stdio: 'ignore',
        });

        killProc.on('close', code => {
            if (code === 0) {
                console.log('Killed existing SystemAudioDump processes');
            } else {
                console.log('No existing SystemAudioDump processes found');
            }
            resolve();
        });

        killProc.on('error', err => {
            console.log('Error checking for existing processes (this is normal):', err.message);
            resolve();
        });

        // Timeout after 2 seconds
        setTimeout(() => {
            killProc.kill();
            resolve();
        }, 2000);
    });
}

async function startMacOSAudioCapture(geminiSessionRef) {
    if (process.platform !== 'darwin') return false;

    // Kill any existing SystemAudioDump processes first
    await killExistingSystemAudioDump();

    console.log('Starting macOS audio capture with SystemAudioDump...');

    const { app, systemPreferences } = require('electron');
    const path = require('path');
    const fs = require('fs');
    const { execFileSync } = require('child_process');

    let systemAudioPath;
    if (app.isPackaged) {
        systemAudioPath = path.join(process.resourcesPath, 'SystemAudioDump');
    } else {
        systemAudioPath = path.join(__dirname, '../../assets', 'SystemAudioDump');
    }

    console.log('SystemAudioDump path:', systemAudioPath);

    // The helper is bundled inside an (unsigned) app, so a freshly-downloaded
    // copy is quarantined by macOS and Gatekeeper can silently kill it the
    // moment we spawn it — which looks exactly like "audio produces no response".
    // Best-effort: make sure it's executable and clear the quarantine flag so
    // capture works without the user opening Terminal. (Both may fail if the app
    // lives in a write-protected location — harmless, it's wrapped in try/catch.)
    if (!fs.existsSync(systemAudioPath)) {
        console.error('SystemAudioDump binary not found at', systemAudioPath);
        sendToRenderer('update-status', '⚠️ Audio capture unavailable: helper binary is missing. Please reinstall the app.');
        return false;
    }
    try {
        fs.chmodSync(systemAudioPath, 0o755);
        try {
            execFileSync('xattr', ['-d', 'com.apple.quarantine', systemAudioPath]);
        } catch (_) {
            /* no quarantine attribute — nothing to clear */
        }
    } catch (e) {
        console.error('Could not prepare SystemAudioDump binary (continuing):', e.message);
    }

    // System-audio capture goes through ScreenCaptureKit, which is gated by the
    // Screen Recording permission. Without it the helper runs but records
    // silence — surface that rather than leaving the user staring at nothing.
    try {
        const screenStatus = systemPreferences.getMediaAccessStatus('screen');
        console.log('[Permissions] screen recording status:', screenStatus);
        if (screenStatus !== 'granted') {
            sendToRenderer(
                'update-status',
                '⚠️ Grant Screen Recording permission (System Settings ▸ Privacy & Security), then restart to capture audio.'
            );
        }
    } catch (_) {
        /* getMediaAccessStatus unsupported on this OS version — ignore */
    }
    const spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
        },
    };

    try {
        S.systemAudioProc = spawn(systemAudioPath, [], spawnOptions);
    } catch (e) {
        console.error('Failed to spawn SystemAudioDump:', e);
        sendToRenderer('update-status', '⚠️ Audio capture failed to start: ' + e.message);
        return false;
    }

    if (!S.systemAudioProc || !S.systemAudioProc.pid) {
        console.error('Failed to start SystemAudioDump');
        sendToRenderer('update-status', '⚠️ Audio capture failed to start (the helper could not launch).');
        return false;
    }

    console.log('SystemAudioDump started with PID:', S.systemAudioProc.pid);
    // If the helper dies within ~1.5s it was almost certainly blocked by
    // Gatekeeper or a missing permission — used by the close handler below.
    const systemAudioSpawnedAt = Date.now();

    const CHUNK_DURATION = 0.1;
    const SAMPLE_RATE = 24000;
    const BYTES_PER_SAMPLE = 2;
    const CHANNELS = 2;
    const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION;

    let audioBuffer = Buffer.alloc(0);
    let resampleRemainder = Buffer.alloc(0);

    function resample24kTo16k(inputBuffer) {
        const combined = Buffer.concat([resampleRemainder, inputBuffer]);
        const inputSamples = Math.floor(combined.length / 2);
        const outputSamples = Math.floor((inputSamples * 2) / 3);
        const outputBuffer = Buffer.alloc(outputSamples * 2);

        for (let i = 0; i < outputSamples; i++) {
            const srcPos = (i * 3) / 2;
            const srcIndex = Math.floor(srcPos);
            const frac = srcPos - srcIndex;

            const s0 = combined.readInt16LE(srcIndex * 2);
            const s1 = srcIndex + 1 < inputSamples ? combined.readInt16LE((srcIndex + 1) * 2) : s0;
            const interpolated = Math.round(s0 + frac * (s1 - s0));
            outputBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
        }

        const consumedInputSamples = Math.ceil((outputSamples * 3) / 2);
        const remainderStart = consumedInputSamples * 2;
        resampleRemainder = remainderStart < combined.length ? combined.slice(remainderStart) : Buffer.alloc(0);

        return outputBuffer;
    }

    S.systemAudioProc.stdout.on('data', data => {
        audioBuffer = Buffer.concat([audioBuffer, data]);

        while (audioBuffer.length >= CHUNK_SIZE) {
            const chunk = audioBuffer.slice(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.slice(CHUNK_SIZE);

            const monoChunk24k = CHANNELS === 2 ? convertStereoToMono(chunk) : chunk;
            const monoChunk16k = resample24kTo16k(monoChunk24k);

            if (S.currentProviderMode === 'whisper' || S.currentProviderMode === 'anthropic') {
                processWhisperChunk(monoChunk16k);
            } else if (S.currentProviderMode === 'cloud') {
                sendCloudAudio(monoChunk16k);
            } else if (S.currentProviderMode === 'local') {
                getLocalAi().processLocalAudio(monoChunk24k);
            } else {
                const base64Data = monoChunk16k.toString('base64');
                sendAudioToGemini(base64Data, geminiSessionRef);
            }

            if (process.env.DEBUG_AUDIO) {
                console.log(`Processed audio chunk: ${chunk.length} bytes`);
                saveDebugAudio(monoChunk16k, 'system_audio');
            }
        }

        const maxBufferSize = SAMPLE_RATE * BYTES_PER_SAMPLE * 1;
        if (audioBuffer.length > maxBufferSize) {
            audioBuffer = audioBuffer.slice(-maxBufferSize);
        }
    });

    S.systemAudioProc.stderr.on('data', data => {
        console.error('SystemAudioDump stderr:', data.toString());
    });

    S.systemAudioProc.on('close', code => {
        console.log('SystemAudioDump process closed with code:', code);
        // Died almost immediately (and not because the user stopped it) → the OS
        // blocked it. Tell the user the two things that actually fix it.
        if (!S.isUserClosing && Date.now() - systemAudioSpawnedAt < 1500) {
            const screenStatusNow = (() => {
                try {
                    return systemPreferences.getMediaAccessStatus('screen');
                } catch (_) {
                    return 'unknown';
                }
            })();
            const msg =
                screenStatusNow === 'granted'
                    ? // On macOS Sequoia+ a freshly granted Screen Recording permission
                      // doesn't take effect for an already-running process — this is
                      // the #1 cause of "granted but still no audio" on new machines.
                      '⚠️ Audio helper stopped immediately (code ' +
                      code +
                      '). Screen Recording shows as granted, but macOS requires MetaQuest to be fully quit and reopened before it takes effect — please restart the app.'
                    : `⚠️ Audio helper stopped immediately (code ${code}). Grant Screen Recording permission, and if the app was downloaded, right-click it and choose Open once to allow it.`;
            sendToRenderer('update-status', msg);
        }
        S.systemAudioProc = null;
    });

    S.systemAudioProc.on('error', err => {
        console.error('SystemAudioDump process error:', err);
        sendToRenderer('update-status', '⚠️ Audio capture error: ' + err.message);
        S.systemAudioProc = null;
    });

    return true;
}

function convertStereoToMono(stereoBuffer) {
    const samples = stereoBuffer.length / 4;
    const monoBuffer = Buffer.alloc(samples * 2);

    for (let i = 0; i < samples; i++) {
        const leftSample = stereoBuffer.readInt16LE(i * 4);
        monoBuffer.writeInt16LE(leftSample, i * 2);
    }

    return monoBuffer;
}

function stopMacOSAudioCapture() {
    if (S.systemAudioProc) {
        console.log('Stopping SystemAudioDump...');
        S.systemAudioProc.kill('SIGTERM');
        S.systemAudioProc = null;
    }
    if (S.currentProviderMode === 'whisper' || S.currentProviderMode === 'anthropic') {
        stopWhisperVAD();
    }
}

async function sendAudioToGemini(base64Data, geminiSessionRef) {
    if (!geminiSessionRef.current) return;

    try {
        process.stdout.write('.');
        await geminiSessionRef.current.sendRealtimeInput({
            audio: {
                data: base64Data,
                mimeType: 'audio/pcm;rate=16000',
            },
        });
        // Update activity timestamp on every audio send to prevent idle timeout
        S.lastActivityTimestamp = Date.now();
    } catch (error) {
        console.error('Error sending audio to Gemini:', error);
    }
}

module.exports = {
    killExistingSystemAudioDump,
    startMacOSAudioCapture,
    convertStereoToMono,
    stopMacOSAudioCapture,
    sendAudioToGemini,
};
