import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { MainView } from '../views/MainView.js';
import { CustomizeView } from '../views/CustomizeView.js';
import { HelpView } from '../views/HelpView.js';
import { HistoryView } from '../views/HistoryView.js';
import { AssistantView } from '../views/AssistantView.js';
import { OnboardingView } from '../views/OnboardingView.js';
import { AICustomizeView } from '../views/AICustomizeView.js';
import { FeedbackView } from '../views/FeedbackView.js';
import { ApiKeysView } from '../views/ApiKeysView.js';

export class MetaMaxProApp extends LitElement {
    static styles = css`
        * {
            box-sizing: border-box;
            font-family: var(--font);
            margin: 0;
            padding: 0;
            cursor: default;
            user-select: none;
        }

        :host {
            display: block;
            width: 100%;
            height: 100vh;
            background: var(--bg-app);
            color: var(--text-primary);
        }

        /* ── Full app shell: top bar + sidebar/content ── */

        .app-shell {
            display: flex;
            height: 100vh;
            overflow: hidden;
        }

        .top-drag-bar {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 9999;
            display: flex;
            align-items: center;
            height: 38px;
            background: transparent;
        }

        .drag-region {
            flex: 1;
            height: 100%;
            -webkit-app-region: drag;
        }

        .top-drag-bar.hidden {
            display: none;
        }

        .traffic-lights {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 0 var(--space-md);
            height: 100%;
            -webkit-app-region: no-drag;
        }

        .traffic-light {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            border: none;
            cursor: pointer;
            padding: 0;
            transition: opacity 0.15s ease;
        }

        .traffic-light:hover {
            opacity: 0.8;
        }

        .traffic-light.close {
            background: #FF5F57;
        }

        .traffic-light.minimize {
            background: #FEBC2E;
        }

        .traffic-light.maximize {
            background: #28C840;
        }

        .sidebar {
            width: var(--sidebar-width);
            min-width: var(--sidebar-width);
            background: var(--bg-surface);
            border-right: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            padding: 42px 0 var(--space-md) 0;
            transition: width var(--transition), min-width var(--transition), opacity var(--transition);
        }

        .sidebar.hidden {
            width: 0;
            min-width: 0;
            padding: 0;
            overflow: hidden;
            border-right: none;
            opacity: 0;
        }

        .sidebar-brand {
            padding: var(--space-sm) var(--space-lg);
            padding-top: var(--space-md);
            margin-bottom: var(--space-lg);
        }

        .sidebar-brand h1 {
            font-size: var(--font-size-sm);
            font-weight: var(--font-weight-semibold);
            color: var(--text-primary);
            letter-spacing: -0.01em;
        }

        .sidebar-nav {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: var(--space-xs);
            padding: 0 var(--space-sm);
            -webkit-app-region: no-drag;
        }

        .nav-item {
            display: flex;
            align-items: center;
            gap: var(--space-sm);
            padding: var(--space-sm) var(--space-md);
            border-radius: var(--radius-md);
            color: var(--text-secondary);
            font-size: var(--font-size-sm);
            font-weight: var(--font-weight-medium);
            cursor: pointer;
            transition: color var(--transition), background var(--transition);
            border: none;
            background: none;
            width: 100%;
            text-align: left;
        }

        .nav-item:hover {
            color: var(--text-primary);
            background: var(--bg-hover);
        }

        .nav-item.active {
            color: var(--text-primary);
            background: var(--bg-elevated);
        }

        .nav-item svg {
            width: 20px;
            height: 20px;
            flex-shrink: 0;
        }

        .sidebar-footer {
            padding: var(--space-sm);
            margin-top: var(--space-sm);
            -webkit-app-region: no-drag;
        }

        .update-btn {
            display: flex;
            align-items: center;
            gap: var(--space-sm);
            width: 100%;
            padding: var(--space-sm) var(--space-md);
            border-radius: var(--radius-md);
            border: 1px solid rgba(239, 68, 68, 0.2);
            background: rgba(239, 68, 68, 0.08);
            color: var(--danger);
            font-size: var(--font-size-sm);
            font-weight: var(--font-weight-medium);
            cursor: pointer;
            text-align: left;
            transition: background var(--transition), border-color var(--transition);
            animation: update-wobble 5s ease-in-out infinite;
        }

        .update-btn:hover {
            background: rgba(239, 68, 68, 0.14);
            border-color: rgba(239, 68, 68, 0.35);
        }

        @keyframes update-wobble {
            0%, 90%, 100% { transform: rotate(0deg); }
            92% { transform: rotate(-2deg); }
            94% { transform: rotate(2deg); }
            96% { transform: rotate(-1.5deg); }
            98% { transform: rotate(1.5deg); }
        }

        .update-btn svg {
            width: 20px;
            height: 20px;
            flex-shrink: 0;
        }

        .version-text {
            font-size: var(--font-size-xs);
            color: var(--text-muted);
            padding: var(--space-xs) var(--space-md);
        }

        /* ── Main content area ── */

        .content {
            flex: 1;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            background: var(--bg-app);
        }

        /* Live mode top bar */
        .live-bar {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 var(--space-md);
            background: var(--bg-surface);
            border-bottom: 1px solid var(--border);
            height: 36px;
            -webkit-app-region: drag;
        }

        .live-bar-left {
            display: flex;
            align-items: center;
            -webkit-app-region: no-drag;
            z-index: 1;
        }

        .live-bar-back {
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--text-muted);
            cursor: pointer;
            background: none;
            border: none;
            padding: var(--space-xs);
            border-radius: var(--radius-sm);
            transition: color var(--transition);
        }

        .live-bar-back:hover {
            color: var(--text-primary);
        }

        .live-bar-back svg {
            width: 14px;
            height: 14px;
        }

        .live-bar-center {
            position: absolute;
            left: 50%;
            transform: translateX(-50%);
            font-size: var(--font-size-xs);
            color: var(--text-muted);
            font-weight: var(--font-weight-medium);
            white-space: nowrap;
            pointer-events: none;
        }

        .live-bar-right {
            display: flex;
            align-items: center;
            gap: var(--space-md);
            -webkit-app-region: no-drag;
            z-index: 1;
        }

        .live-bar-text {
            font-size: var(--font-size-xs);
            color: var(--text-muted);
            font-family: var(--font-mono);
            white-space: nowrap;
        }

        .live-bar-text.clickable {
            cursor: pointer;
            transition: color var(--transition);
        }

        .live-bar-text.clickable:hover {
            color: var(--text-primary);
        }

        /* Window-control buttons in the live bar (minimize / close) */
        .win-btn {
            -webkit-app-region: no-drag;
            background: transparent;
            border: none;
            color: var(--text-muted);
            width: 26px;
            height: 22px;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: background var(--transition), color var(--transition);
        }
        .win-btn:hover {
            background: var(--bg-hover, rgba(128,128,128,0.18));
            color: var(--text-primary);
        }
        .win-btn.close:hover {
            background: #e5484d;
            color: #ffffff;
        }
        .win-btn.font-btn {
            width: auto;
            padding: 0 7px;
            font-size: 12px;
            font-weight: 600;
            font-family: var(--font);
        }

        /* Content inner */
        .content-inner {
            flex: 1;
            overflow-y: auto;
            overflow-x: hidden;
        }

        /* Non-live views (Settings) sit below the fixed 38px drag bar so its
           draggable region never overlaps or swallows clicks on the content. */
        .content-inner:not(.live) {
            padding-top: 38px;
            box-sizing: border-box;
        }

        /* Simple page header with back button for non-main views */
        .page-back-header {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: var(--space-md);
            margin-top: 12px;
            border-bottom: 1px solid var(--border);
            background: var(--bg-surface);
        }

        .back-to-main {
            background: none;
            border: 1px solid var(--border);
            color: var(--text-secondary);
            padding: 6px 8px;
            border-radius: 8px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }

        .back-to-main:hover {
            color: var(--text-primary);
            border-color: var(--border-strong);
            background: var(--bg-hover);
        }

        .content-inner.live {
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        /* Onboarding fills everything */
        .fullscreen {
            position: fixed;
            inset: 0;
            z-index: 100;
            background: var(--bg-app);
        }

        ::-webkit-scrollbar {
            width: 6px;
            height: 6px;
        }

        ::-webkit-scrollbar-track {
            background: transparent;
        }

        ::-webkit-scrollbar-thumb {
            background: var(--border-strong);
            border-radius: 3px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: #444444;
        }

        /* Bottom navigation (replaces left sidebar) */
        .bottom-nav {
            position: fixed;
            left: 0;
            right: 0;
            bottom: 14px;
            display: flex;
            justify-content: center;
            pointer-events: auto;
            z-index: 9998;
        }

        .bottom-nav.hidden {
            display: none;
        }

        .bottom-nav-inner {
            display: flex;
            gap: var(--space-lg);
            padding: 10px 16px;
            border-radius: 12px;
            background: var(--bg-surface);
            border: 1px solid var(--border);
            box-shadow: 0 8px 30px rgba(0,0,0,0.35);
            align-items: center;
        }

        .bottom-nav .nav-item {
            display: inline-flex;
            flex-direction: column;
            align-items: center;
            gap: 6px;
            padding: 8px 12px;
            border-radius: 8px;
            color: var(--text-secondary);
            background: transparent;
        }

        .bottom-nav .nav-item svg { width: 18px; height: 18px; }

        /* ── Settings shell: top tab bar + scrollable body ── */
        .settings-shell {
            display: flex;
            flex-direction: column;
            height: 100%;
            min-height: 0;
        }
        .settings-tabbar {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 8px var(--space-md, 16px);
            border-bottom: 1px solid var(--border);
            background: var(--bg-app);
            overflow-x: auto;
            flex-shrink: 0;
        }
        .settings-tab {
            border: none;
            background: transparent;
            color: var(--text-muted);
            padding: 7px 14px;
            border-radius: 8px;
            font-size: var(--font-size-sm, 13px);
            font-family: var(--font);
            cursor: pointer;
            white-space: nowrap;
            transition: background var(--transition), color var(--transition);
        }
        .settings-tab:hover { color: var(--text-primary); background: var(--bg-hover, rgba(128,128,128,0.12)); }
        .settings-tab.active {
            color: var(--btn-primary-text, var(--bg-app));
            background: var(--accent);
        }
        .settings-tab.home {
            color: var(--text-secondary);
            margin-right: 4px;
        }
        .settings-tab.home:hover { color: var(--text-primary); }
        .settings-tabbar .spacer { flex: 1; }
        .settings-body {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
        }

    `;

