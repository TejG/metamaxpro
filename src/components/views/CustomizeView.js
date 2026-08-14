import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { unifiedPageStyles } from './sharedPageStyles.js';

export class CustomizeView extends LitElement {
    static styles = [
        unifiedPageStyles,
        css`
            :host {
                display: block;
                width: 100%;
                height: 100%;
            }

            * {
                box-sizing: border-box;
            }

            .settings-page {
                width: 100%;
                min-height: 100%;
                padding: 32px;
                color: var(--text-primary);
            }

            .settings-container {
                width: 100%;
                max-width: 1180px;
                margin: 0 auto;
                display: flex;
                flex-direction: column;
                gap: 18px;
            }

            .page-heading {
                margin-bottom: 8px;
            }

            .page-title {
                margin: 0;
                color: var(--text-primary);
                font-size: 30px;
                font-weight: 650;
                line-height: 1.2;
                letter-spacing: -0.03em;
            }

            .page-subtitle {
                margin: 8px 0 0;
                color: var(--text-secondary);
                font-size: 14px;
                line-height: 1.5;
            }

            .settings-card {
                width: 100%;
                overflow: hidden;
                border: 1px solid var(--border);
                border-radius: 14px;
                background: var(--bg-elevated);
            }

            .card-header {
                padding: 22px 24px 10px;
            }

            .card-title-row {
                display: flex;
                align-items: flex-start;
                gap: 12px;
            }

            .section-icon {
                width: 34px;
                height: 34px;
                flex-shrink: 0;
                display: grid;
                place-items: center;
                border-radius: 9px;
                background: rgba(255, 255, 255, 0.05);
                color: var(--text-primary);
                font-size: 16px;
            }

            .section-title {
                margin: 0;
                color: var(--text-primary);
                font-size: 16px;
                font-weight: 600;
                line-height: 1.3;
            }

            .section-description {
                margin: 5px 0 0;
                color: var(--text-secondary);
                font-size: 13px;
                line-height: 1.5;
            }

            .card-body {
                padding: 18px 24px 24px;
            }

            .setting-row {
                display: grid;
                grid-template-columns: minmax(180px, 1fr) minmax(280px, 420px);
                align-items: center;
                gap: 30px;
                padding: 18px 0;
                border-top: 1px solid var(--border);
            }

            .setting-row:first-child {
                border-top: 0;
                padding-top: 4px;
            }

            .setting-label {
                display: block;
                margin-bottom: 5px;
                color: var(--text-primary);
                font-size: 13px;
                font-weight: 500;
            }

            .setting-help {
                margin: 0;
                color: var(--text-secondary);
                font-size: 12px;
                line-height: 1.45;
            }

            .setting-control {
                min-width: 0;
            }

            .control {
                width: 100%;
                height: 42px;
                padding: 0 38px 0 13px;
                border: 1px solid var(--border);
                border-radius: 9px;
                background: var(--bg-surface);
                color: var(--text-primary);
                font-family: inherit;
                font-size: 13px;
                outline: none;
                cursor: pointer;
                transition:
                    border-color 150ms ease,
                    background 150ms ease,
                    box-shadow 150ms ease;
            }

            .control:hover {
                border-color: color-mix(
                    in srgb,
                    var(--border) 65%,
                    var(--text-secondary)
                );
            }

            .control:focus {
                border-color: #6366f1;
                box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.12);
            }

            .appearance-layout {
                display: grid;
                grid-template-columns: minmax(0, 1.15fr) minmax(280px, 0.85fr);
                gap: 38px;
            }

            .appearance-controls {
                min-width: 0;
                display: flex;
                flex-direction: column;
                gap: 26px;
            }

            .setting-block {
                width: 100%;
            }

            .setting-block + .setting-block {
                padding-top: 22px;
                border-top: 1px solid var(--border);
            }

            .theme-options {
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                padding: 3px;
                border: 1px solid var(--border);
                border-radius: 10px;
                background: var(--bg-surface);
            }

            .theme-option {
                min-height: 38px;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 7px;
                border: 0;
                border-radius: 7px;
                background: transparent;
                color: var(--text-secondary);
                font-family: inherit;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                transition:
                    background 150ms ease,
                    color 150ms ease,
                    box-shadow 150ms ease;
            }

            .theme-option:hover {
                color: var(--text-primary);
                background: rgba(255, 255, 255, 0.035);
            }

            .theme-option.active {
                color: white;
                background: #6366f1;
                box-shadow: 0 3px 10px rgba(99, 102, 241, 0.28);
            }

            .slider-top {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 16px;
                margin-bottom: 10px;
            }

            .slider-value {
                min-width: 54px;
                padding: 4px 8px;
                border: 1px solid var(--border);
                border-radius: 7px;
                background: var(--bg-surface);
                color: var(--text-primary);
                font-family: var(--font-mono);
                font-size: 11px;
                text-align: center;
            }

            .slider-input {
                -webkit-appearance: none;
                appearance: none;
                width: 100%;
                height: 5px;
                border-radius: 999px;
                background: var(--border);
                outline: none;
                cursor: pointer;
            }

            .slider-input::-webkit-slider-thumb {
                -webkit-appearance: none;
                appearance: none;
                width: 17px;
                height: 17px;
                border: 3px solid var(--text-primary);
                border-radius: 50%;
                background: var(--bg-surface);
                box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
            }

            .slider-input::-moz-range-thumb {
                width: 14px;
                height: 14px;
                border: 2px solid var(--text-primary);
                border-radius: 50%;
                background: var(--bg-surface);
                cursor: pointer;
            }

            .slider-minmax {
                display: flex;
                justify-content: space-between;
                margin-top: 7px;
                color: var(--text-secondary);
                font-size: 10px;
            }

            .preview-column {
                min-width: 0;
            }

            .preview-label {
                margin-bottom: 10px;
                color: var(--text-secondary);
                font-size: 12px;
                font-weight: 500;
            }

            .preview-window {
                min-height: 255px;
                padding: 16px;
                overflow: hidden;
                border: 1px solid var(--border);
                border-radius: 12px;
                background:
                    linear-gradient(
                        180deg,
                        rgba(255, 255, 255, 0.025),
                        rgba(255, 255, 255, 0.01)
                    ),
                    var(--bg-surface);
            }

            .preview-window-dots {
                display: flex;
                gap: 6px;
                margin-bottom: 24px;
            }

            .preview-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
            }

            .preview-dot.red {
                background: #ff5f57;
            }

            .preview-dot.yellow {
                background: #febc2e;
            }

            .preview-dot.green {
                background: #28c840;
            }

            .preview-chat {
                display: flex;
                flex-direction: column;
                gap: 10px;
            }

            .preview-message {
                max-width: 88%;
                padding: 11px 12px;
                border: 1px solid var(--border);
                border-radius: 10px;
                background: var(--bg-elevated);
            }

            .preview-message.me {
                align-self: flex-end;
            }

            .preview-speaker {
                display: block;
                margin-bottom: 4px;
                color: #818cf8;
                font-size: 10px;
                font-weight: 600;
            }

            .preview-text {
                color: var(--text-primary);
                line-height: 1.45;
            }

            .preview-note {
                margin: 12px 2px 0;
                color: var(--text-secondary);
                font-size: 11px;
                line-height: 1.4;
            }

            .warning-callout {
                margin-top: 10px;
                padding: 10px 12px;
                border: 1px solid rgba(245, 158, 11, 0.35);
                border-radius: 8px;
                background: rgba(245, 158, 11, 0.06);
                color: #f59e0b;
                font-size: 11px;
                line-height: 1.45;
            }

            .secondary-button,
            .danger-button {
                min-height: 40px;
                padding: 0 15px;
                border-radius: 8px;
                font-family: inherit;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                transition:
                    background 150ms ease,
                    border-color 150ms ease,
                    opacity 150ms ease;
            }

            .secondary-button {
                border: 1px solid var(--border);
                background: var(--bg-surface);
                color: var(--text-primary);
            }

            .secondary-button:hover {
                background: rgba(255, 255, 255, 0.05);
            }

            .danger-button {
                border: 1px solid var(--danger);
                background: transparent;
                color: var(--danger);
            }

            .danger-button:hover {
                background: rgba(239, 68, 68, 0.09);
            }

            .secondary-button:disabled,
            .danger-button:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }

            .privacy-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 24px;
                padding: 20px 0;
            }

            .privacy-info {
                max-width: 600px;
            }

            .danger-zone {
                margin-top: 8px;
                padding: 20px;
                border: 1px solid rgba(239, 68, 68, 0.4);
                border-radius: 11px;
                background: rgba(239, 68, 68, 0.035);
            }

            .danger-zone-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 24px;
            }

            .danger-zone-title {
                margin: 0 0 6px;
                color: var(--danger);
                font-size: 12px;
                font-weight: 600;
            }

            .status {
                margin-top: 18px;
                padding: 11px 13px;
                border: 1px solid var(--border);
                border-radius: 8px;
                font-size: 12px;
                line-height: 1.4;
            }

            .status.success {
                border-color: var(--success);
                color: var(--success);
            }

            .status.error {
                border-color: var(--danger);
                color: var(--danger);
                background: rgba(239, 68, 68, 0.05);
            }

            .modal-backdrop {
                position: fixed;
                inset: 0;
                z-index: 1000;
                display: grid;
                place-items: center;
                padding: 20px;
                background: rgba(0, 0, 0, 0.62);
                backdrop-filter: blur(5px);
            }

            .modal {
                width: min(440px, 100%);
                padding: 24px;
                border: 1px solid var(--border);
                border-radius: 14px;
                background: var(--bg-surface);
                box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
            }

            .modal-icon {
                width: 42px;
                height: 42px;
                display: grid;
                place-items: center;
                margin-bottom: 16px;
                border-radius: 10px;
                background: rgba(239, 68, 68, 0.1);
                color: var(--danger);
                font-size: 20px;
                font-weight: 700;
            }

            .modal-title {
                margin: 0 0 8px;
                color: var(--text-primary);
                font-size: 18px;
                font-weight: 600;
            }

            .modal-description {
                margin: 0;
                color: var(--text-secondary);
                font-size: 13px;
                line-height: 1.55;
            }

            .modal-actions {
                display: flex;
                justify-content: flex-end;
                gap: 10px;
                margin-top: 24px;
            }

            @media (max-width: 900px) {
                .settings-page {
                    padding: 20px;
                }

                .appearance-layout {
                    grid-template-columns: 1fr;
                }

                .setting-row {
                    grid-template-columns: 1fr;
                    gap: 12px;
                }
            }

            @media (max-width: 640px) {
                .settings-page {
                    padding: 14px;
                }

                .card-header,
                .card-body {
                    padding-left: 18px;
                    padding-right: 18px;
                }

                .privacy-row,
                .danger-zone-row {
                    flex-direction: column;
                    align-items: flex-start;
                }

                .secondary-button,
                .danger-button {
                    width: 100%;
                }
            }
        `,
    ];

