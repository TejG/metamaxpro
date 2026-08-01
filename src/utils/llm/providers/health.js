// Provider circuit breaker.
// When a provider fails with a quota/credit/billing error, the cascade used to
// re-try it on EVERY question — each dead provider cost a full failed
// round-trip (~1-2s) before falling through to the one that actually answers.
// This module remembers failures for a cooldown window so the cascade can skip
// dead providers instantly. Answer quality is untouched: providers come back
// automatically when the cooldown expires (and quota errors reset over time).

const _downUntil = new Map(); // name → epoch ms

// Cooldowns tuned to the failure type:
// - quota/rate (429 daily/TPD): won't recover for a while → 10 min
// - credit/billing (400/401/403): needs human action → 30 min
// - transient (5xx/timeouts): short → 60 s
const COOLDOWN_MS = {
    quota: 10 * 60 * 1000,
    billing: 30 * 60 * 1000,
    transient: 60 * 1000,
};

function markDown(name, kind = 'transient') {
    const ms = COOLDOWN_MS[kind] || COOLDOWN_MS.transient;
    _downUntil.set(name, Date.now() + ms);
    console.log(`[health] ${name} marked down for ${Math.round(ms / 1000)}s (${kind})`);
}

function isDown(name) {
    const until = _downUntil.get(name);
    if (!until) return false;
    if (Date.now() >= until) {
        _downUntil.delete(name);
        return false;
    }
    return true;
}

function markUp(name) {
    _downUntil.delete(name);
}

// Classify a provider HTTP failure into a cooldown kind, or null if it should
// NOT trip the breaker (e.g. model-specific 404/400 that the adapter handles
// by trying another model).
function classifyFailure(status, errText = '') {
    const t = String(errText).toLowerCase();
    if (status === 429) {
        // Daily/TPD quota exhaustion vs per-minute rate limit
        return /per day|daily|tpd|quota/i.test(t) ? 'quota' : 'transient';
    }
    if ((status === 400 || status === 401 || status === 403) && /credit|billing|balance|payment|plan/i.test(t)) return 'billing';
    if (status === 401 || status === 403) return 'billing';
    if (status >= 500) return 'transient';
    return null;
}

function _resetForTests() {
    _downUntil.clear();
}

module.exports = { markDown, isDown, markUp, classifyFailure, _resetForTests };
