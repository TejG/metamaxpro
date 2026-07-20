import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

/**
 * Two-pane, step-by-step onboarding.
 *  - Left pane: brand (mascot + name), the current step's title/subtitle, and the
 *    Continue/Back controls + terms.
 *  - Right pane: the current step's instructions (permissions, shortcuts, context).
 *
 * Permissions are GATED: on macOS the user cannot leave the permissions step until
 * Screen Recording is granted (the app can't see the screen or capture audio
 * without it). Status is polled so the gate opens the moment it's granted in
 * System Settings. `gateMode` is used when we re-show onboarding because a
 * required permission was revoked — it jumps straight to permissions and finishes
 * as soon as they're restored, without repeating the rest of the flow.
 */
export class OnboardingView extends LitElement {
    static styles = css`
        * {
            font-family: var(--font);
            cursor: default;
            user-select: none;
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        :host {
            display: block;
            height: 100%;
            width: 100%;
            position: fixed;
            top: 0;
            left: 0;
            overflow: hidden;
        }

        .onboarding {
            width: 100%;
            height: 100%;
            display: flex;
            background: #0a0a0c;
            color: #f2f2f4;
            border-radius: 12px;
            overflow: hidden;
            /* Frameless window has no title bar — let the user drag it aside
               (needed during onboarding to reach System Settings). Interactive
               controls opt out with -webkit-app-region: no-drag below. */
            -webkit-app-region: drag;
        }

        .btn-primary,
        .btn-back,
        .btn-ghost,
        .context-input,
        .card-actions {
            -webkit-app-region: no-drag;
        }

        /* ── Left pane: brand + step controls ── */
        .pane-left {
            flex: 0 0 42%;
            max-width: 460px;
            display: flex;
            flex-direction: column;
            padding: 32px 36px;
            border-right: 1px solid rgba(255, 255, 255, 0.06);
        }

        .brand {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .brand-logo {
            width: 32px;
            height: 32px;
            object-fit: contain;
        }

        .brand-name {
            font-size: 20px;
            font-weight: 700;
            letter-spacing: -0.01em;
        }

        .left-body {
            flex: 1 1 auto;
            display: flex;
            flex-direction: column;
            justify-content: center;
            gap: 14px;
        }

        .left-title {
            font-size: 32px;
            font-weight: 700;
            line-height: 1.1;
            letter-spacing: -0.02em;
        }

        .left-sub {
            font-size: 14px;
            line-height: 1.55;
            color: #9a9aa2;
            max-width: 340px;
        }

        .left-actions {
            display: flex;
            flex-direction: column;
            gap: 10px;
            margin-top: 8px;
            max-width: 340px;
        }

        .btn-primary {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            width: 100%;
            background: linear-gradient(180deg, #6ea8ff 0%, #4f8cf5 100%);
            border: none;
            color: #ffffff;
            padding: 13px 24px;
            border-radius: 12px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: opacity 0.15s, filter 0.15s;
        }

        .btn-primary:hover {
            filter: brightness(1.06);
        }

        .btn-primary[disabled] {
            opacity: 0.4;
            cursor: not-allowed;
            filter: none;
        }

        .btn-back {
            background: none;
            border: none;
            color: #8a8a92;
            font-size: 13px;
            cursor: pointer;
            padding: 6px;
            align-self: center;
        }

        .btn-back:hover {
            color: #c8c8ce;
        }

        .gate-hint {
            font-size: 12px;
            color: #d8a24a;
            line-height: 1.4;
            max-width: 340px;
        }

        .terms {
            font-size: 11px;
            line-height: 1.5;
            color: #6c6c74;
        }

        .steps-dots {
            display: flex;
            gap: 6px;
            margin-bottom: 16px;
        }

        .dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.15);
            transition: background 0.2s, width 0.2s;
        }

        .dot.active {
            width: 20px;
            border-radius: 4px;
            background: #4f8cf5;
        }

        .dot.done {
            background: #1c8a4e;
        }

        /* ── Right pane: step content ── */
        .pane-right {
            flex: 1 1 auto;
            padding: 40px 44px;
            display: flex;
            flex-direction: column;
            justify-content: center;
            gap: 14px;
            background:
                radial-gradient(120% 120% at 100% 0%, rgba(79, 140, 245, 0.08) 0%, transparent 55%),
                linear-gradient(rgba(255, 255, 255, 0.025) 1px, transparent 1px) 0 0 / 100% 34px,
                #0c0c10;
            overflow-y: auto;
        }

        .right-eyebrow {
            font-size: 12px;
            font-weight: 600;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: #6f7bd8;
        }

        .right-heading {
            font-size: 20px;
            font-weight: 600;
        }

        .card-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-top: 4px;
        }

        .card {
            display: flex;
            align-items: center;
            gap: 14px;
            padding: 14px 16px;
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 12px;
            background: rgba(255, 255, 255, 0.03);
        }

        .card.ok {
            border-color: rgba(34, 160, 90, 0.4);
            background: rgba(34, 160, 90, 0.06);
        }

        .card-icon {
            flex: 0 0 40px;
            width: 40px;
            height: 40px;
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(255, 255, 255, 0.06);
            font-size: 19px;
        }

        .card-body { flex: 1 1 auto; min-width: 0; }

        .card-title {
            font-size: 14px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .card-desc {
            font-size: 12px;
            line-height: 1.45;
            color: #9a9aa2;
            margin-top: 3px;
        }

        .status-pill {
            font-size: 10px;
            font-weight: 700;
            padding: 2px 8px;
            border-radius: 999px;
            white-space: nowrap;
            text-transform: uppercase;
            letter-spacing: 0.03em;
        }

        .status-pill.granted { background: rgba(34, 160, 90, 0.2); color: #4fd88b; }
        .status-pill.needed { background: rgba(210, 150, 40, 0.18); color: #e0a94a; }

        .card-actions { flex: 0 0 auto; display: flex; gap: 6px; }

        .btn-ghost {
            background: rgba(255, 255, 255, 0.08);
            border: none;
            color: #f2f2f4;
            padding: 7px 13px;
            border-radius: 8px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            white-space: nowrap;
            transition: background 0.15s;
        }

        .btn-ghost:hover { background: rgba(255, 255, 255, 0.16); }

        /* Shortcut rows */
        .shortcut-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 14px 16px;
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 12px;
            background: rgba(255, 255, 255, 0.03);
        }

        .shortcut-label { font-size: 14px; font-weight: 600; }
        .shortcut-sub { font-size: 12px; color: #9a9aa2; margin-top: 3px; }

        .keys { display: flex; align-items: center; gap: 5px; flex: 0 0 auto; }

        .key {
            min-width: 28px;
            height: 28px;
            padding: 0 8px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border-radius: 7px;
            background: rgba(255, 255, 255, 0.14);
            color: #ffffff;
            font-size: 14px;
            font-weight: 600;
        }

        .feature {
            display: flex;
            gap: 12px;
            align-items: flex-start;
        }

        .feature-dot {
            flex: 0 0 8px;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            margin-top: 6px;
            background: #4f8cf5;
        }

        .feature-text { font-size: 13px; line-height: 1.5; color: #c8c8ce; }

        .context-input {
            width: 100%;
            min-height: 160px;
            padding: 14px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            background: rgba(255, 255, 255, 0.03);
            color: #f2f2f4;
            font-size: 13px;
            font-family: var(--font);
            line-height: 1.5;
            resize: vertical;
        }

        .context-input::placeholder { color: #6c6c74; }
        .context-input:focus { outline: none; border-color: rgba(79, 140, 245, 0.6); }

        .help-note {
            margin-top: 6px;
            padding: 12px 14px;
            border: 1px dashed rgba(255, 255, 255, 0.12);
            border-radius: 10px;
            background: rgba(255, 255, 255, 0.02);
        }

        .help-title { font-size: 12px; font-weight: 600; color: #d8d8de; }
        .help-desc { font-size: 11px; line-height: 1.45; color: #9a9aa2; margin-top: 3px; }

        .cmd-row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 8px;
        }

        .cmd {
            flex: 1 1 auto;
            min-width: 0;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 11px;
            color: #cfe0ff;
            background: rgba(0, 0, 0, 0.35);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 7px;
            padding: 7px 10px;
            overflow-x: auto;
            white-space: nowrap;
            -webkit-app-region: no-drag;
            user-select: text;
        }
    `;