    static properties = {
        selectedProfile: { type: String },
        selectedLanguage: { type: String },
        selectedImageQuality: { type: String },
        layoutMode: { type: String },
        keybinds: { type: Object },
        googleSearchEnabled: { type: Boolean },
        backgroundTransparency: { type: Number },
        fontSize: { type: Number },
        audioMode: { type: String },
        customPrompt: { type: String },
        theme: { type: String },
        showDeleteConfirmation: { type: Boolean },

        onProfileChange: { type: Function },
        onLanguageChange: { type: Function },
        onImageQualityChange: { type: Function },
        onLayoutModeChange: { type: Function },

        isClearing: { type: Boolean },
        isRestoring: { type: Boolean },
        clearStatusMessage: { type: String },
        clearStatusType: { type: String },
    };

    constructor() {
        super();

        this.selectedProfile = 'interview';
        this.selectedLanguage = 'en-US';
        this.selectedImageQuality = 'medium';
        this.layoutMode = 'normal';

        this.keybinds = this.getDefaultKeybinds();

        this.onProfileChange = () => {};
        this.onLanguageChange = () => {};
        this.onImageQualityChange = () => {};
        this.onLayoutModeChange = () => {};

        this.googleSearchEnabled = true;

        this.isClearing = false;
        this.isRestoring = false;

        this.clearStatusMessage = '';
        this.clearStatusType = '';

        this.backgroundTransparency = 0.8;
        this.fontSize = 20;

        this.audioMode = 'speaker_only';
        this.customPrompt = '';
        this.theme = 'dark';

        this.showDeleteConfirmation = false;

        this._loadFromStorage();
    }

