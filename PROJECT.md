# Meta Booster Pro — Project ADR & Architecture Reference

> Use this file as the primary reference when making changes, adding features, or debugging.
> Update this file whenever a significant decision is made or the architecture changes.

---

## What This Is

Meta Booster Pro is a real-time AI interview assistant built as an Electron app. It listens to the interviewer's voice in real-time, transcribes what they say, and generates a spoken-style answer that the candidate can read and speak naturally — grounded in their resume and tailored to the target job description.

**The core promise:** Within 1-2 seconds of the interviewer finishing their question, a natural-sounding answer starts appearing on screen. The answer should be indistinguishable from something a prepared, experienced human would say.

---

## Architecture Overview

```
Microphone/System Audio
        │
        ▼
  Gemini Live API  ─── transcribes user speech ──► currentTranscription
  (audio input only,                                      │
   TEXT response mode)                                    │ on turnComplete
        │                                                 ▼
        │                                          Groq API (fast LLM)
        │                                          model: qwen3-32b / kimi-k2
        │                                          stream: true
        │                                                 │
        ▼                                                 ▼
  Gemini Audio Output                           Streaming tokens → renderer
  (NOT USED — disabled)                         update-response IPC channel
```

### Key components

| File | Responsibility |
|------|---------------|
| `src/utils/gemini.js` | Gemini Live session, audio capture, turnComplete handler, Groq call |
| `src/utils/prompts.js` | All system prompts — interview, sales, meeting, etc. |
| `src/utils/renderer.js` | IPC bridge, session init, `buildContext()` combining resume + JD |
| `src/utils/cloud.js` | WebSocket cloud provider (alternative to BYOK) |
| `src/utils/localai.js` | Local model provider (Ollama) |
| `src/storage.js` | Preferences, API keys, model rotation |
| `src/components/views/AICustomizeView.js` | Resume + JD input UI |
| `src/components/views/AssistantView.js` | Response display, nav, input bar |

---

## ADR — Architecture Decisions

### ADR-001: Use Gemini Live only for transcription, Groq for answers
**Decision:** Gemini Live API is used solely to transcribe speech in real-time. When `turnComplete` fires (user stops speaking), we send the transcription to Groq for the actual answer generation.

**Why:** Gemini Live generates audio responses which take 10-15 seconds. Groq's LLM API with streaming starts returning tokens in ~1 second. The user needs visible feedback in <2 seconds.

**Consequences:** We pay for Gemini only for transcription. We need a separate Groq API key. Gemini audio output must be set to `TEXT` mode (not AUDIO) to avoid Gemini generating a useless audio response that delays `turnComplete`.

---

### ADR-002: Trigger Groq on `turnComplete`, NOT `generationComplete`
**Decision:** `sendToGroq()` is called inside the `turnComplete` handler, not `generationComplete`.

**Why:** `generationComplete` fires after Gemini finishes generating its (audio/text) response — adding significant latency. `turnComplete` fires as soon as the user stops speaking and Gemini has the transcription.

**Status:** ✅ Implemented. Verified in `gemini.js` lines 495-507.

---

### ADR-003: Trigger Groq from silence detection, not turnComplete
**Decision:** `scheduleGroqTrigger()` is called on every `inputTranscription` chunk. It sets a 700ms debounce timer. When 700ms of silence passes after the last chunk (user stopped speaking), Groq is triggered immediately — before Gemini starts generating audio. `turnComplete` is kept only as a fallback.

**Why:** `responseModalities: [Modality.TEXT]` was attempted but breaks the session — the `gemini-2.5-flash-native-audio-preview` model with speaker diarization requires AUDIO modality. The real root cause was waiting for `turnComplete`, which fires only after Gemini finishes generating a full audio response (10-15s). By triggering on speech silence instead, Groq starts ~700ms after the user stops talking.

**Status:** ✅ Fixed 2026-04-02. `scheduleGroqTrigger()` in `gemini.js`.

---

### ADR-004: Show `...` placeholder immediately on turnComplete
**Decision:** On `turnComplete`, before calling Groq, immediately send `new-response: '...'` to the renderer so the user gets visual feedback within ~0ms of finishing speaking.

**Why:** Even if Groq takes 1-2 seconds, the user sees something happening immediately. Removes the perception of a dead pause.

**Status:** ✅ Implemented. `gemini.js` line 499.

---

### ADR-005: Disable qwen3-32b reasoning mode
**Decision:** Pass `reasoning_effort: 'none'` in every Groq API call.

**Why:** qwen/qwen3-32b is a hybrid thinking model that generates `<think>...</think>` blocks for 5-15 seconds before the actual answer. This kills latency. `reasoning_effort: 'none'` skips the thinking chain entirely.

**Status:** ✅ Implemented. `gemini.js` line 275. Also added `inThinkBlock` tracker to suppress any `<think>` content during streaming.

---

