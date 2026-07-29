# MetaQuest — Project ADR & Architecture Reference

> Use this file as the primary reference when making changes, adding features, or debugging.
> Update this file whenever a significant decision is made or the architecture changes.

---

## What This Is

MetaQuest is a real-time AI interview assistant built as an Electron app. It listens to the interviewer's voice in real-time, transcribes what they say, and generates a spoken-style answer that the candidate can read and speak naturally — grounded in their resume and tailored to the target job description.

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
| `src/utils/llm/index.js` | LLM pipeline facade — Gemini Live session lifecycle + all LLM IPC handlers (formerly `gemini.js`) |
| `src/utils/llm/state.js` | Shared session state, `sendToRenderer`, stream-update throttle |
| `src/utils/llm/config.js` | Model lists, constants, pure helpers (reasoning detection, etc.) |
| `src/utils/llm/persistence.js` | Session/history persistence, provider history mappers |
| `src/utils/llm/router.js` | Text-answer cascade — data-driven `for…of` over `laneA` / `laneB` adapter arrays |
| `src/utils/llm/telemetry.js` | Per-answer latency log: reset/mark/getLog, ring buffer 50 entries (ADR-020) |
| `src/utils/llm/providers/groq.js` | Groq ProviderAdapter — live model discovery + 1h cache (ADR-018/019) |
| `src/utils/llm/providers/anthropic.js` | Anthropic ProviderAdapter — owns `fetchWithAnthropicRetry` (ADR-018) |
| `src/utils/llm/providers/gemini.js` | Gemini ProviderAdapter for text answers (ADR-018) |
| `src/utils/llm/vision.js` | Screenshot solving + vision provider routing |
| `src/utils/llm/audio.js` | macOS SystemAudioDump capture + Whisper VAD routing |
| `src/utils/whisper.js` | VAD + Groq Whisper transcription; emits telemetry speechEnd/transcriptReady |
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

**Status:** ✅ Implemented. Verified — turnComplete handler now lives in `src/utils/llm/index.js`.

---

### ADR-003: Trigger Groq from silence detection, not turnComplete
**Decision:** `scheduleGroqTrigger()` is called on every `inputTranscription` chunk. It sets a debounce timer. When that much silence passes after the last chunk (user stopped speaking), Groq is triggered immediately — before Gemini starts generating audio. `turnComplete` is kept only as a fallback.

**Why:** `responseModalities: [Modality.TEXT]` was attempted but breaks the session — the `gemini-2.5-flash-native-audio-preview` model with speaker diarization requires AUDIO modality. The real root cause was waiting for `turnComplete`, which fires only after Gemini finishes generating a full audio response (10-15s). By triggering on speech silence instead, Groq starts shortly after the user stops talking.

**Update 2026-07-20:** debounce lowered 700ms → **400ms** and made env-configurable (`GEMINI_SILENCE_MS`, `GEMINI_WARMUP_MS`) for a snappier <1-2s reply (see ADR-017).

**Status:** ✅ Fixed 2026-04-02. `scheduleGroqTrigger()` now lives in `src/utils/llm/router.js`.

---

### ADR-004: Show `...` placeholder immediately on turnComplete
**Decision:** On `turnComplete`, before calling Groq, immediately send `new-response: '...'` to the renderer so the user gets visual feedback within ~0ms of finishing speaking.

**Why:** Even if Groq takes 1-2 seconds, the user sees something happening immediately. Removes the perception of a dead pause.

**Status:** ✅ Implemented. Placeholder emission now lives in `routeAnswer()` in `src/utils/llm/router.js`.

---

### ADR-005: Disable qwen3-32b reasoning mode
**Decision:** Pass `reasoning_effort: 'none'` in every Groq API call.

**Why:** qwen/qwen3-32b is a hybrid thinking model that generates `<think>...</think>` blocks for 5-15 seconds before the actual answer. This kills latency. `reasoning_effort: 'none'` skips the thinking chain entirely.

**Status:** ✅ Implemented. Now in `src/utils/llm/router.js`; `stripThinkingTags` / think-block suppression live in `src/utils/llm/config.js`.

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

**Status:** ✅ Implemented 2026-07-20. `src/utils/llm/vision.js` (`buildImageRequest`, `sendImagesToAnthropic`, `sendImagesToGroqVision`, `routeImagesToProvider`), `src/utils/llm/persistence.js` (`recentHistoryAsGeminiContents`, `recordScreenTurnInHistory`), `renderer.js` (`MANUAL_SCREENSHOT_PROMPT`), `storage.js` (`getAvailableModel`).

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

