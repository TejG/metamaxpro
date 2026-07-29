// Test suite for Task 4: Smart Resume Section Filtering
// Tests resumeParser.js and contextFilter.js

const assert = require('assert');
const { parseResumeSections, getSectionSummary } = require('../src/utils/llm/resumeParser');
const { getRelevantResumeSections, classifyQuestionIntent, estimateTokenReduction } = require('../src/utils/llm/contextFilter');

const SAMPLE_RESUME_STANDARD = `
John Doe
Software Engineer

SUMMARY
Experienced full-stack engineer with 5 years building scalable web applications.

EXPERIENCE
Senior Software Engineer, Meta
2021 - Present
- Built real-time collaboration features using React and WebSockets
- Reduced API latency by 40% through caching optimizations

Software Engineer, Google
2019 - 2021
- Developed search indexing pipeline processing 10M documents/day
- Led migration from monolith to microservices architecture

SKILLS
JavaScript, TypeScript, React, Node.js, Python, AWS, Docker, Kubernetes, PostgreSQL

PROJECTS
MetaQuest - AI interview assistant
- Built Electron app with real-time transcription
- Integrated Groq, Anthropic, and Gemini LLMs

EDUCATION
BS Computer Science, Stanford University
2015 - 2019, GPA 3.8
`;

const SAMPLE_RESUME_NONSTANDARD = `
Jane Smith | jane@example.com

PROFESSIONAL BACKGROUND
Lead Engineer @ Amazon | 2020-Present
Architected serverless event processing system handling 1M events/hour

CORE COMPETENCIES
Python, Go, AWS Lambda, DynamoDB, Redis, Terraform, CI/CD

ACADEMIC QUALIFICATIONS
Master of Science in Computer Science, MIT, 2020
`;

const SAMPLE_RESUME_NO_HEADERS = `
Alex Johnson
alex@example.com

Full-stack developer with 3 years experience building web apps.
JavaScript, React, Node.js, MongoDB, AWS.
Created e-commerce platform with 50k users.
Graduated from UC Berkeley with BS in CS, 2021.
`;

console.log('=== Task 4: Smart Resume Section Filtering Tests ===\n');

let passedTests = 0;
let totalTests = 0;

function test(description, fn) {
    totalTests++;
    try {
        fn();
        passedTests++;
        console.log(`✅ Test ${totalTests}: ${description}`);
    } catch (e) {
        console.error(`❌ Test ${totalTests}: ${description}`);
        console.error(`   Error: ${e.message}`);
    }
}

// ────────────────────────────────────────────────────────────────────
// Test Group 1: Resume Parsing
// ────────────────────────────────────────────────────────────────────

test('Parse resume with standard headings', () => {
    const sections = parseResumeSections(SAMPLE_RESUME_STANDARD);
    assert(sections.experience.includes('Meta'), 'Should extract experience');
    assert(sections.skills.includes('JavaScript'), 'Should extract skills');
    assert(sections.projects.includes('MetaQuest'), 'Should extract projects');
    assert(sections.education.includes('Stanford'), 'Should extract education');
    assert(sections.summary.includes('full-stack'), 'Should extract summary');
});

test('Parse resume with non-standard headings', () => {
    const sections = parseResumeSections(SAMPLE_RESUME_NONSTANDARD);
    assert(sections.experience.includes('Amazon'), 'Should extract from PROFESSIONAL BACKGROUND');
    assert(sections.skills.includes('Python'), 'Should extract from CORE COMPETENCIES');
    assert(sections.education.includes('MIT'), 'Should extract from ACADEMIC QUALIFICATIONS');
});

test('Handle resume without clear section markers', () => {
    const sections = parseResumeSections(SAMPLE_RESUME_NO_HEADERS);
    // Heuristic should detect some content
    const allContent = Object.values(sections).join(' ');
    assert(allContent.includes('JavaScript'), 'Should preserve content');
    assert(allContent.includes('Berkeley'), 'Should preserve education content');
});

// ────────────────────────────────────────────────────────────────────
// Test Group 2: Intent Classification
// ────────────────────────────────────────────────────────────────────

