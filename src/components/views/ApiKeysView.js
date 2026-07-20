import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { unifiedPageStyles } from './sharedPageStyles.js';

export class ApiKeysView extends LitElement {
    static styles = [
        unifiedPageStyles,
        css`
            .keys-wrap {
                display: flex;
                flex-direction: column;
                gap: var(--space-md);
                padding: var(--space-md);
                overflow-y: auto;
            }
            .field {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .field label {
                font-size: var(--font-size-xs);
                color: var(--text-secondary);
            }
            .field .hint {
                font-size: 11px;
                color: var(--text-muted);
            }
            .link-hint {
                font-size: 11px;
                color: var(--accent);
                background: none;
                border: none;
                padding: 0;
                cursor: pointer;
                text-decoration: underline;
                align-self: flex-start;
                font-family: var(--font);
            }
            .link-hint:hover { opacity: 0.8; }
            .control {
                background: var(--bg-elevated);
                border: 1px solid var(--border);
                color: var(--text-primary);
                border-radius: var(--radius-sm, 8px);
                padding: 8px 10px;
                font-size: var(--font-size-sm, 13px);
                font-family: var(--font);
                outline: none;
            }
            .control:focus { border-color: var(--accent); }
            .key-row {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .key-row .control { flex: 1; min-width: 0; }
            .key-status {
                font-size: 12px;
                white-space: nowrap;
                min-width: 66px;
                text-align: right;
            }
            .key-status.checking { color: var(--text-muted); }
            .key-status.ok { color: #2e9e5b; }
            .key-status.err { color: #e5484d; }
            .saved {
                font-size: 11px;
                color: #2e9e5b;
                min-height: 14px;
            }
            .section-title {
                font-size: var(--font-size-xs);
                text-transform: uppercase;
                letter-spacing: 0.5px;
                color: var(--text-muted);
                margin-top: var(--space-sm);
            }
        `,
    ];

    static properties = {
        _gemini: { state: true },
        _groq: { state: true },
        _anthropic: { state: true },
        _savedNote: { state: true },
        _geminiStatus: { state: true },
        _groqStatus: { state: true },
        _anthropicStatus: { state: true },
    };

    constructor() {
        super();
        this._gemini = '';
        this._groq = '';
        this._anthropic = '';
        this._savedNote = '';
        // 'idle' | 'checking' | 'ok' | 'error'
        this._geminiStatus = 'idle';
        this._groqStatus = 'idle';
        this._anthropicStatus = 'idle';
    }

    connectedCallback() {
        super.connectedCallback();
        this._load();
    }

    async _load() {
        try {
            // Single unified mode: the app always runs on the user's own keys.
            await metaMaxPro.storage.updatePreference('providerMode', 'byok');
            this._gemini = (await metaMaxPro.storage.getApiKey().catch(() => '')) || '';
            this._groq = (await metaMaxPro.storage.getGroqApiKey().catch(() => '')) || '';
            this._anthropic = (await metaMaxPro.storage.getAnthropicApiKey().catch(() => '')) || '';
            this.requestUpdate();
            // Validate any already-stored keys so the user sees their status.
            if (this._gemini) this._validateGemini(this._gemini);
            if (this._groq) this._validateGroq(this._groq);
            if (this._anthropic) this._validateAnthropic(this._anthropic);
        } catch (e) {
            console.error('Error loading API keys:', e);
        }
    }

