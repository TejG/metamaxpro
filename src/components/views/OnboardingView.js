import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

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
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 12px;
            border: 1px solid rgba(0, 0, 0, 0.08);
            overflow: hidden;
            background: #f0f0f0;
        }

        canvas.aurora {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 0;
        }

        canvas.dither {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 1;
            opacity: 0.12;
            mix-blend-mode: overlay;
            pointer-events: none;
            image-rendering: pixelated;
        }

        .slide {
            position: relative;
            z-index: 2;
            display: flex;
            flex-direction: column;
            align-items: center;
            text-align: center;
            max-width: 400px;
            padding: var(--space-xl);
            gap: var(--space-md);
        }

        .slide-title {
            font-size: 28px;
            font-weight: 600;
            color: #111111;
            line-height: 1.2;
        }

        .slide-text {
            font-size: 13px;
            line-height: 1.5;
            color: #666666;
        }

        .context-input {
            width: 100%;
            min-height: 120px;
            padding: 12px;
            border: 1px solid rgba(0, 0, 0, 0.12);
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.7);
            backdrop-filter: blur(8px);
            color: #111111;
            font-size: 13px;
            font-family: var(--font);
            line-height: 1.5;
            resize: vertical;
            text-align: left;
        }

        .context-input::placeholder {
            color: #999999;
        }

        .context-input:focus {
            outline: none;
            border-color: rgba(0, 0, 0, 0.3);
        }

        .actions {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 8px;
            margin-top: 8px;
        }

        .btn-primary {
            background: #111111;
            border: none;
            color: #ffffff;
            padding: 10px 32px;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: opacity 0.15s;
        }

        .btn-primary:hover {
            opacity: 0.85;
        }

        .btn-back {
            background: none;
            border: none;
            color: #888888;
            font-size: 11px;
            cursor: pointer;
            padding: 4px 8px;
        }

        .btn-back:hover {
            color: #555555;
        }

        .slide-wide {
            max-width: 460px;
        }

        /* Permission + shortcut cards */
        .card-list {
            display: flex;
            flex-direction: column;
            gap: 10px;
            width: 100%;
            margin-top: 4px;
        }

        .card {
            display: flex;
            align-items: center;
            gap: 12px;
            width: 100%;
            padding: 12px 14px;
            border: 1px solid rgba(0, 0, 0, 0.1);
            border-radius: 10px;
            background: rgba(255, 255, 255, 0.65);
            backdrop-filter: blur(8px);
            text-align: left;
        }

        .card-icon {
            flex: 0 0 34px;
            width: 34px;
            height: 34px;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0, 0, 0, 0.06);
            font-size: 17px;
        }

        .card-body {
            flex: 1 1 auto;
            min-width: 0;
        }

        .card-title {
            font-size: 13px;
            font-weight: 600;
            color: #111111;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .card-desc {
            font-size: 11px;
            line-height: 1.4;
            color: #666666;
            margin-top: 2px;
        }

        .status-pill {
            font-size: 10px;
            font-weight: 600;
            padding: 2px 8px;
            border-radius: 999px;
            white-space: nowrap;
        }

        .status-pill.granted {
            background: rgba(34, 160, 90, 0.15);
            color: #1c8a4e;
        }

        .status-pill.needed {
            background: rgba(210, 140, 20, 0.15);
            color: #b5760a;
        }

        .card-actions {
            flex: 0 0 auto;
            display: flex;
            gap: 6px;
        }

        .btn-ghost {
            background: rgba(0, 0, 0, 0.06);
            border: none;
            color: #111111;
            padding: 6px 12px;
            border-radius: 7px;
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            white-space: nowrap;
            transition: background 0.15s;
        }

        .btn-ghost:hover {
            background: rgba(0, 0, 0, 0.12);
        }

        /* Keyboard shortcut rows */
        .shortcut-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            width: 100%;
            padding: 12px 14px;
            border: 1px solid rgba(0, 0, 0, 0.1);
            border-radius: 10px;
            background: rgba(255, 255, 255, 0.65);
            backdrop-filter: blur(8px);
            text-align: left;
        }

        .shortcut-label {
            font-size: 13px;
            font-weight: 500;
            color: #111111;
        }

        .shortcut-sub {
            font-size: 11px;
            color: #666666;
            margin-top: 2px;
        }

        .keys {
            display: flex;
            align-items: center;
            gap: 4px;
            flex: 0 0 auto;
        }

        .key {
            min-width: 26px;
            height: 26px;
            padding: 0 7px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border-radius: 6px;
            background: #111111;
            color: #ffffff;
            font-size: 13px;
            font-weight: 600;
            box-shadow: 0 1px 0 rgba(0, 0, 0, 0.25);
        }

        .hint {
            font-size: 11px;
            color: #888888;
            margin-top: 2px;
        }
    `;

    static properties = {
        currentSlide: { type: Number },
        contextText: { type: String },
        onComplete: { type: Function },
        permStatus: { type: Object },
    };

    constructor() {
        super();
        this.currentSlide = 0;
        this.contextText = '';
        this.onComplete = () => {};
        this._animId = null;
        this._time = 0;
        this.isMac = (typeof process !== 'undefined') && process.platform === 'darwin';
        this.isWindows = (typeof process !== 'undefined') && process.platform === 'win32';
        this.permStatus = { screen: 'unknown', microphone: 'unknown' };
    }

    firstUpdated() {
        this._startAurora();
        this._drawDither();
        this.refreshPermissions();
    }

    get _ipc() {
        try { return require('electron').ipcRenderer; } catch (_) { return null; }
    }

    async refreshPermissions() {
        const ipc = this._ipc;
        if (!ipc) return;
        try {
            const status = await ipc.invoke('permissions:get-status');
            if (status) this.permStatus = status;
        } catch (e) {
            console.error('Failed to load permission status:', e);
        }
    }

    async openSettings(which) {
        const ipc = this._ipc;
        if (ipc) await ipc.invoke('permissions:open-settings', which);
        // Re-check shortly after the user visits Settings.
        setTimeout(() => this.refreshPermissions(), 1200);
    }

    async requestMic() {
        const ipc = this._ipc;
        if (ipc) await ipc.invoke('permissions:request-microphone');
        this.refreshPermissions();
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        if (this._animId) cancelAnimationFrame(this._animId);
    }

    _drawDither() {
        const canvas = this.shadowRoot.querySelector('canvas.dither');
        if (!canvas) return;
        const blockSize = 5;
        const cols = Math.ceil(canvas.offsetWidth / blockSize);
        const rows = Math.ceil(canvas.offsetHeight / blockSize);
        canvas.width = cols;
        canvas.height = rows;
        const ctx = canvas.getContext('2d');
        const img = ctx.createImageData(cols, rows);
        for (let i = 0; i < img.data.length; i += 4) {
            const v = Math.random() > 0.5 ? 255 : 0;
            img.data[i] = v;
            img.data[i + 1] = v;
            img.data[i + 2] = v;
            img.data[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
    }

    _startAurora() {
        const canvas = this.shadowRoot.querySelector('canvas.aurora');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        const scale = 0.35;
        const resize = () => {
            canvas.width = Math.floor(canvas.offsetWidth * scale);
            canvas.height = Math.floor(canvas.offsetHeight * scale);
        };
        resize();

        const blobs = [
            { parts: [
                { ox: 0, oy: 0, r: 1.0 },
                { ox: 0.22, oy: 0.1, r: 0.85 },
                { ox: 0.11, oy: 0.05, r: 0.5 },
            ], color: [180, 200, 230], x: 0.15, y: 0.2, vx: 0.35, vy: 0.25, phase: 0 },

            { parts: [
                { ox: 0, oy: 0, r: 0.95 },
                { ox: 0.18, oy: -0.08, r: 0.75 },
                { ox: 0.09, oy: -0.04, r: 0.4 },
            ], color: [190, 180, 220], x: 0.75, y: 0.2, vx: -0.3, vy: 0.35, phase: 1.2 },

            { parts: [
                { ox: 0, oy: 0, r: 0.9 },
                { ox: 0.24, oy: 0.12, r: 0.9 },
                { ox: 0.12, oy: 0.06, r: 0.35 },
            ], color: [210, 195, 215], x: 0.5, y: 0.65, vx: 0.25, vy: -0.3, phase: 2.4 },

            { parts: [
                { ox: 0, oy: 0, r: 0.8 },
                { ox: -0.15, oy: 0.18, r: 0.7 },
                { ox: -0.07, oy: 0.09, r: 0.45 },
            ], color: [175, 210, 210], x: 0.1, y: 0.75, vx: 0.4, vy: 0.2, phase: 3.6 },

            { parts: [
                { ox: 0, oy: 0, r: 0.75 },
                { ox: 0.12, oy: -0.15, r: 0.65 },
                { ox: 0.06, oy: -0.07, r: 0.35 },
            ], color: [220, 210, 195], x: 0.85, y: 0.55, vx: -0.28, vy: -0.32, phase: 4.8 },

            { parts: [
                { ox: 0, oy: 0, r: 0.95 },
                { ox: -0.2, oy: -0.12, r: 0.75 },
                { ox: -0.1, oy: -0.06, r: 0.4 },
            ], color: [170, 190, 225], x: 0.6, y: 0.1, vx: -0.2, vy: 0.38, phase: 6.0 },

            { parts: [
                { ox: 0, oy: 0, r: 0.85 },
                { ox: 0.17, oy: 0.15, r: 0.75 },
                { ox: 0.08, oy: 0.07, r: 0.35 },
            ], color: [200, 190, 220], x: 0.35, y: 0.4, vx: 0.32, vy: -0.22, phase: 7.2 },

            { parts: [
                { ox: 0, oy: 0, r: 0.75 },
                { ox: -0.13, oy: 0.18, r: 0.65 },
                { ox: -0.06, oy: 0.1, r: 0.4 },
            ], color: [215, 205, 200], x: 0.9, y: 0.85, vx: -0.35, vy: -0.25, phase: 8.4 },

            { parts: [
                { ox: 0, oy: 0, r: 0.7 },
                { ox: 0.16, oy: -0.1, r: 0.6 },
                { ox: 0.08, oy: -0.05, r: 0.35 },
            ], color: [185, 210, 205], x: 0.45, y: 0.9, vx: 0.22, vy: -0.4, phase: 9.6 },
        ];

        const baseRadius = 0.32;

        const draw = () => {
            this._time += 0.012;
            const w = canvas.width;
            const h = canvas.height;
            const dim = Math.min(w, h);

            ctx.fillStyle = '#f0f0f0';
            ctx.fillRect(0, 0, w, h);

            for (const blob of blobs) {
                const t = this._time;
                const cx = (blob.x + Math.sin(t * blob.vx + blob.phase) * 0.22) * w;
                const cy = (blob.y + Math.cos(t * blob.vy + blob.phase * 0.7) * 0.22) * h;

                for (const part of blob.parts) {
                    const wobble = Math.sin(t * 2.5 + part.ox * 25 + blob.phase) * 0.02;
                    const px = cx + (part.ox + wobble) * dim;
                    const py = cy + (part.oy + wobble * 0.7) * dim;
                    const pr = part.r * baseRadius * dim;

                    const grad = ctx.createRadialGradient(px, py, 0, px, py, pr);
                    grad.addColorStop(0, `rgba(${blob.color[0]}, ${blob.color[1]}, ${blob.color[2]}, 0.55)`);
                    grad.addColorStop(0.4, `rgba(${blob.color[0]}, ${blob.color[1]}, ${blob.color[2]}, 0.3)`);
                    grad.addColorStop(0.7, `rgba(${blob.color[0]}, ${blob.color[1]}, ${blob.color[2]}, 0.1)`);
                    grad.addColorStop(1, `rgba(${blob.color[0]}, ${blob.color[1]}, ${blob.color[2]}, 0)`);

                    ctx.fillStyle = grad;
                    ctx.fillRect(0, 0, w, h);
                }
            }

            this._animId = requestAnimationFrame(draw);
        };

        draw();
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

    _statusPill(status) {
        const granted = status === 'granted';
        return html`<span class="status-pill ${granted ? 'granted' : 'needed'}">${granted ? 'Granted' : 'Needs access'}</span>`;
    }

    _keys(combo) {
        // combo is an array of key labels rendered as badges, aligned right.
        return html`<div class="keys">${combo.map(k => html`<span class="key">${k}</span>`)}</div>`;
    }

    renderWelcome() {
        return html`
            <div class="slide">
                <div class="slide-title">Meta Booster Pro</div>
                <div class="slide-text">Real-time AI that listens, watches, and helps during interviews, meetings, and exams.</div>
                <div class="actions">
                    <button class="btn-primary" @click=${() => { this.currentSlide = 1; }}>Continue</button>
                </div>
            </div>
        `;
    }

    renderPermissions() {
        const mic = this.permStatus.microphone;
        const screen = this.permStatus.screen;

        const macCards = html`
            <div class="card">
                <div class="card-icon">🎬</div>
                <div class="card-body">
                    <div class="card-title">Screen Recording ${this._statusPill(screen)}</div>
                    <div class="card-desc">Lets the app see your screen and capture meeting audio. Required for answers.</div>
                </div>
                <div class="card-actions">
                    <button class="btn-ghost" @click=${() => this.openSettings('screen')}>Open Settings</button>
                </div>
            </div>
            <div class="card">
                <div class="card-icon">🎙️</div>
                <div class="card-body">
                    <div class="card-title">Microphone ${this._statusPill(mic)}</div>
                    <div class="card-desc">Lets the app hear you (for “mic” and “both” audio modes).</div>
                </div>
                <div class="card-actions">
                    <button class="btn-ghost" @click=${() => this.requestMic()}>Allow</button>
                    <button class="btn-ghost" @click=${() => this.openSettings('microphone')}>Open Settings</button>
                </div>
            </div>
        `;

        const winCards = html`
            <div class="card">
                <div class="card-icon">🎙️</div>
                <div class="card-body">
                    <div class="card-title">Microphone ${this._statusPill(mic)}</div>
                    <div class="card-desc">Turn on microphone access so the app can hear your questions.</div>
                </div>
                <div class="card-actions">
                    <button class="btn-ghost" @click=${() => this.openSettings('microphone')}>Open Settings</button>
                </div>
            </div>
            <div class="card">
                <div class="card-icon">🖥️</div>
                <div class="card-body">
                    <div class="card-title">Screen &amp; audio capture ${this._statusPill('granted')}</div>
                    <div class="card-desc">No extra permission needed on Windows — capture starts automatically.</div>
                </div>
            </div>
        `;

        return html`
            <div class="slide slide-wide">
                <div class="slide-title">Enable permissions</div>
                <div class="slide-text">
                    ${this.isMac
                        ? 'macOS needs your OK for the app to see the screen and hear audio. Grant both below, then come back.'
                        : 'Allow microphone access so the app can hear you. Screen capture works automatically.'}
                </div>
                <div class="card-list">
                    ${this.isMac ? macCards : winCards}
                </div>
                <div class="hint">
                    ${this.isMac
                        ? 'After toggling a permission in Settings you may need to restart the app.'
                        : 'You can change this anytime in Windows Settings ▸ Privacy.'}
                </div>
                <div class="actions">
                    <button class="btn-primary" @click=${() => { this.refreshPermissions(); this.currentSlide = 2; }}>Continue</button>
                    <button class="btn-back" @click=${() => { this.currentSlide = 0; }}>Back</button>
                </div>
            </div>
        `;
    }

    renderShortcuts() {
        const mod = this.isMac ? '⌘' : 'Ctrl';
        return html`
            <div class="slide slide-wide">
                <div class="slide-title">Two shortcuts to know</div>
                <div class="slide-text">These work globally — even when the app is hidden or another window is focused.</div>
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
                <div class="hint">See all shortcuts anytime in Help.</div>
                <div class="actions">
                    <button class="btn-primary" @click=${() => { this.currentSlide = 3; }}>Continue</button>
                    <button class="btn-back" @click=${() => { this.currentSlide = 1; }}>Back</button>
                </div>
            </div>
        `;
    }

    renderContext() {
        return html`
            <div class="slide">
                <div class="slide-title">Add context</div>
                <div class="slide-text">Paste your resume or any info the AI should know. You can skip this and add it later.</div>
                <textarea
                    class="context-input"
                    placeholder="Resume, job description, notes..."
                    .value=${this.contextText}
                    @input=${this.handleContextInput}
                ></textarea>
                <div class="actions">
                    <button class="btn-primary" @click=${this.completeOnboarding}>Get Started</button>
                    <button class="btn-back" @click=${() => { this.currentSlide = 2; }}>Back</button>
                </div>
            </div>
        `;
    }

    renderSlide() {
        switch (this.currentSlide) {
            case 0: return this.renderWelcome();
            case 1: return this.renderPermissions();
            case 2: return this.renderShortcuts();
            default: return this.renderContext();
        }
    }

    render() {
        return html`
            <div class="onboarding">
                <canvas class="aurora"></canvas>
                <canvas class="dither"></canvas>
                ${this.renderSlide()}
            </div>
        `;
    }
}

customElements.define('onboarding-view', OnboardingView);