test('Classify technical question', () => {
    const intent1 = classifyQuestionIntent('How would you implement a rate limiter in Node.js?');
    const intent2 = classifyQuestionIntent('Explain how React hooks work');
    assert(intent1 === 'technical', 'Should detect technical question (implementation)');
    assert(intent2 === 'technical', 'Should detect technical question (framework)');
});

test('Classify behavioral question', () => {
    const intent1 = classifyQuestionIntent('Tell me about a time you handled a conflict with a teammate');
    const intent2 = classifyQuestionIntent('Describe a situation where you failed');
    assert(intent1 === 'behavioral', 'Should detect STAR-style question');
    assert(intent2 === 'behavioral', 'Should detect behavioral question');
});

test('Classify project question', () => {
    const intent = classifyQuestionIntent('Walk me through a project you built from scratch');
    assert(intent === 'project', 'Should detect project question');
});

test('Classify education question', () => {
    const intent = classifyQuestionIntent('What did you study in university?');
    assert(intent === 'education', 'Should detect education question');
});

test('Classify summary question', () => {
    const intent = classifyQuestionIntent('Tell me about yourself');
    assert(intent === 'summary', 'Should detect introduction request');
});

// ────────────────────────────────────────────────────────────────────
// Test Group 3: Section Filtering
// ────────────────────────────────────────────────────────────────────

test('Technical question returns Skills + Experience sections', () => {
    const filtered = getRelevantResumeSections(
        'How do you optimize database queries?',
        SAMPLE_RESUME_STANDARD
    );
    assert(filtered.includes('[SKILLS]'), 'Should include skills section');
    assert(filtered.includes('[EXPERIENCE]'), 'Should include experience section');
    assert(filtered.includes('JavaScript'), 'Should have skills content');
    assert(filtered.includes('Meta'), 'Should have experience content');
    assert(!filtered.includes('Stanford') || filtered.includes('[EDUCATION]'), 'Should not include education unless marked');
});

test('Behavioral question returns Experience + Projects sections', () => {
    const filtered = getRelevantResumeSections(
        'Tell me about a time you led a difficult project',
        SAMPLE_RESUME_STANDARD
    );
    assert(filtered.includes('[EXPERIENCE]'), 'Should include experience');
    assert(filtered.includes('[PROJECTS]'), 'Should include projects');
    assert(filtered.includes('Meta') || filtered.includes('Google'), 'Should have experience content');
});

test('Education question returns Education section', () => {
    const filtered = getRelevantResumeSections(
        'What did you study at university?',
        SAMPLE_RESUME_STANDARD
    );
    assert(filtered.includes('[EDUCATION]'), 'Should include education section');
    assert(filtered.includes('Stanford'), 'Should have education content');
});

test('Generic question returns Experience + Skills default', () => {
    const filtered = getRelevantResumeSections(
        'What are your strengths?',
        SAMPLE_RESUME_STANDARD
    );
    assert(filtered.includes('[EXPERIENCE]') || filtered.includes('[SKILLS]'), 'Should include default sections');
});

// ────────────────────────────────────────────────────────────────────
// Test Group 4: Token Reduction
// ────────────────────────────────────────────────────────────────────

test('Token count reduction measured (expect 30-50% reduction)', () => {
    const fullResume = SAMPLE_RESUME_STANDARD;
    const filtered = getRelevantResumeSections(
        'How do you handle API errors?',
        fullResume
    );
    const reduction = estimateTokenReduction(fullResume, filtered);
    console.log(`   Reduction: ${reduction}% (full: ${fullResume.length} chars, filtered: ${filtered.length} chars)`);
    assert(reduction >= 20, `Should reduce by at least 20% (got ${reduction}%)`);
    assert(reduction <= 80, `Should not reduce more than 80% (got ${reduction}%)`);
});

// ────────────────────────────────────────────────────────────────────
// Test Results
// ────────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log(`Test Results: ${passedTests}/${totalTests} passed`);
if (passedTests === totalTests) {
    console.log('✅ All tests passed!');
    process.exit(0);
} else {
    console.log(`❌ ${totalTests - passedTests} test(s) failed`);
    process.exit(1);
}
