# Meta Max Pro

> [!NOTE]
> Use latest MacOS and Windows version, older versions have limited support

> [!NOTE]
> During testing it wont answer if you ask something, you need to simulate interviewer asking question, which it will answer

A real-time AI assistant that provides contextual help during video calls, interviews, presentations, and meetings using screen capture and audio analysis.

## Features

- **Live AI Assistance**: Real-time help powered by Google Gemini 2.0 Flash Live
- **Screen & Audio Capture**: Analyzes what you see and hear for contextual responses
- **Multiple Profiles**: Interview, Sales Call, Business Meeting, Presentation, Negotiation
- **Transparent Overlay**: Always-on-top window that can be positioned anywhere
- **Click-through Mode**: Make window transparent to clicks when needed
- **Cross-platform**: Works on macOS, Windows, and Linux (kinda, dont use, just for testing rn)

## Download

### macOS Installation Troubleshooting

If you see a message like "Meta Max Pro is damaged and can’t be opened. You should move it to the Trash":

1. **Remove Quarantine Attribute:**
	Open Terminal and run:
	```sh
	xattr -dr com.apple.quarantine /Applications/Meta\ Max\ Pro.app
	```
	(Adjust the path if you installed elsewhere.)

2. **Allow App in Security Settings:**
	- Go to **System Settings > Privacy & Security**
	- If you see a warning about Meta Max Pro, click **Allow Anyway**

3. **For Developers:**
	If you built the app yourself, you may need to codesign it for local use:
	```sh
	codesign --deep --force --sign - /path/to/Meta\ Max\ Pro.app
	```

For production/distribution, the app must be signed and notarized with an Apple Developer ID for best user experience.

| Platform | Link |
|---|---|
| macOS (Apple Silicon, arm64) | [Meta Max Pro-0.7.0-arm64.dmg](https://github.com/TejG/metamaxpro/releases/latest/download/Meta.Max.Pro-0.7.0-arm64.dmg) |
| macOS (Intel, x64) | [Meta Max Pro-0.7.0-x64.dmg](https://github.com/TejG/metamaxpro/releases/latest/download/Meta.Max.Pro-0.7.0-x64.dmg) |
| Windows (x64) | [Meta Max Pro-0.7.0.exe](https://github.com/TejG/metamaxpro/releases/latest/download/Meta.Max.Pro-0.7.0.exe) |
| Linux (AppImage) | [Meta Max Pro-0.7.0.AppImage](https://github.com/TejG/metamaxpro/releases/latest/download/Meta.Max.Pro-0.7.0.AppImage) |

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