### ADR-006: Resume + JD combined into structured context
**Decision:** `buildContext(prefs)` in `renderer.js` combines the resume (`prefs.customPrompt`) and job description (`prefs.jobDescription`) into a structured string passed as the system prompt context.

**Format:**
```
RESUME / BACKGROUND:
[resume text]

TARGET JOB DESCRIPTION:
[JD text]
```

**Why:** The model needs to know which field is the resume (examples to draw from) and which is the JD (what the role values, to weight story selection toward).

**Status:** ✅ Implemented. `renderer.js` `buildContext()`. UI in `AICustomizeView.js`.

---

### ADR-007: Model rotation for Groq free tier
**Decision:** `getModelForToday()` in `storage.js` rotates through free Groq models to avoid daily limits.

**Rotation order:** `qwen/qwen3-32b` → `openai/gpt-oss-120b` → `openai/gpt-oss-20b` → `moonshotai/kimi-k2-instruct`

**Status:** ✅ Implemented.

---

### ADR-008: Interview prompt uses 9-type question classifier
**Decision:** The interview system prompt includes a `STEP 0 — READ THE QUESTION TYPE` section that classifies every question into 9 types (behavioral, technical, system design, coding, situational, self-reflection, culture fit, resume deep-dive, ambiguous/twisted) and applies a type-specific response strategy.

**Why:** Different question types require fundamentally different answer structures. A behavioral question needs a STAR story. A system design question needs clarifying questions first. A twisted question needs the hidden intent decoded before answering.

**Key rules embedded:**
- FAST START: first 5 words must name something real (company, project, number)
- No AI-sounding phrases (banned list in prompt)
- JD alignment: pick stories that match what this specific role values
- For coding/design: ALWAYS clarify before solving — vague questions are deliberate traps

**Status:** ✅ Implemented in `prompts.js`.

---

### ADR-009: Two-shortcut model for on-screen questions (Answer Now + Add Screen)
**Decision:** Screenshot-based solving is driven by two **global** shortcuts instead of the old (half-wired) Capture/Solve pair:
- **Answer Now** — `Cmd/Ctrl+Enter` (`nextStep`). In `main` view it starts the session; in `assistant` view it delegates to `AssistantView.handleScreenAnswer()`, which analyses the buffered screens if any were added, otherwise the current frame.
- **Add Screen** — `Cmd/Ctrl+Shift+Enter` (`addScreen`). Delegates to `AssistantView.handleCaptureScreenshot()`, pushing the current frame into the `capturedScreenshots` buffer (with a count badge) without analysing yet.

**Why:** A single screenshot only captures one viewport, so long/multi-screen questions (LeetCode problems, specs) lost everything below the fold. The multi-screenshot buffer already existed but was exposed as two co-equal buttons and its shortcuts (`Cmd+Shift+C/S`) were **never registered** in `updateGlobalShortcuts()` — so they only worked via a window-focused keydown listener, useless during a real interview when another app has focus. Collapsing to one primary "answer" key + one optional "add screen" key keeps the fast <2s path for simple questions while making long questions a natural scroll→add→scroll→add→answer flow.

**Consequences / fixes rolled in:**
- Both shortcuts are now registered as real global accelerators in `window.js` and routed through `handleShortcut()`, which reaches the live `<assistant-view>` via the app root's shadow DOM so the badge / analyzing state update.
- `Cmd+Enter` no longer discards the capture buffer (old bug: it took a lone fresh frame).
- `handleScreenAnswer()` wraps its work in `try/finally` so `isAnalyzing` can never get stuck when capture fails before a response is added (no media stream / blank frame).
- Removed the over-eager plain `c`/`s` window-focused handlers; the local keydown listener now only handles `Cmd/Ctrl+Shift+K` (copy code block).
- Solve-path capture resolution bumped (`MAX_WIDTH` 1280→1600, medium JPEG quality 0.6→0.75) for legibility of dense code/text.

**Status:** ✅ Implemented 2026-07-20. `window.js`, `renderer.js` (`handleShortcut`, `_getAssistantView`, `_captureFrameAsBase64`), `AssistantView.js`, `HelpView.js`.

---

### ADR-010: Context-aware, multi-provider screenshot solving
**Decision:** The screenshot/solve path now (a) carries full session context and (b) works across every provider, not just Gemini BYOK.

**Context-awareness:** `sendImageToGeminiHttp` / `sendMultipleImagesToGeminiHttp` inject `currentSystemPrompt` (persona + resume + JD + human-tone rules) as Gemini `systemInstruction` and the last 8 turns of `groqConversationHistory` as prior `contents`. The `MANUAL_SCREENSHOT_PROMPT` non-coding branch answers in-character (first person, grounded, spoken-style). After each solve, `recordScreenTurnInHistory()` pushes the exchange back into `groqConversationHistory` so later audio turns stay coherent. Coding screenshots keep the judge-safe *Type this / say out loud / complexity / edge cases* format (see the prompt in `renderer.js`).

