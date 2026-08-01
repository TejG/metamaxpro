// Tests for the header/footer UI cleanup:
//  - live-bar restructure (no overlap: status pill on the left, ellipsis, no absolute center)
//  - font A−/A+ moved from the header to the assistant footer
//  - footer mode selector now applies LIVE via the update-profile IPC
// Run: node scripts/test-header-ui.js
const path = require('path');
const fs = require('fs');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('src/components/app/MetaMaxProApp.js');
const av = read('src/components/views/AssistantView.js');
const llm = read('src/utils/llm/index.js');

let passed = 0,
    failed = 0;
function check(name, cond) {
    if (cond) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failed++;
        console.error(`  ✗ ${name}`);
    }
}

console.log('— header (live bar) —');
const liveBarRender = app.slice(app.indexOf('renderLiveBar()'), app.indexOf('render() {'));
check('font A−/A+ removed from live bar', !liveBarRender.includes('_changeFontSize'));
check('status rendered as pill', liveBarRender.includes('status-pill'));
check('status pill has live/busy dot states', app.includes('.status-pill.ok') && app.includes('.status-pill.busy'));
check('absolute-centered label retired', /\.live-bar-center \{[^}]*display: none/.test(app));
check('left cluster can shrink (min-width: 0)', /\.live-bar-left \{[^}]*min-width: 0/s.test(app));
check('status pill ellipsizes instead of overlapping', /\.status-pill \{[^}]*text-overflow: ellipsis/s.test(app));
check('right cluster never shrinks', /\.live-bar-right \{[^}]*flex-shrink: 0/s.test(app));
check('mode label still visible (left, non-absolute)', liveBarRender.includes('live-bar-mode'));

console.log('— appearance popover in footer (font + transparency, one button) —');
check('AssistantView exposes onFontSizeChange', av.includes('onFontSizeChange: { type: Function }'));
check('AssistantView exposes onTransparencyChange', av.includes('onTransparencyChange: { type: Function }'));
check('parent wires onFontSizeChange to _changeFontSize', app.includes('.onFontSizeChange=${d => this._changeFontSize(d)}'));
check('parent wires onTransparencyChange', app.includes('.onTransparencyChange=${v => this._changeTransparency(v)}'));
check('single Aa button (no loose A−/A+ in footer)', av.includes('appearance-btn') && !av.includes('class="font-btn"'));
check('popover has text size stepper', av.includes('onFontSizeChange(-1)') && av.includes('onFontSizeChange(1)') && av.includes('stepper'));
check('popover has transparency slider', av.includes('appearance-slider') && av.includes('onTransparencyChange(parseFloat'));
check('popover closes on outside click', av.includes('_closeAppearance') && av.includes("addEventListener('click', this._closeAppearance, true)"));
check('outside-click listener cleaned up on disconnect', /disconnectedCallback[\s\S]{0,400}removeEventListener\('click', this\._closeAppearance/.test(av));
check('no duplicate disconnectedCallback', (av.match(/^\s{4}disconnectedCallback\(\)/gm) || []).length === 1);
check('_changeFontSize still persists and clamps', app.includes("updatePreference('fontSize'") && app.includes('Math.min(32, Math.max(11'));
check('_changeTransparency persists preference', app.includes("updatePreference('backgroundTransparency'"));
check('_changeTransparency uses shared theme pipeline', app.includes('metaMaxPro.theme.applyBackgrounds(colors.background, v)'));
check('_changeTransparency clamps range', app.includes('Math.min(1, Math.max(0.1'));
check('saved transparency seeds popover on startup', app.includes('this._transparency = prefs.backgroundTransparency ?? 0.8'));
check('popover shows live values', av.includes('${this.fontSizeValue || 16}px') && av.includes('Math.round((this.transparencyValue ?? 0.8) * 100)'));

console.log('— live mode switch (no more dummy selector) —');
check('main registers update-profile IPC', llm.includes("ipcMain.handle('update-profile'"));
check('update-profile rebuilds the system prompt', /update-profile[\s\S]{0,600}getSystemPrompt\(profile/.test(llm));
check('update-profile updates S.currentProfile', /update-profile[\s\S]{0,600}S\.currentProfile = profile/.test(llm));
check('update-profile validates input', /update-profile[\s\S]{0,300}Invalid profile/.test(llm));
check('renderer invokes update-profile when session active', app.includes("ipcRenderer.invoke('update-profile', profile)"));
check('renderer confirms switch in status', app.includes('Mode switched ✓'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
