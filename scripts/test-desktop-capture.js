// Tests for the no-screen-share screenshot capture (desktopCapturer path).
// Run: node scripts/test-desktop-capture.js

const path = require('path');
const fs = require('fs');
const assert = require('assert');

let passed = 0,
    failed = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`❌ ${name}: ${e.message}`);
        failed++;
    }
}

const root = path.join(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(root, 'src', 'utils', 'renderer.js'), 'utf8');

// ── Main process handler ──

test('capture-screen-frame IPC handler registered in main', () => {
    assert(indexSrc.includes("ipcMain.handle('capture-screen-frame'"));
});

test('handler uses desktopCapturer screen sources', () => {
    assert(indexSrc.includes('desktopCapturer'));
    assert(/types:\s*\['screen'\]/.test(indexSrc));
});

test('handler prefers primary display and caps width at 1600', () => {
    assert(indexSrc.includes('getPrimaryDisplay'));
    assert(indexSrc.includes('1600'));
});

test('handler maps quality to JPEG quality levels', () => {
    assert(/quality === 'high' \? 90/.test(indexSrc));
});

// ── Renderer ──

test('macOS no longer opens a getDisplayMedia screen-share session', () => {
    const macBlock = rendererSrc.slice(rendererSrc.indexOf('if (isMacOS)'), rendererSrc.indexOf('} else if (isLinux)'));
    assert(!macBlock.includes('navigator.mediaDevices.getDisplayMedia'), 'macOS branch still calls getDisplayMedia');
    assert(macBlock.includes('start-macos-audio'), 'macOS audio capture missing');
});

test('Windows/Linux still use getDisplayMedia (loopback audio depends on it)', () => {
    const rest = rendererSrc.slice(rendererSrc.indexOf('} else if (isLinux)'));
    assert(rest.includes('getDisplayMedia'), 'Windows/Linux screen+audio capture removed!');
});

test('_captureFrameAsBase64 falls back to IPC when no stream', () => {
    assert(rendererSrc.includes("invoke('capture-screen-frame'"));
});

test('manual screenshot no longer hard-requires mediaStream', () => {
    const fnStart = rendererSrc.indexOf('async function captureManualScreenshot');
    const fnBody = rendererSrc.slice(fnStart, fnStart + 600);
    assert(!fnBody.includes('No media stream available'), 'captureManualScreenshot still guards on mediaStream');
});

test('buffer screenshot no longer hard-requires mediaStream', () => {
    const fnStart = rendererSrc.indexOf('async function captureScreenshotToBuffer');
    const fnBody = rendererSrc.slice(fnStart, fnStart + 400);
    assert(!fnBody.includes('No media stream available'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
