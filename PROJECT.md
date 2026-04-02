# Meta Max Pro — Project ADR & Architecture Reference

> Use this file as the primary reference when making changes, adding features, or debugging.
> Update this file whenever a significant decision is made or the architecture changes.

---

## What This Is

Meta Max Pro is a real-time AI interview assistant built as an Electron app. It listens to the interviewer's voice in real-time, transcribes what they say, and generates a spoken-style answer that the candidate can read and speak naturally — grounded in their resume and tailored to the target job description.

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