    static properties = {
        currentSlide: { type: Number },
        contextText: { type: String },
        onComplete: { type: Function },
        onClose: { type: Function },
        permStatus: { type: Object },
        gateMode: { type: Boolean },
        initialSlide: { type: Number },
    };

    constructor() {
        super();
        this.currentSlide = 0;
        this.contextText = '';
        this.onComplete = () => {};
        this.onClose = () => {};
        this.gateMode = false;
        this.initialSlide = 0;
        this.isMac = (typeof process !== 'undefined') && process.platform === 'darwin';
        this.isWindows = (typeof process !== 'undefined') && process.platform === 'win32';
        this.permStatus = { platform: this.isMac ? 'darwin' : 'other', screen: 'unknown', microphone: 'unknown' };
        this._pollTimer = null;
        // On macOS Sequoia (15+), a freshly-granted Screen Recording permission
        // does NOT take effect for the already-running process — the app must
        // be quit and reopened, or screenshare/system-audio capture silently
        // fails despite the permission showing "granted". We track the status
        // we started with so we can detect that transition and require a
        // restart instead of silently unlocking.
        this._screenStatusAtLaunch = null;
        this._needsRestartForScreen = false;
    }

    firstUpdated() {
        this.currentSlide = this.gateMode ? 1 : (this.initialSlide || 0);
        this.refreshPermissions();
        
        // If starting on or advancing to the permissions slide, request screen
        // recording permission immediately so the user sees the native prompt
        // before we start polling. This ensures the prompt appears while the
        // window is visible and the user understands why we need it.
        if (this.currentSlide === 1) {
            this.requestScreenPermissionIfNeeded();
        }
        
        // Keep permission status live so the gate opens right after the user
        // grants access in System Settings.
        this._pollTimer = setInterval(() => this.refreshPermissions(), 1500);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        if (this._pollTimer) clearInterval(this._pollTimer);
    }