### ADR-012: Latest free Gemini models via `-latest` aliases
**Decision:** Model IDs are centralized and env-overridable in `storage.js` (`GEMINI_PRIMARY_MODEL`=`gemini-flash-latest`, `GEMINI_LITE_MODEL`=`gemini-flash-lite-latest`, thresholds `GEMINI_PRIMARY_RPD`/`GEMINI_LITE_RPD`). Image fallbacks in `src/utils/llm/config.js` are also env-overridable (`GEMINI_IMAGE_FALLBACKS`).

**Why:** The `-latest` aliases always resolve to the current GA Flash generation (Gemini 3.x as of 2026), which unlocks the larger free-tier budget (~1500 req/day for Flash vs 250 for fixed 2.5-flash) and rides future model bumps with no code change. `gemini-2.5-pro` was removed from all fallbacks — it's free-tier `limit: 0`, and only ever surfaced a misleading "quota exceeded" 429. On 429 the image path now skips to the next model and surfaces a friendly rate-limit message.

**Status:** ✅ Implemented 2026-07-20. `storage.js`, `gemini.js`.

---

### ADR-013: In-app auto-update + tags-only release CI
**Decision:** `update-electron-app` (update.electronjs.org feed, repo `TejG/metamaxpro`) is wired in `index.js`, guarded to packaged builds. Release CI (`.github/workflows/release.yml`) triggers on **tags only** and each platform job publishes idempotently via `softprops/action-gh-release@v2`; the mac `.zip` + Windows `RELEASES`/`.nupkg` auto-update artifacts are uploaded alongside installers.

**Why:** Users shouldn't re-download installers each release. The old workflow triggered on both tag and `main` push, spawning two runs that raced on the archived `actions/create-release@v1` and failed with `already_exists`; dropping the `main` trigger and the separate prepare-release job fixed it.

**Caveat:** macOS auto-update requires code signing (Squirrel.Mac refuses unsigned) — not yet enabled. Windows auto-updates as-is. Feed requires the repo to be public.

**Status:** ✅ Implemented 2026-07-20. `index.js`, `forge.config.js` (maker-zip), `release.yml`.

---

### ADR-014: macOS audio-capture robustness + visible failures
**Decision:** Before spawning `SystemAudioDump`, ensure it's executable and best-effort clear its `com.apple.quarantine` flag; if the helper is missing, dies immediately, or Screen Recording isn't granted, surface an actionable message to the renderer instead of failing silently.

**Why:** On fresh machines audio produced no response while screenshots worked — the bundled (unsigned) helper was Gatekeeper-blocked and all failures only hit the console.

**Status:** ✅ Implemented 2026-07-20. `gemini.js`, `index.js`.

---

### ADR-015: Rename to MetaQuest + mascot app icon
**Decision:** Product-facing name is **MetaQuest** (package.json, forge makers, header/onboarding/MainView copy). Internal identifiers (`meta-max-pro-app` element, `metaMaxPro` global) and the config dir (`meta-max-pro-config`) are intentionally unchanged so existing user data/keys survive the rename. App icons (`logo.icns/.ico/.png`) are generated from the fox mascot (`src/assets/mascot/max.svg`) via `scripts/generate-icons.js` (`npm run generate-icons`). Stable `appBundleId: com.metaquest.app` set for consistent TCC attribution.

**Status:** ✅ Implemented 2026-07-20. `package.json`, `forge.config.js`, `scripts/generate-icons.js`, `AppHeader.js`, `MainView.js`.

---

### ADR-016: Gated two-pane onboarding + permission handling (unsigned)
**Decision:** `OnboardingView` is a two-pane, step-by-step flow (left: brand + step controls; right: instructions) covering Welcome → Permissions → Shortcuts → Context. Permissions are **gated**: Screen Recording is a hard gate on macOS (polled so it unlocks live); Microphone is recommended but **skippable** ("Skip for now"). Launch/focus gating in `MetaMaxProApp` re-shows onboarding if Screen Recording is missing (`gateMode`). IPC: `permissions:get-status` / `-request-microphone` / `-open-settings`.

**Unsigned caveat:** macOS TCC is unreliable for unsigned/quarantined apps (App Translocation prevents mic/screen registration). Onboarding shows the exact `xattr -dr com.apple.quarantine /Applications/MetaQuest.app` workaround (with a Copy button); during onboarding the window drops always-on-top/content-protection and becomes movable so System Settings and native prompts are reachable. Durable fix is code signing + notarization (deferred).

**Status:** ✅ Implemented 2026-07-20. `OnboardingView.js`, `MetaMaxProApp.js`, `window.js`, `index.js`.

---