    getThemes() {
        return metaMaxPro.theme.getAll();
    }

    getProfiles() {
        return [
            { value: 'interview', name: 'Job Interview' },
            { value: 'sales', name: 'Sales Call' },
            { value: 'meeting', name: 'Business Meeting' },
            { value: 'presentation', name: 'Presentation' },
            { value: 'negotiation', name: 'Negotiation' },
            { value: 'exam', name: 'Exam Assistant' },
        ];
    }

    getLanguages() {
        return [
            { value: 'en-US', name: 'English (US)' },
            { value: 'en-GB', name: 'English (UK)' },
            { value: 'en-AU', name: 'English (Australia)' },
            { value: 'en-IN', name: 'English (India)' },
            { value: 'de-DE', name: 'German (Germany)' },
            { value: 'es-US', name: 'Spanish (US)' },
            { value: 'es-ES', name: 'Spanish (Spain)' },
            { value: 'fr-FR', name: 'French (France)' },
            { value: 'fr-CA', name: 'French (Canada)' },
            { value: 'hi-IN', name: 'Hindi (India)' },
            { value: 'pt-BR', name: 'Portuguese (Brazil)' },
            { value: 'ar-XA', name: 'Arabic (Generic)' },
            { value: 'id-ID', name: 'Indonesian (Indonesia)' },
            { value: 'it-IT', name: 'Italian (Italy)' },
            { value: 'ja-JP', name: 'Japanese (Japan)' },
            { value: 'tr-TR', name: 'Turkish (Turkey)' },
            { value: 'vi-VN', name: 'Vietnamese (Vietnam)' },
            { value: 'bn-IN', name: 'Bengali (India)' },
            { value: 'gu-IN', name: 'Gujarati (India)' },
            { value: 'kn-IN', name: 'Kannada (India)' },
            { value: 'ml-IN', name: 'Malayalam (India)' },
            { value: 'mr-IN', name: 'Marathi (India)' },
            { value: 'ta-IN', name: 'Tamil (India)' },
            { value: 'te-IN', name: 'Telugu (India)' },
            { value: 'nl-NL', name: 'Dutch (Netherlands)' },
            { value: 'ko-KR', name: 'Korean (South Korea)' },
            { value: 'cmn-CN', name: 'Mandarin Chinese (China)' },
            { value: 'pl-PL', name: 'Polish (Poland)' },
            { value: 'ru-RU', name: 'Russian (Russia)' },
            { value: 'th-TH', name: 'Thai (Thailand)' },
        ];
    }

