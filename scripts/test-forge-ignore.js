// Quick validation of forge.config.js ignore rules.
const c = require('../forge.config.js');
const ig = c.packagerConfig.ignore;
const test = p => ig.some(r => r.test(p));
const cases = [
    ['onnxruntime-web ignored', test('/node_modules/onnxruntime-web/dist/x.js'), true],
    ['onnx other-platform ignored', test('/node_modules/onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime.so'), true],
    ['onnx current-platform kept', test(`/node_modules/onnxruntime-node/bin/napi-v3/${process.platform}/arm64/lib.dylib`), false],
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
