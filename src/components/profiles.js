// Single source of truth for the session profiles ("modes") the UI offers.
//
// This list used to be copy-pasted into six places — the start dropdown, the
// Profile tab, the live bar, the answer window, the session history, and a
// couple of dead helpers. They drifted: Coding Interview and System Design had
// working prompts and appeared in the start dropdown, but the Profile tab,
// answer window, and history list had never heard of them, so picking either
// mode showed a blank or raw label and gave you no way to set up context for
// it. Every one of those sites now imports from here.
//
// `value` must match a key in profilePrompts (or PROFILE_KEY_ALIASES) in
// src/utils/prompts.js — scripts/test-profile-registry.js enforces that, so a
// profile can never again be offered in the UI without a prompt behind it.

export const PROFILES = [
    { value: 'interview', label: 'Job Interview' },
    { value: 'behavioral', label: 'Behavioral Interview' },
    { value: 'coding', label: 'Coding Interview' },
    { value: 'system_design', label: 'System Design' },
    { value: 'case', label: 'Case Interview' },
    { value: 'sales', label: 'Sales Call' },
    { value: 'meeting', label: 'Business Meeting' },
    { value: 'presentation', label: 'Presentation' },
    { value: 'negotiation', label: 'Negotiation' },
    { value: 'exam', label: 'Exam Assistant' },
    { value: 'assistant', label: 'Assistant' },
];

// value → label, for the places that only need to render a name.
export const PROFILE_LABELS = Object.fromEntries(PROFILES.map(p => [p.value, p.label]));

// Falls back to the raw value so an unknown profile degrades to something
// readable instead of rendering "undefined".
export function getProfileLabel(value) {
    return PROFILE_LABELS[value] || value || 'Session';
}