    get _ipc() {
        try { return require('electron').ipcRenderer; } catch (_) { return null; }
    }

    // Screen Recording is the hard gate on macOS — the app genuinely can't work
    // without it (screenshots + system-audio capture). Microphone is strongly
    // recommended but skippable: on an unsigned build macOS TCC can make it
    // impossible to grant, and we don't want users permanently stranded (speaker
    // -only mode still works). They can enable it later in Settings.
    get requiredGranted() {
        if (!this.isMac) return true;
        return this.permStatus.screen === 'granted' && !this._needsRestartForScreen;
    }

    get micPending() {
        return this.isMac && this.permStatus.microphone !== 'granted';
    }

    async refreshPermissions() {
        const ipc = this._ipc;
        if (!ipc) return;
        try {
            const status = await ipc.invoke('permissions:get-status');
            if (status) {
                // Remember the status we first observed this launch so we can
                // detect a not-granted → granted transition below.
                if (this._screenStatusAtLaunch === null) {
                    this._screenStatusAtLaunch = status.screen;
                }
                // If Screen Recording just became granted *during this run* (it
                // wasn't granted when we started), macOS Sequoia+ requires a
                // full app restart before capture actually works — flag it
                // instead of letting the gate silently unlock.
                if (this.isMac && this._screenStatusAtLaunch !== 'granted' && status.screen === 'granted') {
                    this._needsRestartForScreen = true;
                }
                this.permStatus = status;
            }
        } catch (e) {
            console.error('Failed to load permission status:', e);
        }
    }