    static properties = {
        currentView: { type: String },
        settingsTab: { type: String },
        statusText: { type: String },
        startTime: { type: Number },
        isRecording: { type: Boolean },
        sessionActive: { type: Boolean },
        selectedProfile: { type: String },
        selectedLanguage: { type: String },
        responses: { type: Array },
        currentResponseIndex: { type: Number },
        selectedScreenshotInterval: { type: String },
        selectedImageQuality: { type: String },
        layoutMode: { type: String },
        _viewInstances: { type: Object, state: true },
        _isClickThrough: { state: true },
        _awaitingNewResponse: { state: true },
        shouldAnimateResponse: { type: Boolean },
        _storageLoaded: { state: true },
        _updateAvailable: { state: true },
        _whisperDownloading: { state: true },
        _onboardingGate: { state: true },
    };

    constructor() {
        super();
        this.currentView = 'main';
        this.settingsTab = 'preferences';
        this._fontSize = 16;
        this.statusText = '';
        this.startTime = null;
        this.isRecording = false;
        this.sessionActive = false;
        this.selectedProfile = 'interview';
        this.selectedLanguage = 'en-US';
        this.selectedScreenshotInterval = '5';
        this.selectedImageQuality = 'medium';
        this.layoutMode = 'normal';
        this.responses = [];
        this.currentResponseIndex = -1;
        this._viewInstances = new Map();
        this._isClickThrough = false;
        this._awaitingNewResponse = false;
        this._currentResponseIsComplete = true;
        this.shouldAnimateResponse = false;
        this._storageLoaded = false;
        this._timerInterval = null;
        this._updateAvailable = false;
        this._whisperDownloading = false;
        this._localVersion = '';

        this._loadFromStorage();
        this._checkForUpdates();
    }