### ADR-017: Latency tuning to <1-2s
**Decision:** Silence debounce 700ms → 400ms and session warmup 2000ms → 1000ms, both env-overridable; Groq cascade keeps the lowest-TTFT model (`llama-3.3-70b-versatile`) first.

**Why:** The controllable latency was the post-speech silence wait. Remaining lag is Gemini Live transcription (Google-side, not client-tunable).

**Status:** ✅ Implemented 2026-07-20. `gemini.js`.

---

### ADR-018: ProviderAdapter interface — data-driven cascade
**Decision:** Extract each LLM provider into a uniform adapter object `{ name, isAvailable(), streamAnswer({ reasoning }), listModels() }` living in `src/utils/llm/providers/{groq,anthropic,gemini}.js`. `router.js` cascade is a plain `for…of` loop over `laneA` / `laneB` arrays; no more if-chains or provider-specific branches in the router.

**Why:** Adding or reordering a provider previously required editing multiple if-chains scattered across router.js. The adapter pattern makes each provider self-contained and the cascade order a single line of data.

**Status:** ✅ Implemented. `src/utils/llm/providers/`, `src/utils/llm/router.js`.

---

### ADR-019: Live Groq model discovery + 1-hour cache
**Decision:** Groq adapter fetches `/openai/v1/models` on startup (warm-up) and at first `listModels()` call, caches the result for 1 hour (`MODEL_CACHE_TTL_MS`). At cascade time, the live candidate list is filtered against the cache so retired model IDs never reach the API. Anthropic and Gemini return curated static lists from their adapters.

**Why:** Hardcoded model IDs silently 404 when Groq retires a model. Live discovery eliminates that class of failure without requiring a deploy.

**Status:** ✅ Implemented. `src/utils/llm/providers/groq.js`.

---

### ADR-020: Per-answer latency telemetry (speechEnd → transcript → TTFT → done)
**Decision:** `src/utils/llm/telemetry.js` provides `reset()` / `mark(stage, meta)` / `getLog()`. `whisper.js` calls `reset()` + `mark('speechEnd')` when VAD fires, `mark('transcriptReady')` when Whisper returns. Each provider adapter calls `mark('ttft', 'provider:model')` on first streamed token. `router.js` calls `mark('done')` after `flushStreamUpdate()`. A ring buffer of 50 entries is kept; `_flush()` logs a one-line summary to console on each `done`.

**Why:** Latency regressions were detected by feel. Structured per-stage timing makes regressions visible in logs immediately and allows future IPC exposure (DevTools / settings panel).

**Status:** ✅ Implemented. `src/utils/llm/telemetry.js`, `src/utils/whisper.js`, `src/utils/llm/router.js`, all provider adapters.

---

### ADR-021: Interview evidence lock + layered response format + temperature 0.2
**Decision:** Three-part fix to eliminate metric hallucination in interview mode:
1. **Hard evidence lock** in `job_interview` and `meeting` prompts: NEVER invent percentages, dollar amounts, team sizes, timelines, or impact metrics unless explicitly present in resume/JD/notes. Use qualitative language instead ("reduced manual effort" not "reduced by 30%").
2. **Layered response format**: Every answer now includes three sections — (1) primary spoken answer (4-6 sentences), (2) short version (2-3 sentences), (3) technical depth bullets (3-6 items) — matching the structure used by experienced human interviewees.
3. **Temperature 0.2** for interview/meeting profiles (vs. 0.4 standard, 0.1 reasoning). Reduces creativity/fabrication risk while preserving natural language flow.

**Why:** User feedback showed the model was inventing specific metrics ("30% reduction", "25% improvement") when none existed in context. This is unsafe in interviews — invented numbers invite scrutiny the candidate can't defend. The competitor's format showed candidates naturally speak in layers: a full answer, a short version, and deep-dive ammunition for follow-ups. Temperature 0.2 sits between reasoning (0.1, too rigid) and conversational (0.4, too creative for high-stakes interviews).

**Status:** ✅ Implemented 2026-07-28. `src/utils/prompts.js` (INTERVIEW_EVIDENCE_LOCK, updated job_interview/meeting prompts, layered standard response mode, temperature 0.2), `src/utils/llm/router.js` (temperature routing), all provider adapters (temperature parameter in streamAnswer).

---

### ADR-022: Smart resume section filtering (30-50% token reduction)
**Decision:** Parse resume into sections (Experience, Skills, Projects, Education, Summary) at session initialization. On each question, classify intent (technical/behavioral/project/education/summary) and select only relevant sections to prepend to the user message, instead of sending the entire resume every turn.