    getDefaultKeybinds() {
        const isMac =
            metaMaxPro.isMacOS ||
            navigator.platform.includes('Mac');

        return {
            moveUp: isMac ? 'Alt+Up' : 'Ctrl+Up',
            moveDown: isMac ? 'Alt+Down' : 'Ctrl+Down',
            moveLeft: isMac ? 'Alt+Left' : 'Ctrl+Left',
            moveRight: isMac ? 'Alt+Right' : 'Ctrl+Right',
            toggleVisibility: isMac ? 'Cmd+\\' : 'Ctrl+\\',
            toggleClickThrough: isMac ? 'Cmd+M' : 'Ctrl+M',
            nextStep: isMac ? 'Cmd+Enter' : 'Ctrl+Enter',
            previousResponse: isMac ? 'Cmd+[' : 'Ctrl+[',
            nextResponse: isMac ? 'Cmd+]' : 'Ctrl+]',
            scrollUp: isMac ? 'Cmd+Shift+Up' : 'Ctrl+Shift+Up',
            scrollDown: isMac ? 'Cmd+Shift+Down' : 'Ctrl+Shift+Down',
        };
    }

    async _loadFromStorage() {
        try {
            const [prefs, keybinds] = await Promise.all([
                metaMaxPro.storage.getPreferences(),
                metaMaxPro.storage.getKeybinds(),
            ]);

            this.googleSearchEnabled = prefs.googleSearchEnabled ?? true;
            this.backgroundTransparency = prefs.backgroundTransparency ?? 0.8;
            this.fontSize = prefs.fontSize ?? 20;
            this.audioMode = prefs.audioMode ?? 'speaker_only';
            this.customPrompt = prefs.customPrompt ?? '';
            this.theme = prefs.theme ?? 'dark';

            if (prefs.selectedLanguage) {
                this.selectedLanguage = prefs.selectedLanguage;
            }

            if (prefs.selectedImageQuality) {
                this.selectedImageQuality = prefs.selectedImageQuality;
            }

            if (prefs.selectedProfile) {
                this.selectedProfile = prefs.selectedProfile;
            }

            if (keybinds) {
                this.keybinds = {
                    ...this.getDefaultKeybinds(),
                    ...keybinds,
                };
            }

            this.updateBackgroundAppearance();
            this.updateFontSize();

            this.requestUpdate();
        } catch (error) {
            console.error('Error loading settings:', error);
        }
    }