    async _checkForUpdates() {
        try {
            this._localVersion = await metaMaxPro.getVersion();
            this.requestUpdate();
        } catch (e) {
            // silently ignore
        }
    }

    async _loadFromStorage() {
        try {
            const [config, prefs] = await Promise.all([
                metaMaxPro.storage.getConfig(),
                metaMaxPro.storage.getPreferences()
            ]);

            // Decide the entry view. Onboarding gates the first run AND any later
            // launch where a required OS permission is missing (e.g. the user
            // revoked Screen Recording) — the app can't work without it.
            const permsOK = await this._permissionsSatisfied();
            if (!config.onboarded) {
                this._onboardingGate = false;
                this.currentView = 'onboarding';
            } else if (!permsOK) {
                this._onboardingGate = true; // jump straight to permissions
                this.currentView = 'onboarding';
            } else {
                this.currentView = 'assistant';
            }
            this.selectedProfile = prefs.selectedProfile || 'interview';
            this.selectedLanguage = prefs.selectedLanguage || 'en-US';
            this.selectedScreenshotInterval = prefs.selectedScreenshotInterval || '5';
            this.selectedImageQuality = prefs.selectedImageQuality || 'medium';
            this.layoutMode = config.layout || 'normal';

            // Apply the saved response font size on startup (this was missing —
            // the setting only took effect after moving the slider).
            const fs = parseInt(prefs.fontSize, 10);
            this._fontSize = Number.isFinite(fs) ? fs : 16;
            document.documentElement.style.setProperty('--response-font-size', `${this._fontSize}px`);

            this._storageLoaded = true;
            this.requestUpdate();

            // Auto-start the session so the chat is immediately usable. If no
            // provider is configured, handleStart bails and the chat shows a
            // "configure in Settings" banner (sessionActive stays false). Skip
            // when we're showing onboarding (first run or permission re-gate).
            if (this.currentView === 'assistant' && !this.sessionActive) {
                this.handleStart();
            }
        } catch (error) {
            console.error('Error loading from storage:', error);
            this._storageLoaded = true;
            this.requestUpdate();
        }
    }