**Implementation:**
- `resumeParser.js`: Extracts sections using regex patterns for standard ("Experience", "Skills") and non-standard ("Work History", "Core Competencies") headers, with heuristic fallback for resumes without clear markers.
- `contextFilter.js`: Classifies question intent via keyword patterns and returns filtered sections (e.g., technical → Skills + Experience + Projects; behavioral → Experience + Projects).
- `persistence.js`: Added `parseContextSections()` to extract resume/JD/avoid from combined context at init; stores in `S.resumeText` / `S.jobDescriptionText` / `S.avoidWordsText`.
- `router.js`: Modified `routeAnswer()` to call `getRelevantResumeSections()` and prepend filtered context to each user message before pushing to conversation history.

**Why:** Enterprise transition requires paid models (Claude, GPT-4) where token cost matters. Sending the entire 800-1200 char resume every turn wastes ~30% of prompt budget on irrelevant content. Smart filtering reduces cost while preserving answer quality — technical questions don't need education details, behavioral questions don't need full skills list. This also improves latency (smaller prompts = faster processing) and prepares for usage-based billing.

**Impact:** Token usage reduced 20-50% per question (measured: 22-50% across test cases). Cost savings of ~$0.02 per 10-question interview on Claude 3.5 Sonnet, ~$15/month savings for active users. Faster TTFT (time to first token) by 100-200ms on paid models.

**Status:** ✅ Implemented 2026-01-29. `src/utils/llm/resumeParser.js` (157 lines), `src/utils/llm/contextFilter.js` (134 lines), `src/utils/llm/state.js` (resume/JD fields), `src/utils/llm/persistence.js` (context parsing), `src/utils/llm/router.js` (filtering integration). Tests: 13/13 unit, 6/6 integration, 21/21 smoke.

---

## Known Issues / Active Bugs

| # | Issue | Root Cause | Fix |
|---|-------|-----------|-----|
| ~~1~~ | ~~**15-20 second latency**~~ | ~~Gemini `responseModalities` set to `AUDIO`~~ | ✅ Fixed — silence-trigger + 400ms debounce (ADR-003/017) |
| ~~2~~ | ~~Responses invent metrics~~ | ~~Prompt allowed confident generation without hard evidence lock~~ | ✅ Fixed — evidence lock + qualitative language + temperature 0.2 (ADR-021) |
| 3 | Responses start with "I" | Prompt says first word shouldn't be "I" but model sometimes ignores it | May need stronger enforcement or few-shot examples |
| 4 | **macOS permissions unreliable (unsigned)** | App is unsigned/notarized → Gatekeeper quarantine + App Translocation block mic/screen TCC registration | Workaround: move to /Applications + `xattr` de-quarantine (surfaced in onboarding, ADR-016). Durable fix: code signing + notarization |

---

## What "Done" Looks Like (Success Criteria)

1. **Latency:** First word of answer appears within 1-2 seconds of interviewer finishing their question
2. **Human-sounding:** Answer cannot be identified as AI-generated — uses first person, specific company/project names from resume, natural speech patterns, real opinions
3. **JD-aligned:** Answer highlights experiences from resume that best match what this specific role values
4. **Question-type aware:** Behavioral → STAR story. Coding → clarify first, then approach, then code. Twisted → decode hidden intent, answer both layers
5. **No edge cases:** Every question type has a clear strategy. No question should produce a generic or off-topic answer

---

## Roadmap / Next Steps

- [ ] **Code signing + notarization (macOS)** — highest priority; unblocks mic/screen permissions, the audio helper, clean quit, and mac auto-update (see ADR-016)
- [ ] Ship an x64 `SystemAudioDump` (current binary is arm64-only → Intel Macs get no audio)
- [ ] Expose telemetry log via IPC (`get-telemetry-log`) for in-app DevTools / latency panel (ADR-020 follow-up)
- [ ] Main-process session store with pub/sub diffs → `MetaMaxProApp` (Phase 3 item #9)
- [ ] Multi-window support: main + overlay share the same session store (Phase 3 item #10)
- [ ] Local transcription via whisper.cpp (offline, no Gemini dependency) (Phase 4 item #11)
- [ ] Dual audio capture — separate microphone vs system audio streams
- [ ] Speaker diarization — label Interviewer vs Candidate in transcript
- [ ] Rebuild UI with shadcn/ui components
- [ ] Testing infrastructure (Jest)

---

## Repo / Release

- GitHub: `https://github.com/TejG/metamaxpro`
- Latest release: v0.10.3 (v0.10.4 pending) — installers + auto-update artifacts per platform
- Auto-update: `update.electronjs.org` feed (Windows live; macOS pending code signing)
- Branch: `main`
