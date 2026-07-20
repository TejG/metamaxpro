# MetaQuest

> [!NOTE]
> Use latest MacOS and Windows version, older versions have limited support

> [!NOTE]
> During testing it wont answer if you ask something, you need to simulate interviewer asking question, which it will answer

A real-time AI assistant that provides contextual help during video calls, interviews, presentations, and meetings using screen capture and audio analysis.

## Features

- **Live AI Assistance**: Real-time help powered by Google Gemini (latest Flash), with Groq and Anthropic fallbacks
- **Screen & Audio Capture**: Analyzes what you see and hear for contextual responses
- **Multiple Profiles**: Interview, Sales Call, Business Meeting, Presentation, Negotiation
- **Transparent Overlay**: Always-on-top window that can be positioned anywhere
- **Click-through Mode**: Make window transparent to clicks when needed
- **Cross-platform**: Works on macOS, Windows, and Linux (kinda, dont use, just for testing rn)

## Download

Get the latest installers from the **[Releases page](https://github.com/TejG/metamaxpro/releases/latest)**:

| Platform | File |
|---|---|
| macOS (Apple Silicon, arm64) | `MetaQuest-<version>-arm64.dmg` |
| macOS (Intel, x64) | `MetaQuest-<version>-x64.dmg` |
| Windows (x64) | `MetaQuest-<version>.Setup.exe` |
| Linux (AppImage) | `MetaQuest-<version>.AppImage` |

### macOS Installation & Permissions (Important)

MetaQuest isn't code-signed yet, so macOS quarantines it. Until it's signed, do
this **once** or the app can't be granted Screen Recording / Microphone access
(they simply won't appear in System Settings, because macOS runs a quarantined
app from a throwaway path — "App Translocation"):

1. **Move MetaQuest to `/Applications`** (drag it out of Downloads). This is required — it stops macOS translocating the app.

2. **Remove the quarantine attribute.** Open Terminal and run:
	```sh
	xattr -dr com.apple.quarantine /Applications/MetaQuest.app
	```
	(The onboarding screen has a **Copy** button for this exact command.)

3. **Launch MetaQuest from `/Applications`.** In onboarding, grant **Screen Recording** (required) and **Microphone** (recommended). If a prompt doesn't appear, use **Open Settings** on the card and toggle MetaQuest on — the onboarding detects it automatically.

4. If you still see "MetaQuest is damaged and can't be opened", repeat step 2 — the quarantine flag wasn't cleared.

**For developers building locally**, you can ad-hoc sign for local use:
```sh
codesign --deep --force --sign - /Applications/MetaQuest.app
```

For distribution, the app should be signed and notarized with an Apple Developer ID — that removes all of the above steps.

## Setup (Development)


### Build from Source

1. **Get a Gemini API Key**: Visit [Google AI Studio](https://aistudio.google.com/apikey)
2. **Install Dependencies**: `npm install`
3. **Run the App (dev mode)**: `npm start`
4. **Build Installers**:
	- **macOS (arm64 & x64):** `npm run make` (see `out/make/` for `.dmg` files)
	- **Windows:** `npm run make` (see `out/make/` for `.exe` installer)
	- **Linux:** `npm run make` (see `out/make/` for `.AppImage`)

Release builds for all platforms are available on the [Releases page](https://github.com/TejG/metamaxpro/releases).

## Usage

1. Enter your Gemini API key in the main window
2. Choose your profile and language in settings
3. Click "Start Session" to begin
4. Position the window using keyboard shortcuts
5. The AI will provide real-time assistance based on your screen and what interview asks

## Keyboard Shortcuts

- **Window Movement**: `Ctrl/Cmd + Arrow Keys` - Move window
- **Click-through**: `Ctrl/Cmd + M` - Toggle mouse events
- **Close/Back**: `Ctrl/Cmd + \` - Close window or go back
- **Send Message**: `Enter` - Send text to AI

## Audio Capture

- **macOS**: [SystemAudioDump](https://github.com/Mohammed-Yasin-Mulla/Sound) for system audio
- **Windows**: Loopback audio capture
- **Linux**: Microphone input

## Requirements

- Electron-compatible OS (macOS, Windows, Linux)
- Gemini API key
- Screen recording permissions
- Microphone/audio permissions