    handleProfileSelect(e) {
        this.selectedProfile = e.target.value;
        this.onProfileChange(this.selectedProfile);
    }

    async handleLanguageSelect(e) {
        this.selectedLanguage = e.target.value;

        await metaMaxPro.storage.updatePreference(
            'selectedLanguage',
            this.selectedLanguage
        );

        this.onLanguageChange(this.selectedLanguage);
    }

    async handleImageQualitySelect(e) {
        this.selectedImageQuality = e.target.value;

        await metaMaxPro.storage.updatePreference(
            'selectedImageQuality',
            this.selectedImageQuality
        );

        this.onImageQualityChange(this.selectedImageQuality);
    }

    handleLayoutModeSelect(e) {
        this.layoutMode = e.target.value;
        this.onLayoutModeChange(this.layoutMode);
    }

    async handleCustomPromptInput(e) {
        this.customPrompt = e.target.value;

        await metaMaxPro.storage.updatePreference(
            'customPrompt',
            this.customPrompt
        );
    }

    async handleAudioModeSelect(e) {
        this.audioMode = e.target.value;

        await metaMaxPro.storage.updatePreference(
            'audioMode',
            this.audioMode
        );

        this.requestUpdate();
    }

    async selectTheme(themeValue) {
        this.theme = themeValue;

        await metaMaxPro.theme.save(this.theme);

        this.updateBackgroundAppearance();
        this.requestUpdate();
    }

    async handleGoogleSearchChange(e) {
        this.googleSearchEnabled = e.target.checked;

        await metaMaxPro.storage.updatePreference(
            'googleSearchEnabled',
            this.googleSearchEnabled
        );

        if (window.require) {
            try {
                const { ipcRenderer } = window.require('electron');

                await ipcRenderer.invoke(
                    'update-google-search-setting',
                    this.googleSearchEnabled
                );
            } catch (error) {
                console.error(
                    'Failed to notify main process:',
                    error
                );
            }
        }

        this.requestUpdate();
    }

    async handleBackgroundTransparencyChange(e) {
        this.backgroundTransparency = parseFloat(e.target.value);

        await metaMaxPro.storage.updatePreference(
            'backgroundTransparency',
            this.backgroundTransparency
        );

        this.updateBackgroundAppearance();
        this.requestUpdate();
    }

    updateBackgroundAppearance() {
        const colors = metaMaxPro.theme.get(this.theme);

        metaMaxPro.theme.applyBackgrounds(
            colors.background,
            this.backgroundTransparency
        );
    }

    async handleFontSizeChange(e) {
        this.fontSize = parseInt(e.target.value, 10);

        await metaMaxPro.storage.updatePreference(
            'fontSize',
            this.fontSize
        );

        this.updateFontSize();
        this.requestUpdate();
    }

    updateFontSize() {
        document.documentElement.style.setProperty(
            '--response-font-size',
            `${this.fontSize}px`
        );
    }

    async saveKeybinds() {
        await metaMaxPro.storage.setKeybinds(this.keybinds);

        if (window.require) {
            const { ipcRenderer } = window.require('electron');

            ipcRenderer.send(
                'update-keybinds',
                this.keybinds
            );
        }
    }

    handleKeybindChange(action, value) {
        this.keybinds = {
            ...this.keybinds,
            [action]: value,
        };

        this.saveKeybinds();
        this.requestUpdate();
    }