**Multi-provider routing:** `send-image-content` / `send-multiple-images-content` handle cloud and local as before, then delegate to `routeImagesToProvider()`:
- `anthropic` mode → `sendImagesToAnthropic()` (Claude vision, `claude-sonnet-4-6`, streaming, context-aware).
- `whisper` mode → Gemini HTTP if a Gemini key exists, else Claude vision if an Anthropic key exists, else Groq vision (`sendImagesToGroqVision`, best-effort), else a clear "add a vision key" error.
- `byok` (default) → Gemini HTTP.

**Also fixed (ADR-005-adjacent):** `getAvailableModel()` / the image fallback list used invalid Gemini IDs (`gemini-1.5`, `gemini-2.1`); now `gemini-2.5-flash → 2.5-flash-lite → 2.0-flash → 2.5-pro`. `getAvailableModel()` also now increments the daily usage counters correctly.

**Status:** ✅ Implemented 2026-07-20. `gemini.js` (`buildImageRequest`, `recentHistoryAsGeminiContents`, `recordScreenTurnInHistory`, `sendImagesToAnthropic`, `sendImagesToGroqVision`, `routeImagesToProvider`), `renderer.js` (`MANUAL_SCREENSHOT_PROMPT`), `storage.js` (`getAvailableModel`).

---

### ADR-011: Chat-style UI, Settings hub, and minimize-to-mascot
**Decision:** Reworked the app shell around a single chat surface and consolidated navigation.

- **Home = chat** (`assistant` view, `MetaMaxProApp` boots here and auto-calls `handleStart()`). If no provider is configured, `handleStart` bails and the chat shows a "Session not started · ▶ Start · ⚙" banner. `AssistantView` now renders the full `responses[]` as a scrollable, markdown, auto-scrolling transcript (bubbles) instead of one-response-with-nav; the input row sits below it with a compact controls row: **Profile dropdown · Add screen · Analyze · Settings gear**.
- **Settings hub** (`customize` view): a link row (Profile / History / Help & Feedback) above the preferences form. The gear opens it; sub-pages' back buttons return to Settings. The old MainView bottom-nav is gone (MainView is no longer reached; `renderSidebar` was already dead code).
- **AI → Profile** rename; **Feedback merged into Help** (`help` case renders `<help-view>` + `<feedback-view>`; the `feedback` view/route removed).
- **History (#1 fix)**: `HistoryView` now shows one chronological **Transcript** tab merging `conversationHistory` (audio/typed) + `screenAnalysisHistory` (screen/code solves), rendered as markdown (code answers were being saved all along in `screenAnalysisHistory` — they were just siloed in a raw-text "Screen" tab).
- **Minimize-to-mascot (#2.e)**: the live-bar `[minimize]` control calls `minimize-to-mascot` → `mainWindow.hide()` (off taskbar) + a small frameless, transparent, always-on-top, `skipTaskbar` mascot window (`src/mascot.html`, `max.svg`, ~84×104). Drag to move (`mascot-drag` IPC moves the window by deltas); a near-stationary click calls `restore-from-mascot` → shows the main window and closes the mascot. The audio session keeps running while minimized.

**Status:** ✅ Implemented 2026-07-20. `MetaMaxProApp.js`, `AssistantView.js`, `HistoryView.js`, `window.js`, new `src/mascot.html`.

---

## Known Issues / Active Bugs

| # | Issue | Root Cause | Fix |
|---|-------|-----------|-----|
| ~~1~~ | ~~**15-20 second latency**~~ | ~~Gemini `responseModalities` set to `AUDIO`~~ | ✅ Fixed — `[Modality.TEXT]` |
| 2 | Responses start with "I" | Prompt says first word shouldn't be "I" but model sometimes ignores it | May need stronger enforcement or few-shot examples |

---

## What "Done" Looks Like (Success Criteria)

1. **Latency:** First word of answer appears within 1-2 seconds of interviewer finishing their question
2. **Human-sounding:** Answer cannot be identified as AI-generated — uses first person, specific company/project names from resume, natural speech patterns, real opinions
3. **JD-aligned:** Answer highlights experiences from resume that best match what this specific role values
4. **Question-type aware:** Behavioral → STAR story. Coding → clarify first, then approach, then code. Twisted → decode hidden intent, answer both layers
5. **No edge cases:** Every question type has a clear strategy. No question should produce a generic or off-topic answer

---

## Roadmap / Next Steps

- [ ] **Fix AUDIO → TEXT modality** (ADR-003) — highest priority, eliminates the 15-20s latency
- [ ] Local transcription via whisper.cpp (offline, no Gemini dependency)
- [ ] Dual audio capture — separate microphone vs system audio streams
- [ ] Speaker diarization — label Interviewer vs Candidate in transcript
- [ ] Rebuild UI with shadcn/ui components
- [ ] Testing infrastructure (Jest)

---

## Repo / Release

- GitHub: `https://github.com/mar7799/demo_poc`
- Release: v0.7.0 DMG for macOS Apple Silicon
- Branch: `main` (single squashed commit history — force push to keep clean)
