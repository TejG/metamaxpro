import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';
import { unifiedPageStyles } from './sharedPageStyles.js';

export class AICustomizeView extends LitElement {
    static styles = [
        unifiedPageStyles,
        css`
            .unified-page {
                height: 100%;
            }
            .unified-wrap {
                height: 100%;
            }
            section.surface {
                flex: 1;
                display: flex;
                flex-direction: column;
            }
            .form-grid {
                flex: 1;
                display: flex;
                flex-direction: column;
            }
            .form-group.vertical {
                flex: 1;
                display: flex;
                flex-direction: column;
            }
            textarea.control {
                flex: 1;
                resize: none;
                overflow-y: auto;
                min-height: 0;
            }
        `,
    ];

    static properties = {
        selectedProfile: { type: String },
        onProfileChange: { type: Function },
        _context: { state: true },
        _jobDescription: { state: true },
        _avoidWords: { state: true },
    };

    constructor() {
        super();
        this.selectedProfile = 'interview';
        this.onProfileChange = () => {};
        this._context = '';
        this._jobDescription = '';
        this._avoidWords = '';
        this._loadFromStorage();
    }

    async _loadFromStorage() {
        try {
            const prefs = await metaMaxPro.storage.getPreferences();
            this._context = prefs.customPrompt || '';
            this._jobDescription = prefs.jobDescription || '';
            this._avoidWords = prefs.avoidWords || '';
            this.requestUpdate();
        } catch (error) {
            console.error('Error loading AI customize storage:', error);
        }
    }

    async _saveAvoidWords(val) {
        this._avoidWords = val;
        await metaMaxPro.storage.updatePreference('avoidWords', val);
    }

    _handleProfileChange(e) {
        this.onProfileChange(e.target.value);
    }

    async _saveContext(val) {
        this._context = val;
        await metaMaxPro.storage.updatePreference('customPrompt', val);
    }

    async _saveJobDescription(val) {
        this._jobDescription = val;
        await metaMaxPro.storage.updatePreference('jobDescription', val);
    }

    _getProfileName(profile) {
        const names = {
            interview: 'Job Interview',
            sales: 'Sales Call',
            meeting: 'Business Meeting',
            presentation: 'Presentation',
            negotiation: 'Negotiation',
            exam: 'Exam Assistant',
        };
        return names[profile] || profile;
    }

    render() {
        const profiles = [
            { value: 'interview', label: 'Job Interview' },
            { value: 'sales', label: 'Sales Call' },
            { value: 'meeting', label: 'Business Meeting' },
            { value: 'presentation', label: 'Presentation' },
            { value: 'negotiation', label: 'Negotiation' },
            { value: 'exam', label: 'Exam Assistant' },
        ];

        return html`
            <div class="unified-page">
                <div class="unified-wrap">
                    <div>
                        <div class="page-title">AI Context</div>
                    </div>

                    <section class="surface">
                        <div class="form-grid">
                            <div class="form-group">
                                <label class="form-label">Profile</label>
                                <select class="control" .value=${this.selectedProfile} @change=${this._handleProfileChange}>
                                    ${profiles.map(profile => html`<option value=${profile.value}>${profile.label}</option>`)}
                                </select>
                            </div>
                            <div class="form-group vertical">
                                <label class="form-label">Resume / Background</label>
                                <textarea
                                    class="control"
                                    placeholder="Paste your resume, experience, skills, projects, companies worked at, achievements..."
                                    .value=${this._context}
                                    @input=${e => this._saveContext(e.target.value)}
                                ></textarea>
                                <div class="form-help">Your background — used to ground every answer in real experience.</div>
                            </div>
                            <div class="form-group vertical">
                                <label class="form-label">Job Description (JD)</label>
                                <textarea
                                    class="control"
                                    placeholder="Paste the job description or role requirements here..."
                                    .value=${this._jobDescription}
                                    @input=${e => this._saveJobDescription(e.target.value)}
                                ></textarea>
                                <div class="form-help">Answers will be tailored to highlight what this specific role values.</div>
                            </div>
                            <div class="form-group vertical">
                                <label class="form-label">Words / phrases to avoid</label>
                                <textarea
                                    class="control"
                                    placeholder="Comma-separated words or phrases you'd never say, e.g. leverage, robust, spearheaded, at the end of the day..."
                                    .value=${this._avoidWords}
                                    @input=${e => this._saveAvoidWords(e.target.value)}
                                ></textarea>
                                <div class="form-help">The assistant will never use these — makes answers sound like you.</div>
                            </div>
                        </div>
                    </section>

                </div>
            </div>
        `;
    }
}

customElements.define('ai-customize-view', AICustomizeView);