    async restoreAllSettings() {
        if (this.isRestoring) return;

        this.isRestoring = true;
        this.clearStatusMessage = '';
        this.clearStatusType = '';

        this.requestUpdate();

        try {
            const defaults = {
                customPrompt: '',
                selectedProfile: 'interview',
                selectedLanguage: 'en-US',
                selectedScreenshotInterval: '5',
                selectedImageQuality: 'medium',
                audioMode: 'speaker_only',
                fontSize: 20,
                backgroundTransparency: 0.8,
                googleSearchEnabled: false,
                theme: 'dark',
            };

            for (const [key, value] of Object.entries(defaults)) {
                await metaMaxPro.storage.updatePreference(
                    key,
                    value
                );
            }

            this.keybinds = this.getDefaultKeybinds();

            await metaMaxPro.storage.setKeybinds(null);

            if (window.require) {
                const { ipcRenderer } = window.require('electron');

                ipcRenderer.send(
                    'update-keybinds',
                    this.keybinds
                );
            }

            this.selectedProfile = defaults.selectedProfile;
            this.selectedLanguage = defaults.selectedLanguage;
            this.selectedImageQuality = defaults.selectedImageQuality;
            this.audioMode = defaults.audioMode;
            this.fontSize = defaults.fontSize;
            this.backgroundTransparency = defaults.backgroundTransparency;
            this.googleSearchEnabled = defaults.googleSearchEnabled;
            this.customPrompt = defaults.customPrompt;
            this.theme = defaults.theme;

            this.onProfileChange(defaults.selectedProfile);
            this.onLanguageChange(defaults.selectedLanguage);
            this.onImageQualityChange(defaults.selectedImageQuality);

            await metaMaxPro.theme.save(defaults.theme);

            this.updateBackgroundAppearance();
            this.updateFontSize();

            this.clearStatusMessage =
                'Settings have been reset to their default values.';

            this.clearStatusType = 'success';
        } catch (error) {
            console.error(
                'Error restoring settings:',
                error
            );

            this.clearStatusMessage =
                `Error restoring settings: ${error.message}`;

            this.clearStatusType = 'error';
        } finally {
            this.isRestoring = false;
            this.requestUpdate();
        }
    }

    openDeleteConfirmation() {
        this.showDeleteConfirmation = true;
    }

    closeDeleteConfirmation() {
        if (this.isClearing) return;

        this.showDeleteConfirmation = false;
    }

    async confirmDeleteData() {
        this.showDeleteConfirmation = false;
        await this.clearLocalData();
    }

    async clearLocalData() {
        if (this.isClearing) return;

        this.isClearing = true;
        this.clearStatusMessage = '';
        this.clearStatusType = '';

        this.requestUpdate();

        try {
            await metaMaxPro.storage.clearAll();

            this.clearStatusMessage =
                'Successfully cleared all local data.';

            this.clearStatusType = 'success';

            this.requestUpdate();

            setTimeout(() => {
                this.clearStatusMessage = 'Closing application...';
                this.requestUpdate();

                setTimeout(async () => {
                    if (window.require) {
                        const { ipcRenderer } = window.require('electron');

                        await ipcRenderer.invoke(
                            'quit-application'
                        );
                    }
                }, 1000);
            }, 2000);
        } catch (error) {
            console.error(
                'Error clearing data:',
                error
            );

            this.clearStatusMessage =
                `Error clearing data: ${error.message}`;

            this.clearStatusType = 'error';
        } finally {
            this.isClearing = false;
            this.requestUpdate();
        }
    }

    renderAppearanceSection() {
        const transparencyPercent =
            Math.round(this.backgroundTransparency * 100);

        const previewFontSize =
            Math.max(
                11,
                Math.min(this.fontSize * 0.65, 18)
            );

        return html`
            <section class="settings-card">
                <div class="card-header">
                    <div class="card-title-row">
                        <div class="section-icon">
                            ◐
                        </div>

                        <div>
                            <h2 class="section-title">
                                Appearance
                            </h2>

                            <p class="section-description">
                                Customize how the app looks and feels.
                            </p>
                        </div>
                    </div>
                </div>

                <div class="card-body appearance-layout">
                    <div class="appearance-controls">

                        <div class="setting-block">
                            <label class="setting-label">
                                Theme
                            </label>

                            <p class="setting-help">
                                Choose the interface appearance that works best for you.
                            </p>

                            <div
                                class="theme-options"
                                style="margin-top:12px;"
                            >
                                ${this.getThemes().map(
                                    theme => html`
                                        <button
                                            class="theme-option ${
                                                this.theme === theme.value
                                                    ? 'active'
                                                    : ''
                                            }"
                                            @click=${() =>
                                                this.selectTheme(theme.value)}
                                        >
                                            <span>
                                                ${
                                                    theme.value === 'light'
                                                        ? '☀'
                                                        : theme.value === 'dark'
                                                        ? '☾'
                                                        : '▣'
                                                }
                                            </span>

