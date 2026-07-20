#!/usr/bin/env node
/**
 * Generate the app icons (logo.png / logo.icns / logo.ico) from the mascot SVG.
 *
 * Re-run whenever the mascot art changes:  node scripts/generate-icons.js
 *
 * Requires: sharp (dep) + png-to-ico (devDep). macOS `iconutil` is used for the
 * .icns; if it's unavailable the .icns step is skipped with a warning.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default || require('png-to-ico');

const ASSETS = path.join(__dirname, '..', 'src', 'assets');
const SRC_SVG = path.join(ASSETS, 'mascot', 'max.svg');
const BASE = 1024; // master icon size
const PAD_RATIO = 0.08; // breathing room around the mascot

async function buildBasePng() {
    const svg = fs.readFileSync(SRC_SVG);
    const inner = BASE - Math.round(BASE * PAD_RATIO) * 2;

    // Rasterize the mascot at high density, fit into the inner square (keeps the
    // portrait aspect ratio, transparent bars), then center on a square canvas.
    const mascot = await sharp(svg, { density: 300 })
        .resize({ width: inner, height: inner, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();

    return sharp({ create: { width: BASE, height: BASE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: mascot, gravity: 'center' }])
        .png()
        .toBuffer();
}

async function resizePng(buf, size) {
    return sharp(buf).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

async function main() {
    if (!fs.existsSync(SRC_SVG)) {
        console.error('Mascot SVG not found at', SRC_SVG);
        process.exit(1);
    }

    const base = await buildBasePng();

    // logo.png (used as the Linux icon + generic fallback)
    fs.writeFileSync(path.join(ASSETS, 'logo.png'), base);
    console.log('✓ logo.png');

    // logo.ico (Windows) — multi-size
    const icoSizes = [16, 24, 32, 48, 64, 128, 256];
    const icoBufs = await Promise.all(icoSizes.map(s => resizePng(base, s)));
    const ico = await pngToIco(icoBufs);
    fs.writeFileSync(path.join(ASSETS, 'logo.ico'), ico);
    console.log('✓ logo.ico');

    // logo.icns (macOS) — via iconutil on a generated .iconset
    try {
        execFileSync('which', ['iconutil']);
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iconset-'));
        const iconset = path.join(tmp, 'logo.iconset');
        fs.mkdirSync(iconset);
        const icnsSpec = [
            [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
            [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
            [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
            [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
            [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
        ];
        for (const [size, name] of icnsSpec) {
            fs.writeFileSync(path.join(iconset, name), await resizePng(base, size));
        }
        execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(ASSETS, 'logo.icns')]);
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log('✓ logo.icns');
    } catch (e) {
        console.warn('⚠ Skipped logo.icns (iconutil unavailable — run on macOS):', e.message);
    }

    console.log('Done. App icons regenerated from the mascot.');
}

main().catch(err => { console.error(err); process.exit(1); });