    async _validateGemini(key) {
        if (!key || !key.trim()) { this._geminiStatus = 'idle'; return; }
        this._geminiStatus = 'checking';
        try {
            const res = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models?key=${key.trim()}&pageSize=1`,
                { signal: AbortSignal.timeout(8000) }
            );
            this._geminiStatus = res.ok ? 'ok' : 'error';
        } catch { this._geminiStatus = 'error'; }
    }

    async _validateGroq(key) {
        if (!key || !key.trim()) { this._groqStatus = 'idle'; return; }
        this._groqStatus = 'checking';
        try {
            const res = await fetch('https://api.groq.com/openai/v1/models', {
                headers: { Authorization: `Bearer ${key.trim()}` },
                signal: AbortSignal.timeout(8000),
            });
            this._groqStatus = res.ok ? 'ok' : 'error';
        } catch { this._groqStatus = 'error'; }
    }

    async _validateAnthropic(key) {
        if (!key || !key.trim()) { this._anthropicStatus = 'idle'; return; }
        this._anthropicStatus = 'checking';
        try {
            const res = await fetch('https://api.anthropic.com/v1/models', {
                method: 'GET',
                headers: { 'x-api-key': key.trim(), 'anthropic-version': '2023-06-01' },
                signal: AbortSignal.timeout(10000),
            });
            this._anthropicStatus = res.status === 200 ? 'ok' : 'error';
        } catch { this._anthropicStatus = 'error'; }
    }

    _flash() {
        this._savedNote = 'Saved';
        clearTimeout(this._noteTimer);
        this._noteTimer = setTimeout(() => { this._savedNote = ''; }, 1500);
    }

    _openLink(url) {
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            ipcRenderer.invoke('open-external', url);
        }
    }

    async _saveGemini(e) {
        this._gemini = e.target.value.trim();
        await metaMaxPro.storage.setApiKey(this._gemini);
        this._flash();
        await this._validateGemini(this._gemini);
    }

    async _saveGroq(e) {
        this._groq = e.target.value.trim();
        await metaMaxPro.storage.setGroqApiKey(this._groq);
        this._flash();
        await this._validateGroq(this._groq);
    }

    async _saveAnthropic(e) {
        this._anthropic = e.target.value.trim();
        await metaMaxPro.storage.setAnthropicApiKey(this._anthropic);
        this._flash();
        await this._validateAnthropic(this._anthropic);
    }

    _renderStatus(status) {
        if (status === 'checking') return html`<span class="key-status checking">Checking…</span>`;
        if (status === 'ok') return html`<span class="key-status ok">✓ Valid</span>`;
        if (status === 'error') return html`<span class="key-status err">✗ Invalid</span>`;
        return html`<span class="key-status"></span>`;
    }

    render() {
        return html`
            <div class="keys-wrap">
                <div class="hint">Enter your API keys — the app runs entirely on your own keys.</div>
                <div class="saved">${this._savedNote}</div>

                <div class="field">
                    <label>Gemini API key</label>
                    <div class="key-row">
                        <input class="control" type="password" .value=${this._gemini} @change=${this._saveGemini} placeholder="Live transcription + screen solving" />
                        ${this._renderStatus(this._geminiStatus)}
                    </div>
                    <button class="link-hint" @click=${() => this._openLink('https://aistudio.google.com/apikey')}>Get a Gemini key ↗</button>
                </div>
                <div class="field">
                    <label>Groq API key</label>
                    <div class="key-row">
                        <input class="control" type="password" .value=${this._groq} @change=${this._saveGroq} placeholder="Fast answer generation" />
                        ${this._renderStatus(this._groqStatus)}
                    </div>
                    <button class="link-hint" @click=${() => this._openLink('https://console.groq.com/keys')}>Get a Groq key ↗</button>
                </div>
                <div class="field">
                    <label>Anthropic API key <span class="hint">(optional)</span></label>
                    <div class="key-row">
                        <input class="control" type="password" .value=${this._anthropic} @change=${this._saveAnthropic} placeholder="Optional — used for screen solving" />
                        ${this._renderStatus(this._anthropicStatus)}
                    </div>
                    <button class="link-hint" @click=${() => this._openLink('https://console.anthropic.com/settings/keys')}>Get an Anthropic key ↗</button>
                </div>
            </div>
        `;
    }
}

customElements.define('api-keys-view', ApiKeysView);