    async restartApp() {
        const ipc = this._ipc;
        if (!ipc) return;
        try { await ipc.invoke('app:relaunch'); } catch (e) { console.error('Failed to relaunch app:', e); }
    }

    async requestScreenPermissionIfNeeded() {
        // Only request on macOS and only if we haven't already granted it
        if (!this.isMac || this.permStatus.screen === 'granted') return;
        
        const ipc = this._ipc;
        if (!ipc) return;
        
        try {
            console.log('[Onboarding] Requesting screen recording permission...');
            await ipc.invoke('permissions:request-screen');
            // Refresh status after requesting
            setTimeout(() => this.refreshPermissions(), 500);
        } catch (e) {
            console.error('[Onboarding] Failed to request screen recording permission:', e);
        }
    }

    async openSettings(which) {
        const ipc = this._ipc;
        if (ipc) await ipc.invoke('permissions:open-settings', which);
        setTimeout(() => this.refreshPermissions(), 1000);
    }

    async requestMic() {
        const ipc = this._ipc;
        if (ipc) await ipc.invoke('permissions:request-microphone');
        this.refreshPermissions();
    }

    // The reliable way to get an unsigned build past macOS Gatekeeper/TCC:
    // move it to /Applications and strip the download quarantine flag. Copy the
    // exact command so the user can paste it into Terminal.
    _quarantineCmd = 'xattr -dr com.apple.quarantine /Applications/MetaQuest.app';

    _copyQuarantineCmd() {
        try { require('electron').clipboard.writeText(this._quarantineCmd); } catch (_) {}
        this._copied = true;
        this.requestUpdate();
        setTimeout(() => { this._copied = false; this.requestUpdate(); }, 1500);
    }

    handleContextInput(e) {
        this.contextText = e.target.value;
    }

    async completeOnboarding() {
        if (this.contextText.trim()) {
            await metaMaxPro.storage.updatePreference('customPrompt', this.contextText.trim());
        }
        await metaMaxPro.storage.updateConfig('onboarded', true);
        this.onComplete();
    }

    // Advance from the current step. In gateMode we finish as soon as the
    // required permission is granted (no need to repeat shortcuts/context).
    next() {
        if (this.gateMode) { this.completeOnboarding(); return; }
        if (this.currentSlide >= 3) { this.completeOnboarding(); return; }
        
        const nextSlide = this.currentSlide + 1;
        this.currentSlide = nextSlide;
        
        // If advancing to the permissions slide, request screen recording
        // permission so the user sees the native prompt immediately.
        if (nextSlide === 1) {
            this.requestScreenPermissionIfNeeded();
        }
    }

    back() {
        if (this.currentSlide > 0) this.currentSlide = this.currentSlide - 1;
    }

    _statusPill(status) {
        const granted = status === 'granted';
        return html`<span class="status-pill ${granted ? 'granted' : 'needed'}">${granted ? 'Granted' : 'Needs access'}</span>`;
    }

    _keys(combo) {
        return html`<div class="keys">${combo.map(k => html`<span class="key">${k}</span>`)}</div>`;
    }

    // ── Left pane copy per step ──
    _leftCopy() {
        switch (this.currentSlide) {
            case 1: return {
                title: this.gateMode ? 'Permission needed' : 'Enable permissions',
                sub: this.isMac
                    ? 'MetaQuest needs macOS permission to see your screen and hear meeting audio. Grant it on the right to continue.'
                    : 'Allow microphone access so MetaQuest can hear your questions.',
            };
            case 2: return { title: 'Two shortcuts to know', sub: 'These work globally — even when MetaQuest is hidden or another window is focused.' };
            case 3: return { title: 'Add context', sub: 'Optional. Paste your resume, a job description, or notes so answers are tailored to you.' };
            default: return { title: 'Welcome to MetaQuest', sub: 'Your real-time AI assistant — it sees your screen, listens to meetings, and answers in context.' };
        }
    }

