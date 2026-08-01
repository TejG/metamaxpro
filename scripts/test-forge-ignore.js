// Quick validation of forge.config.js ignore rules.
const c = require('../forge.config.js');
const ig = c.packagerConfig.ignore;
const test = p => ig.some(r => r.test(p));
const cases = [
    ['onnxruntime-web ignored', test('/node_modules/onnxruntime-web/dist/x.js'), true],
    ['onnx other-platform ignored', test('/node_modules/onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime.so'), true],
    ['onnx current-platform kept', test(`/node_modules/onnxruntime-node/bin/napi-v3/${process.platform}/arm64/lib.dylib`), false],
    ['plain tesseract wasm ignored', test('/node_modules/tesseract.js-core/tesseract-core.wasm.js'), true],
    ['simd wasm ignored', test('/node_modules/tesseract.js-core/tesseract-core-simd.wasm'), true],
    ['lstm-only wasm ignored', test('/node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js'), true],
    ['simd-lstm wasm kept', test('/node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js'), false],
    ['relaxedsimd-lstm kept', test('/node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm'), false],
    ['app source kept', test('/src/utils/prompts.js'), false],
    ['package.json kept', test('/package.json'), false],
    ['scripts ignored', test('/scripts/smoke-test.js'), true],
    ['md ignored', test('/README.md'), true],
];
let failed = 0;
for (const [name, actual, expected] of cases) {
    const ok = actual === expected;
    console.log(`${ok ? '✅' : '❌'} ${name}`);
    if (!ok) failed++;
}
console.log(`\n${cases.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