                                            ${theme.name}
                                        </button>
                                    `
                                )}
                            </div>
                        </div>

                        <div class="setting-block">
                            <div class="slider-top">
                                <div>
                                    <label class="setting-label">
                                        Background transparency
                                    </label>

                                    <p class="setting-help">
                                        Adjust how transparent the application window appears.
                                    </p>
                                </div>

                                <span class="slider-value">
                                    ${transparencyPercent}%
                                </span>
                            </div>

                            <input
                                class="slider-input"
                                type="range"
                                min="0"
                                max="1"
                                step="0.01"
                                .value=${this.backgroundTransparency}
                                @input=${this.handleBackgroundTransparencyChange}
                            />

                            <div class="slider-minmax">
                                <span>0%</span>
                                <span>100%</span>
                            </div>
                        </div>

                        <div class="setting-block">
                            <div class="slider-top">
                                <div>
                                    <label class="setting-label">
                                        Response text size
                                    </label>

                                    <p class="setting-help">
                                        Change the size of AI response text.
                                    </p>
                                </div>

                                <span class="slider-value">
                                    ${this.fontSize}px
                                </span>
                            </div>

                            <input
                                class="slider-input"
                                type="range"
                                min="12"
                                max="32"
                                step="1"
                                .value=${this.fontSize}
                                @input=${this.handleFontSizeChange}
                            />

                            <div class="slider-minmax">
                                <span>12 px</span>
                                <span>32 px</span>
                            </div>
                        </div>
                    </div>

                    <div class="preview-column">
                        <div class="preview-label">
                            Live preview
                        </div>

                        <div
                            class="preview-window"
                            style="
                                font-size:${previewFontSize}px;
                            "
                        >
                            <div class="preview-window-dots">
                                <span class="preview-dot red"></span>
                                <span class="preview-dot yellow"></span>
                                <span class="preview-dot green"></span>
                            </div>

                            <div class="preview-chat">
                                <div class="preview-message">
                                    <span class="preview-speaker">
                                        Interviewer
                                    </span>

                                    <div class="preview-text">
                                        What do you enjoy most
                                        about building products?
                                    </div>
                                </div>

                                <div class="preview-message me">
                                    <span class="preview-speaker">
                                        You
                                    </span>

                                    <div class="preview-text">
                                        Solving meaningful problems
                                        and making an impact.
                                    </div>
                                </div>
                            </div>
                        </div>

                        <p class="preview-note">
                            This is a preview of how the app will
                            look with your current settings.
                        </p>
                    </div>
                </div>
            </section>
        `;
    }

    renderAudioSection() {
        return html`
            <section class="settings-card">
                <div class="card-header">
                    <div class="card-title-row">
                        <div class="section-icon">
                            ◉
                        </div>

                        <div>
                            <h2 class="section-title">
                                Audio & Capture
                            </h2>

                            <p class="section-description">
                                Configure how audio and screen content are captured.
                            </p>
                        </div>
                    </div>
                </div>

                <div class="card-body">
                    <div class="setting-row">
                        <div>
                            <label class="setting-label">
                                Audio mode
                            </label>

                            <p class="setting-help">
                                Choose which audio source should be captured.
                            </p>
                        </div>

                        <div class="setting-control">
                            <select
                                class="control"
                                .value=${this.audioMode}
                                @change=${this.handleAudioModeSelect}
                            >
                                <option value="speaker_only">
                                    Speaker Only (Interviewer)
                                </option>

                                <option value="mic_only">
                                    Microphone Only (Me)
                                </option>

                                <option value="both">
                                    Both Speaker and Microphone
                                </option>
                            </select>

                            ${
                                this.audioMode !== 'speaker_only'
                                    ? html`
                                          <div class="warning-callout">
                                              This mode may behave differently depending
                                              on your audio device configuration.
                                          </div>
                                      `
                                    : ''
                            }
                        </div>
                    </div>

                    <div class="setting-row">
                        <div>
                            <label class="setting-label">
                                Capture quality
                            </label>

                            <p class="setting-help">
                                Higher quality can improve visual analysis
                                but may use more resources.
                            </p>
                        </div>

                        <div class="setting-control">
                            <select
                                class="control"
                                .value=${this.selectedImageQuality}
                                @change=${this.handleImageQualitySelect}
                            >
                                <option value="high">
                                    High Quality
                                </option>

                                <option value="medium">
                                    Medium Quality
                                </option>

                                <option value="low">
                                    Low Quality
                                </option>
                            </select>
                        </div>
                    </div>
                </div>
            </section>
        `;
    }

    renderLanguageSection() {
        return html`
            <section class="settings-card">
                <div class="card-header">
                    <div class="card-title-row">
                        <div class="section-icon">
                            ◎
                        </div>

                        <div>
                            <h2 class="section-title">
                                Language
                            </h2>

                            <p class="section-description">
                                Configure your preferred spoken language.
                            </p>
                        </div>
                    </div>
                </div>

                <div class="card-body">
                    <div class="setting-row">
                        <div>
                            <label class="setting-label">
                                Spoken language
                            </label>

                            <p class="setting-help">
                                Select the language and regional dialect
                                used during conversations.
                            </p>
                        </div>

                        <div class="setting-control">
                            <select
                                class="control"
                                .value=${this.selectedLanguage}
                                @change=${this.handleLanguageSelect}
                            >
                                ${this.getLanguages().map(
                                    language => html`
                                        <option
                                            value=${language.value}
                                        >
                                            ${language.name}
                                        </option>
                                    `
                                )}
                            </select>
                        </div>
                    </div>
                </div>
            </section>
        `;
    }

    renderPrivacySection() {
        return html`
            <section class="settings-card">
                <div class="card-header">
                    <div class="card-title-row">
                        <div class="section-icon">
                            ◇
                        </div>

                        <div>
                            <h2 class="section-title">
                                Privacy & Data
                            </h2>

                            <p class="section-description">
                                Manage application preferences and locally stored data.
                            </p>
                        </div>
                    </div>
                </div>

                <div class="card-body">
                    <div class="privacy-row">
                        <div class="privacy-info">
                            <label class="setting-label">
                                Reset settings
                            </label>

                            <p class="setting-help">
                                Restore application preferences to their default values.
                                Your local data will not be deleted.
                            </p>
                        </div>

                        <button
                            class="secondary-button"
                            @click=${this.restoreAllSettings}
                            ?disabled=${this.isRestoring}
                        >
                            ${
                                this.isRestoring
                                    ? 'Resetting...'
                                    : 'Reset settings'
                            }
                        </button>
                    </div>

                    <div class="danger-zone">
                        <div class="danger-zone-row">
                            <div>
                                <div class="danger-zone-title">
                                    Danger zone
                                </div>

                                <label class="setting-label">
                                    Delete all local data
                                </label>

                                <p class="setting-help">
                                    Permanently remove all locally stored
                                    application data. This action cannot be undone.
                                </p>
                            </div>

                            <button
                                class="danger-button"
                                @click=${this.openDeleteConfirmation}
                                ?disabled=${this.isClearing}
                            >
                                ${
                                    this.isClearing
                                        ? 'Deleting...'
                                        : 'Delete all data'
                                }
                            </button>
                        </div>
                    </div>

                    ${
                        this.clearStatusMessage
                            ? html`
                                  <div
                                      class="status ${
                                          this.clearStatusType === 'success'
                                              ? 'success'
                                              : 'error'
                                      }"
                                  >
                                      ${this.clearStatusMessage}
                                  </div>
                              `
                            : ''
                    }
                </div>
            </section>
        `;
    }

    renderDeleteConfirmation() {
        if (!this.showDeleteConfirmation) {
            return '';
        }

        return html`
            <div
                class="modal-backdrop"
                @click=${e => {
                    if (e.target === e.currentTarget) {
                        this.closeDeleteConfirmation();
                    }
                }}
            >
                <div
                    class="modal"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="delete-modal-title"
                >
                    <div class="modal-icon">
                        !
                    </div>

                    <h2
                        class="modal-title"
                        id="delete-modal-title"
                    >
                        Delete all local data?
                    </h2>

                    <p class="modal-description">
                        This will permanently remove all locally
                        stored application data. This action cannot
                        be undone.
                    </p>

                    <div class="modal-actions">
                        <button
                            class="secondary-button"
                            @click=${this.closeDeleteConfirmation}
                        >
                            Cancel
                        </button>

                        <button
                            class="danger-button"
                            @click=${this.confirmDeleteData}
                        >
                            Delete all data
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    render() {
        return html`
            <div class="settings-page">
                <div class="settings-container">

                    <div class="page-heading">
                        <h1 class="page-title">
                            Settings
                        </h1>

                        <p class="page-subtitle">
                            Customize your application preferences.
                        </p>
                    </div>

                    ${this.renderAppearanceSection()}
                    ${this.renderAudioSection()}
                    ${this.renderLanguageSection()}
                    ${this.renderPrivacySection()}

                </div>

                ${this.renderDeleteConfirmation()}
            </div>
        `;
    }
}

customElements.define('customize-view', CustomizeView);