    _primaryLabel() {
        if (this.gateMode) return 'Continue';
        if (this.currentSlide === 3) return 'Get Started';
        return 'Continue';
    }

    // ── Right pane content per step ──
    renderRight() {
        switch (this.currentSlide) {
            case 1: return this.renderPermissions();
            case 2: return this.renderShortcuts();
            case 3: return this.renderContext();
            default: return this.renderWelcome();
        }
    }

    renderWelcome() {
        return html`
            <div class="right-eyebrow">What you get</div>
            <div class="right-heading">Always ready to help</div>
            <div class="card-list">
                <div class="feature"><div class="feature-dot"></div><div class="feature-text"><b>Sees your screen.</b> Ask anything about what's in front of you and get an instant answer.</div></div>
                <div class="feature"><div class="feature-dot"></div><div class="feature-text"><b>Listens to meetings.</b> Live transcription and context-aware replies during interviews and calls.</div></div>
                <div class="feature"><div class="feature-dot"></div><div class="feature-text"><b>Stays invisible.</b> A quiet overlay you toggle with a keystroke — no breaking flow.</div></div>
            </div>
        `;
    }

    renderPermissions() {
        const mic = this.permStatus.microphone;
        const screen = this.permStatus.screen;

        const macCards = html`
            <div class="card ${screen === 'granted' ? 'ok' : ''}">
                <div class="card-icon">🎬</div>
                <div class="card-body">
                    <div class="card-title">Screen Recording ${this._statusPill(screen)}</div>
                    <div class="card-desc">Required. Lets MetaQuest see your screen and capture meeting audio.</div>
                </div>
                <div class="card-actions">
                    <button class="btn-ghost" @click=${() => this.openSettings('screen')}>Open Settings</button>
                </div>
            </div>
            <div class="card ${mic === 'granted' ? 'ok' : ''}">
                <div class="card-icon">🎙️</div>
                <div class="card-body">
                    <div class="card-title">Microphone ${this._statusPill(mic)}</div>
                    <div class="card-desc">Recommended. Lets MetaQuest hear you in “mic” and “both” audio modes. You can add this later.</div>
                </div>
                <div class="card-actions">
                    <button class="btn-ghost" @click=${() => this.requestMic()}>Allow</button>
                    <button class="btn-ghost" @click=${() => this.openSettings('microphone')}>Open Settings</button>
                </div>
            </div>
        `;

        const winCards = html`
            <div class="card ${mic === 'granted' ? 'ok' : ''}">
                <div class="card-icon">🎙️</div>
                <div class="card-body">
                    <div class="card-title">Microphone</div>
                    <div class="card-desc">Allow microphone access so MetaQuest can hear your questions.</div>
                </div>
                <div class="card-actions">
                    <button class="btn-ghost" @click=${() => this.openSettings('microphone')}>Open Settings</button>
                </div>
            </div>
            <div class="card ok">
                <div class="card-icon">🖥️</div>
                <div class="card-body">
                    <div class="card-title">Screen &amp; audio capture ${this._statusPill('granted')}</div>
                    <div class="card-desc">No extra permission needed on Windows — capture starts automatically.</div>
                </div>
            </div>
        `;

        return html`
            <div class="right-eyebrow">Step ${this.gateMode ? '' : '2 of 4'}</div>
            <div class="right-heading">Grant access to continue</div>
            <div class="card-list">${this.isMac ? macCards : winCards}</div>
            ${this.isMac ? html`
                <div class="help-note">
                    <div class="help-title">Not seeing MetaQuest in the list, or nothing happens?</div>
                    <div class="help-desc">Move MetaQuest to your Applications folder, run this in Terminal to clear the download quarantine, then relaunch:</div>
                    <div class="cmd-row">
                        <code class="cmd">${this._quarantineCmd}</code>
                        <button class="btn-ghost" @click=${() => this._copyQuarantineCmd()}>${this._copied ? 'Copied' : 'Copy'}</button>
                    </div>
                </div>
            ` : ''}
        `;
    }

