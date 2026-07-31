# Session Timeout Issue - Analysis & Fix

## Problem
User reports: "Session only working for 10-15 mins after that its not working, not taking in audio and generating answers"

## Root Cause
Gemini Live API sessions have an idle timeout (approximately 10-15 minutes of inactivity). When no audio is sent or received for this period, the WebSocket connection closes silently without triggering the reconnection logic properly.

The current code:
1. ✅ Has reconnection logic (`attemptReconnect()`)
2. ✅ Handles `onclose` events  
3. ❌ **No keepalive/heartbeat mechanism** to prevent idle timeout
4. ❌ **No activity tracking** to detect prolonged silence
5. ❌ **No proactive session refresh** before timeout

## Solution: Implement Keepalive Heartbeat

Add a periodic heartbeat that:
1. Sends silent audio packets during inactivity
2. Resets before the Gemini idle timeout (15 min)
3. Only runs when session is active
4. Stops when user is actively speaking
5. Minimal overhead (~1 packet every 5 minutes)

## Implementation Plan

### 1. Add Keepalive State to `state.js`
```javascript
// Keepalive for Gemini Live session (prevent idle timeout)
sessionKeepaliveTimer: null,
lastActivityTimestamp: Date.now(),
```

### 2. Implement Keepalive in `index.js`
```javascript
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const IDLE_TIMEOUT_WARNING_MS = 12 * 60 * 1000; // 12 minutes (warn before 15min timeout)

function startKeepalive(geminiSessionRef) {
    stopKeepalive(); // Clear any existing timer
    
    S.sessionKeepaliveTimer = setInterval(async () => {
        const idleDuration = Date.now() - S.lastActivityTimestamp;
        
        // If idle for 12+ minutes, send keepalive packet
        if (idleDuration >= IDLE_TIMEOUT_WARNING_MS && geminiSessionRef.current) {
            console.log('[Keepalive] Sending heartbeat packet (idle:', Math.floor(idleDuration/1000/60), 'min)');
            try {
                // Send 100ms of silence (minimal payload)
                const silentAudio = Buffer.alloc(3200).toString('base64'); // 100ms @ 16kHz mono
                await geminiSessionRef.current.sendRealtimeInput({
                    audio: {
                        data: silentAudio,
                        mimeType: 'audio/pcm;rate=16000',
                    },
                });
                S.lastActivityTimestamp = Date.now(); // Reset activity timestamp
            } catch (error) {
                console.error('[Keepalive] Failed to send heartbeat:', error);
                // Session likely dead - trigger reconnect
                if (S.sessionParams && S.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    attemptReconnect();
                }
            }
        }
    }, KEEPALIVE_INTERVAL_MS);
}

function stopKeepalive() {
    if (S.sessionKeepaliveTimer) {
        clearInterval(S.sessionKeepaliveTimer);
        S.sessionKeepaliveTimer = null;
    }
}

function updateActivityTimestamp() {
    S.lastActivityTimestamp = Date.now();
}
```

### 3. Update Audio Flow to Track Activity
In `audio.js` `sendAudioToGemini()`:
```javascript
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
        // Update activity timestamp on every audio send
        const { updateActivityTimestamp } = require('./llm/index');
        updateActivityTimestamp();
    } catch (error) {
        console.error('Error sending audio to Gemini:', error);
    }
}
```

### 4. Update Session Initialization
In `initializeGeminiSession()` after successful connection:
```javascript
onopen: function () {
    S.sessionReadyAt = Date.now();
    S.lastActivityTimestamp = Date.now();
    sendToRenderer('update-status', 'Live session connected');
    
    // Start keepalive timer
    if (!isReconnect) {
        startKeepalive(global.geminiSessionRef);
    }
},
```

### 5. Update Session Cleanup
In `stopSession()` and `onclose`:
```javascript
function stopSession() {
    S.isUserClosing = true;
    stopKeepalive(); // Stop keepalive timer
    // ...existing cleanup
}

onclose: function (e) {
    console.log('Session closed:', e.reason);
    stopKeepalive(); // Ensure keepalive stops
    // ...existing logic
}
```

## Benefits
1. ✅ Prevents 10-15 minute idle timeout
2. ✅ Minimal overhead (1 packet per 5 min when idle)
3. ✅ No user-visible impact
4. ✅ Automatic session health monitoring
5. ✅ Triggers reconnect if keepalive fails

## Testing
1. Start session, wait 15 minutes without speaking → session stays alive
2. Verify audio still captured after 20+ minutes
3. Check logs for keepalive packets every 5 minutes when idle
4. Confirm no keepalive when actively speaking

## Alternative Solutions Considered

### Option 1: Auto-reconnect every 10 minutes (rejected)
- ❌ Disrupts active conversations
- ❌ Loses in-flight state
- ❌ User-visible interruption

### Option 2: Periodic text keepalive (rejected)
- ❌ Could trigger unwanted transcription
- ❌ More complex than audio silence

### Option 3: WebSocket ping/pong (rejected)
- ❌ Gemini Live uses gRPC-Web, not raw WebSocket
- ❌ Not exposed in Google GenAI SDK

## References
- Gemini Live API: https://ai.google.dev/gemini-api/docs/live-api
- WebSocket keepalive patterns: https://www.rfc-editor.org/rfc/rfc6455