    connectedCallback() {
        super.connectedCallback();

        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            ipcRenderer.on('new-question', (_, question) => this.addQuestion(question));
            ipcRenderer.on('new-response', (_, response) => this.addNewResponse(response));
            ipcRenderer.on('update-response', (_, response) => this.updateCurrentResponse(response));
            ipcRenderer.on('update-status', (_, status) => this.setStatus(status));
            ipcRenderer.on('click-through-toggled', (_, isEnabled) => { this._isClickThrough = isEnabled; });
            ipcRenderer.on('reconnect-failed', (_, data) => this.addNewResponse(data.message));
            ipcRenderer.on('whisper-downloading', (_, downloading) => { this._whisperDownloading = downloading; });
        }

        // If a required permission gets revoked while running, catch it when the
        // window is focused again and route back to onboarding.
        this._onFocus = () => this._recheckPermissionsOnFocus();
        window.addEventListener('focus', this._onFocus);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this._stopTimer();
        if (this._onFocus) window.removeEventListener('focus', this._onFocus);
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            ipcRenderer.removeAllListeners('new-response');
            ipcRenderer.removeAllListeners('update-response');
            ipcRenderer.removeAllListeners('update-status');
            ipcRenderer.removeAllListeners('click-through-toggled');
            ipcRenderer.removeAllListeners('reconnect-failed');
            ipcRenderer.removeAllListeners('whisper-downloading');
        }
    }

    // ── Timer ──

    _startTimer() {
        this._stopTimer();
        if (this.startTime) {
            this._timerInterval = setInterval(() => this.requestUpdate(), 1000);
        }
    }

    _stopTimer() {
        if (this._timerInterval) {
            clearInterval(this._timerInterval);
            this._timerInterval = null;
        }
    }

    getElapsedTime() {
        if (!this.startTime) return '0:00';
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        const h = Math.floor(elapsed / 3600);
        const m = Math.floor((elapsed % 3600) / 60);
        const s = elapsed % 60;
        const pad = n => String(n).padStart(2, '0');
        if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
        return `${m}:${pad(s)}`;
    }

    // ── Status & Responses ──

    setStatus(text) {
        this.statusText = text;
        if (text.includes('Ready') || text.includes('Listening') || text.includes('Error')) {
            this._currentResponseIsComplete = true;
        }
    }

    // Transcribed audio / typed question → a left-aligned chat bubble.
    // The answer generators emit new-question first, then the "..." placeholder,
    // so a simple append keeps the transcript in question → answer order.
    addQuestion(text) {
        if (!text || !String(text).trim()) return;
        this.responses = [...this.responses, { role: 'question', text: String(text).trim() }];
        this.currentResponseIndex = this.responses.length - 1;
        this.requestUpdate();
    }

    addNewResponse(response) {
        // Annotate response for color-coded corrections when applicable
        const annotated = this._annotateResponse(response);
        this.responses = [...this.responses, { role: 'answer', text: annotated }];
        this.currentResponseIndex = this.responses.length - 1;
        this._awaitingNewResponse = false;
        this.requestUpdate();
    }

    updateCurrentResponse(response) {
        const annotated = this._annotateResponse(response);
        const last = this.responses[this.responses.length - 1];
        // Only replace the last entry if it's an answer; never overwrite a question.
        if (last && last.role === 'answer') {
            this.responses = [...this.responses.slice(0, -1), { role: 'answer', text: annotated }];
        } else {
            this.addNewResponse(response);
            return;
        }
        this.requestUpdate();
    }

    /**
     * Annotate response text to apply color classes for code, comments, and corrections.
     * Heuristics:
     * - For fenced code blocks (```), wrap each code line in spans and mark lines starting with + or - as additions/deletions.
     * - Lines starting with common comment tokens are given comment-line class.
     */
    _annotateResponse(raw) {
        if (!raw || typeof raw !== 'string') return raw;

        // Quick failure heuristic: annotate when response contains 'Error' or 'failed' or shows diff markers
        const needsAnnotate = /(^Error:)|\bfailed\b|\bcorrection\b|^[+-]/im.test(raw);
        if (!needsAnnotate && !/```/.test(raw)) return raw;

        // Process fenced code blocks
        return raw.replace(/```(\w*\n)?([\s\S]*?)```/g, (m, langLine, code) => {
            const lang = (langLine || '').trim().replace(/\n$/, '').replace(/^\s*/, '');
            const lines = code.split('\n');
            const transformed = lines.map(line => {
                if (/^\+\s*/.test(line)) {
                    return `<div class="correction addition">${this._escapeHtml(line)}</div>`;
                }
                if (/^-\s*/.test(line)) {
                    return `<div class="correction deletion">${this._escapeHtml(line)}</div>`;
                }
                if (/^\s*(\/\/|#|\/\*|\*)/.test(line)) {
                    return `<div class="comment-line">${this._escapeHtml(line)}</div>`;
                }
                return `<div class="code-line">${this._escapeHtml(line)}</div>`;
            }).join('\n');

            // Rebuild as HTML-wrapped code block — keep language hint for tooling
            return `<pre><code class="language-${lang}">${transformed}</code></pre>`;
        });
    }

    _escapeHtml(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ── Navigation ──

    navigate(view) {
        this.currentView = view;
        this.requestUpdate();
    }

    async handleClose() {
        if (this.currentView === 'assistant') {
            metaMaxPro.stopCapture();
            if (window.require) {
                const { ipcRenderer } = window.require('electron');
                await ipcRenderer.invoke('close-session');
            }
            this.sessionActive = false;
            this._stopTimer();
            this.currentView = 'assistant';
        } else {
            if (window.require) {
                const { ipcRenderer } = window.require('electron');
                await ipcRenderer.invoke('quit-application');
            }
        }
    }

    async _handleMinimize() {
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            // Hide the main window (off taskbar) and show the floating mascot.
            await ipcRenderer.invoke('minimize-to-mascot');
        }
    }

    async _handleQuit() {
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            await ipcRenderer.invoke('quit-application');
        }
    }

    // Adjust the chat response font size from the header (+/-), persist it, and
    // apply it live via the shared --response-font-size CSS variable.
    async _changeFontSize(delta) {
        const current = Number.isFinite(this._fontSize) ? this._fontSize : 16;
        const next = Math.min(32, Math.max(11, current + delta));
        this._fontSize = next;
        document.documentElement.style.setProperty('--response-font-size', `${next}px`);
        this.requestUpdate();
        try { await metaMaxPro.storage.updatePreference('fontSize', next); } catch (_) {}
    }

    async handleHideToggle() {
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            await ipcRenderer.invoke('toggle-window-visibility');
        }
    }

    // ── Session start ──

    async handleStart() {
        const startSession = () => {
            metaMaxPro.startCapture(this.selectedScreenshotInterval, this.selectedImageQuality);
            this.responses = [];
            this.currentResponseIndex = -1;
            this.startTime = Date.now();
            this.sessionActive = true;
            this.currentView = 'assistant';
            this._startTimer();
        };

        // Single unified mode: the user's own keys. Gemini powers live
        // transcription; Groq/Anthropic (from the keys) generate answers and
        // solve screenshots. Requires a Gemini key; otherwise the chat shows
        // the "Session not started · Settings" banner.
        try {
            const apiKey = await metaMaxPro.storage.getApiKey().catch(() => '');
            if (!apiKey || apiKey.trim() === '') {
                this.sessionActive = false;
                this.requestUpdate();
                return;
            }
            await metaMaxPro.storage.updatePreference('providerMode', 'byok');
            await metaMaxPro.initializeGemini(this.selectedProfile, this.selectedLanguage);
            startSession();
        } catch (err) {
            console.error('Error during handleStart:', err);
            this.sessionActive = false;
            this.requestUpdate();
        }
    }

    async handleAPIKeyHelp() {
        // No help page configured
    }

    async handleGroqAPIKeyHelp() {
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            await ipcRenderer.invoke('open-external', 'https://console.groq.com/keys');
        }
    }

    // ── Settings handlers ──

    async handleProfileChange(profile) {
        this.selectedProfile = profile;
        await metaMaxPro.storage.updatePreference('selectedProfile', profile);
    }

    async handleLanguageChange(language) {
        this.selectedLanguage = language;
        await metaMaxPro.storage.updatePreference('selectedLanguage', language);
    }

    async handleScreenshotIntervalChange(interval) {
        this.selectedScreenshotInterval = interval;
        await metaMaxPro.storage.updatePreference('selectedScreenshotInterval', interval);
    }

    async handleImageQualityChange(quality) {
        this.selectedImageQuality = quality;
        await metaMaxPro.storage.updatePreference('selectedImageQuality', quality);
    }

    async handleLayoutModeChange(layoutMode) {
        this.layoutMode = layoutMode;
        await metaMaxPro.storage.updateConfig('layout', layoutMode);
        if (window.require) {
            try {
                const { ipcRenderer } = window.require('electron');
                await ipcRenderer.invoke('update-sizes');
            } catch (error) {
                console.error('Failed to update sizes:', error);
            }
        }
        this.requestUpdate();
    }

    async handleExternalLinkClick(url) {
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            await ipcRenderer.invoke('open-external', url);
        }
    }

    async handleSendText(message) {
        const result = await window.metaMaxPro.sendTextMessage(message);
        if (!result.success) {
            this.setStatus('Error sending message: ' + result.error);
        } else {
            this.setStatus('Message sent...');
            this._awaitingNewResponse = true;
        }
    }

    handleResponseIndexChanged(e) {
        this.currentResponseIndex = e.detail.index;
        this.shouldAnimateResponse = false;
        this.requestUpdate();
    }

    handleOnboardingComplete() {
        this._onboardingGate = false;
        this.currentView = 'assistant';
        this.handleStart();
    }

    // True when every OS permission the app can't work without is granted.
    // On macOS that's Screen Recording (screenshots + system-audio capture);
    // other platforms have no hard gate.
    async _permissionsSatisfied() {
        try {
            if (!window.require) return true;
            const { ipcRenderer } = window.require('electron');
            const status = await ipcRenderer.invoke('permissions:get-status');
            if (!status || status.platform !== 'darwin') return true;
            return status.screen === 'granted';
        } catch (e) {
            // If we can't determine status, don't lock the user out.
            return true;
        }
    }

    // Re-check when the window regains focus: if a required permission was
    // revoked (in System Settings) while we were running, send the user back to
    // onboarding to restore it before continuing.
    async _recheckPermissionsOnFocus() {
        if (this.currentView === 'onboarding') return; // already handling it
        const ok = await this._permissionsSatisfied();
        if (!ok) {
            this.handleClose();
            this._onboardingGate = true;
            this.currentView = 'onboarding';
        }
    }

    updated(changedProperties) {
        super.updated(changedProperties);

        if (changedProperties.has('currentView') && window.require) {
            const { ipcRenderer } = window.require('electron');
            ipcRenderer.send('view-changed', this.currentView);
        }
    }

    // ── Helpers ──

    _isLiveMode() {
        return this.currentView === 'assistant';
    }

    // ── Render ──

    renderCurrentView() {
        switch (this.currentView) {
            case 'onboarding':
                return html`
                    <onboarding-view
                        .gateMode=${!!this._onboardingGate}
                        .onComplete=${() => this.handleOnboardingComplete()}
                        .onClose=${() => this.handleClose()}
                    ></onboarding-view>
                `;

            case 'main':
                return html`
                    <main-view
                        .selectedProfile=${this.selectedProfile}
                        .onProfileChange=${p => this.handleProfileChange(p)}
                        .onNavigate=${v => this.navigate(v)}
                        .onStart=${() => this.handleStart()}
                        .onExternalLink=${url => this.handleExternalLinkClick(url)}
                        .whisperDownloading=${this._whisperDownloading}
                    ></main-view>
                `;

            case 'settings':
                return this.renderSettings();

            case 'assistant':
                return html`
                    <assistant-view
                        .responses=${this.responses}
                        .currentResponseIndex=${this.currentResponseIndex}
                        .selectedProfile=${this.selectedProfile}
                        .sessionActive=${this.sessionActive}
                        .onSendText=${msg => this.handleSendText(msg)}
                        .onProfileChange=${p => this.handleProfileChange(p)}
                        .onStart=${() => this.handleStart()}
                        .onOpenSettings=${() => this.openSettings()}
                        .shouldAnimateResponse=${this.shouldAnimateResponse}
                        @response-index-changed=${this.handleResponseIndexChanged}
                        @response-animation-complete=${() => {
                            this.shouldAnimateResponse = false;
                            this._currentResponseIsComplete = true;
                            this.requestUpdate();
                        }}
                    ></assistant-view>
                `;

            default:
                return html`<div>Unknown view: ${this.currentView}</div>`;
        }
    }

    openSettings(tab = 'preferences') {
        this.settingsTab = tab;
        this.currentView = 'settings';
        this.requestUpdate();
    }

    renderSettingsSection() {
        switch (this.settingsTab) {
            case 'profile':
                return html`<ai-customize-view
                    .selectedProfile=${this.selectedProfile}
                    .onProfileChange=${p => this.handleProfileChange(p)}
                ></ai-customize-view>`;
            case 'api-keys':
                return html`<api-keys-view></api-keys-view>`;
            case 'history':
                return html`<history-view></history-view>`;
            case 'help':
                return html`
                    <help-view .onExternalLinkClick=${url => this.handleExternalLinkClick(url)}></help-view>
                    <feedback-view></feedback-view>
                `;
            case 'preferences':
            default:
                return html`<customize-view
                    .selectedProfile=${this.selectedProfile}
                    .selectedLanguage=${this.selectedLanguage}
                    .selectedScreenshotInterval=${this.selectedScreenshotInterval}
                    .selectedImageQuality=${this.selectedImageQuality}
                    .layoutMode=${this.layoutMode}
                    .onProfileChange=${p => this.handleProfileChange(p)}
                    .onLanguageChange=${l => this.handleLanguageChange(l)}
                    .onScreenshotIntervalChange=${i => this.handleScreenshotIntervalChange(i)}
                    .onImageQualityChange=${q => this.handleImageQualityChange(q)}
                    .onLayoutModeChange=${lm => this.handleLayoutModeChange(lm)}
                ></customize-view>`;
        }
    }

    renderSettings() {
        const tabs = [
            { id: 'preferences', label: 'Settings' },
            { id: 'profile', label: 'Profile' },
            { id: 'api-keys', label: 'API Keys' },
            { id: 'history', label: 'History' },
            { id: 'help', label: 'Help' },
        ];
        return html`
            <div class="settings-shell">
                <div class="settings-tabbar">
                    <button class="settings-tab home" @click=${() => this.navigate('assistant')} title="Back to chat">‹ Chat</button>
                    ${tabs.map(t => html`
                        <button
                            class="settings-tab ${this.settingsTab === t.id ? 'active' : ''}"
                            @click=${() => { this.settingsTab = t.id; }}
                        >${t.label}</button>
                    `)}
                </div>
                <div class="settings-body">
                    ${this.renderSettingsSection()}
                </div>
            </div>
        `;
    }

    renderSidebar() {
        const items = [
            { id: 'main', label: 'Home', icon: html`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="m19 8.71l-5.333-4.148a2.666 2.666 0 0 0-3.274 0L5.059 8.71a2.67 2.67 0 0 0-1.029 2.105v7.2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.2c0-.823-.38-1.6-1.03-2.105"/><path d="M16 15c-2.21 1.333-5.792 1.333-8 0"/></g></svg>` },
            { id: 'ai-customize', label: 'AI Customization', icon: html`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 3v7h6l-8 11v-7H5z" /></svg>` },
            { id: 'history', label: 'History', icon: html`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M10 20.777a9 9 0 0 1-2.48-.969M14 3.223a9.003 9.003 0 0 1 0 17.554m-9.421-3.684a9 9 0 0 1-1.227-2.592M3.124 10.5c.16-.95.468-1.85.9-2.675l.169-.305m2.714-2.941A9 9 0 0 1 10 3.223"/><path d="M12 8v4l3 3"/></g></svg>` },
            { id: 'customize', label: 'Settings', icon: html`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M19.875 6.27A2.23 2.23 0 0 1 21 8.218v7.284c0 .809-.443 1.555-1.158 1.948l-6.75 4.27a2.27 2.27 0 0 1-2.184 0l-6.75-4.27A2.23 2.23 0 0 1 3 15.502V8.217c0-.809.443-1.554 1.158-1.947l6.75-3.98a2.33 2.33 0 0 1 2.25 0l6.75 3.98z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0"/></g></svg>` },
            { id: 'feedback', label: 'Feedback', icon: html`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-5l-5 3v-3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM9.5 9h.01m4.99 0h.01"/><path d="M9.5 13a3.5 3.5 0 0 0 5 0"/></g></svg>` },
            { id: 'help', label: 'Help', icon: html`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M12 3c7.2 0 9 1.8 9 9s-1.8 9-9 9s-9-1.8-9-9s1.8-9 9-9m0 13v.01"/><path d="M12 13a2 2 0 0 0 .914-3.782a1.98 1.98 0 0 0-2.414.483"/></g></svg>` },
        ];

    // When on the main view, MainView renders its own nav and controls.
    // Avoid duplicating the navigation here.
    if (this.currentView === 'main') return '';

        return html`
            <div class="bottom-nav ${this._isLiveMode() ? 'hidden' : ''}">
                <div class="bottom-nav-inner">
                    ${items.map(item => html`
                        <button
                            class="nav-item ${this.currentView === item.id ? 'active' : ''}"
                            @click=${() => this.navigate(item.id)}
                            title=${item.label}
                        >
                            ${item.icon}
                            <div style="font-size:12px;">${item.label}</div>
                        </button>
                    `)}
                </div>
            </div>
        `;
    }

    renderLiveBar() {
        if (!this._isLiveMode()) return '';

        const profileLabels = {
            interview: 'Interview',
            behavioral: 'Behavioral Interview',
            coding: 'Coding Interview',
            system_design: 'System Design',
            case: 'Case Interview',
            sales: 'Sales Call',
            meeting: 'Meeting',
            presentation: 'Presentation',
            negotiation: 'Negotiation',
            exam: 'Exam',
            assistant: 'Assistant',
        };

        return html`
            <div class="live-bar">
                <div class="live-bar-left">
                    <span class="live-bar-text">${profileLabels[this.selectedProfile] || 'Session'}</span>
                </div>
                <div class="live-bar-center"></div>
                <div class="live-bar-right">
                    ${this.statusText ? html`<span class="live-bar-text">${this.statusText}</span>` : ''}
                    <span class="live-bar-text">${this.getElapsedTime()}</span>
                    ${this._isClickThrough ? html`<span class="live-bar-text">[click through]</span>` : ''}
                    <button class="win-btn font-btn" @click=${() => this._changeFontSize(-1)} title="Smaller text">A−</button>
                    <button class="win-btn font-btn" @click=${() => this._changeFontSize(1)} title="Larger text">A+</button>
                    <button class="win-btn" @click=${() => this._handleMinimize()} title="Minimize to mascot">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    </button>
                    <button class="win-btn close" @click=${() => this._handleQuit()} title="Close">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>
                    </button>
                </div>
            </div>
        `;
    }

    render() {
        // Onboarding is fullscreen, no sidebar
        if (this.currentView === 'onboarding') {
            return html`
                <div class="fullscreen">
                    ${this.renderCurrentView()}
                </div>
            `;
        }

        const isLive = this._isLiveMode();

        return html`
            <div class="app-shell">
                <div class="top-drag-bar ${isLive ? 'hidden' : ''}">
                    <div class="traffic-lights">
                        <button class="traffic-light close" @click=${() => this.handleClose()} title="Close"></button>
                        <button class="traffic-light minimize" @click=${() => this._handleMinimize()} title="Minimize"></button>
                        <button class="traffic-light maximize" title="Maximize"></button>
                    </div>
                    <div class="drag-region"></div>
                </div>
                <div class="content">
                    ${isLive ? this.renderLiveBar() : ''}
                    <div class="content-inner ${isLive ? 'live' : ''}">
                        ${this.renderCurrentView()}
                    </div>
                </div>
            </div>
        `;
    }
}

customElements.define('meta-max-pro-app', MetaMaxProApp);