    renderShortcuts() {
        const mod = this.isMac ? '⌘' : 'Ctrl';
        return html`
            <div class="right-eyebrow">Step 3 of 4</div>
            <div class="right-heading">Work hands-free</div>
            <div class="card-list">
                <div class="shortcut-row">
                    <div>
                        <div class="shortcut-label">Show / hide the app</div>
                        <div class="shortcut-sub">Instantly toggle the overlay out of sight.</div>
                    </div>
                    ${this._keys([mod, '\\'])}
                </div>
                <div class="shortcut-row">
                    <div>
                        <div class="shortcut-label">Answer now</div>
                        <div class="shortcut-sub">Analyze what's on screen and reply immediately.</div>
                    </div>
                    ${this._keys([mod, '↵'])}
                </div>
            </div>
        `;
    }

    renderContext() {
        return html`
            <div class="right-eyebrow">Step 4 of 4</div>
            <div class="right-heading">Make it yours</div>
            <textarea
                class="context-input"
                placeholder="Resume, job description, notes..."
                .value=${this.contextText}
                @input=${this.handleContextInput}
            ></textarea>
        `;
    }

    render() {
        const copy = this._leftCopy();
        const gateBlocked = this.currentSlide === 1 && !this.requiredGranted;
        const showBack = !this.gateMode && this.currentSlide > 0;
        const totalSteps = 4;

        return html`
            <div class="onboarding">
                <div class="pane-left">
                    <div class="brand">
                        <img class="brand-logo" src="assets/mascot/max.svg" alt="MetaQuest" />
                        <span class="brand-name">MetaQuest</span>
                    </div>

                    <div class="left-body">
                        ${this.gateMode ? '' : html`
                            <div class="steps-dots">
                                ${Array.from({ length: totalSteps }, (_, i) => html`
                                    <div class="dot ${i === this.currentSlide ? 'active' : ''} ${i < this.currentSlide ? 'done' : ''}"></div>
                                `)}
                            </div>
                        `}
                        <h1 class="left-title">${copy.title}</h1>
                        <p class="left-sub">${copy.sub}</p>

                        ${gateBlocked ? html`
                            <div class="gate-hint">
                                ${this._needsRestartForScreen
                                    ? '✅ Screen Recording granted — MetaQuest needs to restart for it to take effect (required on newer macOS versions).'
                                    : '⚠ Screen Recording is required. Enable it for MetaQuest in Settings, then return here — this unlocks automatically.'}
                            </div>
                        ` : ''}
                        ${(this.currentSlide === 1 && !gateBlocked && this.micPending) ? html`<div class="gate-hint">Microphone isn't granted yet. It's recommended, but you can continue and add it later in Settings.</div>` : ''}

                        <div class="left-actions">
                            ${this._needsRestartForScreen ? html`
                                <button class="btn-primary" @click=${() => this.restartApp()}>Restart MetaQuest →</button>
                            ` : html`
                                <button class="btn-primary" ?disabled=${gateBlocked} @click=${() => this.next()}>
                                    ${this.currentSlide === 1 && this.micPending && !gateBlocked ? 'Skip for now' : this._primaryLabel()} ${gateBlocked ? '' : '→'}
                                </button>
                            `}
                            ${showBack ? html`<button class="btn-back" @click=${() => this.back()}>Back</button>` : ''}
                        </div>
                    </div>

                    <div class="terms">By continuing you agree to our Terms of Service and Privacy Policy.</div>
                </div>

                <div class="pane-right">
                    ${this.renderRight()}
                </div>
            </div>
        `;
    }
}

customElements.define('onboarding-view', OnboardingView);
