// Tests for the provider circuit breaker (latency fix: skip dead providers).
// Run: node scripts/test-circuit-breaker.js
const path = require('path');
const fs = require('fs');

const health = require(path.join(__dirname, '..', 'src', 'utils', 'llm', 'providers', 'health.js'));

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

console.log('— health module behavior —');
health._resetForTests();
check('provider starts up', !health.isDown('groq'));
health.markDown('groq', 'quota');
check('markDown → isDown true', health.isDown('groq'));
check('other providers unaffected', !health.isDown('anthropic'));
health.markUp('groq');
check('markUp clears the breaker', !health.isDown('groq'));

console.log('— classifyFailure —');
check('429 daily quota → quota', health.classifyFailure(429, 'Rate limit reached ... tokens per day (TPD)') === 'quota');
check('429 plain rate limit → transient', health.classifyFailure(429, 'requests per minute') === 'transient');
check('400 credit-low → billing', health.classifyFailure(400, 'Your credit balance is too low') === 'billing');
check('401 → billing', health.classifyFailure(401, '') === 'billing');
check('500 → transient', health.classifyFailure(500, '') === 'transient');
check('model-specific 400 → null (no trip)', health.classifyFailure(400, 'invalid model id') === null);
check('404 → null (no trip)', health.classifyFailure(404, 'not found') === null);

console.log('— wiring —');
const read = f => fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'llm', f), 'utf8');
const router = read('router.js');
check('router imports health', /require\('\.\/providers\/health'\)/.test(router));
check('router skips down providers in cascade', /health\.isDown\(adapter\.name\)/.test(router));
const groq = read('providers/groq.js');
check('groq trips breaker on account failures', /classifyFailure/.test(groq) && /markDown\('groq'/.test(groq));
const anthropic = read('providers/anthropic.js');
check('anthropic trips breaker on account failures', /classifyFailure/.test(anthropic) && /markDown\('anthropic'/.test(anthropic));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
