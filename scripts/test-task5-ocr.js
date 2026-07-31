// Test suite for Task 5: OCR for Screenshots
// Tests ocr.js text extraction and caching

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    extractTextFromImage,
    extractTextFromImages,
    isOcrSufficient,
    getCacheStats,
    clearCache,
    terminateWorker,
    OCR_CONFIDENCE_THRESHOLD,
    OCR_MIN_TEXT_LENGTH,
} = require('../src/utils/llm/ocr');

console.log('=== Task 5: OCR for Screenshots Tests ===\n');

let passedTests = 0;
let totalTests = 0;

function test(description, fn) {
    totalTests++;
    return fn()
        .then(() => {
            passedTests++;
            console.log(`✅ Test ${totalTests}: ${description}`);
        })
        .catch(e => {
            console.error(`❌ Test ${totalTests}: ${description}`);
            console.error(`   Error: ${e.message}`);
            if (e.stack) {
                console.error(`   Stack: ${e.stack.split('\n').slice(1, 3).join('\n')}`);
            }
        });
}

// Helper: Create a simple test image with text (synthetic base64)
// For actual testing, we'll use real screenshot data
function createTestImageBase64() {
    // This is a 1x1 transparent PNG as placeholder
    // In real tests, we'd use actual screenshots
    return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
}

// Helper: Create base64 image from text (for testing)
// Note: This is a mock - real implementation would need canvas or image library
function createImageWithText(text) {
    // Return a unique base64 string based on text content
    // This simulates different images with different text
    const textHash = Buffer.from(text).toString('base64');
    return `mock_image_${textHash}`;
}

async function runTests() {
    console.log('Note: Tesseract worker initialization may take 5-10 seconds on first run...\n');

    // ────────────────────────────────────────────────────────────────────
    // Test 1: Basic OCR extraction (will use mock data)
    // ────────────────────────────────────────────────────────────────────

    await test('Extract text from image (initialization)', async () => {
        console.log('   Initializing Tesseract worker (this may take a moment)...');
        const testImage = createTestImageBase64();
        const result = await extractTextFromImage(testImage);

        // OCR worker should initialize and return result (may be empty for 1x1 pixel)
        assert(result.success !== undefined, 'Should return success status');
        assert(result.text !== undefined, 'Should return text (even if empty)');
        assert(result.confidence !== undefined, 'Should return confidence score');
        assert(result.duration !== undefined, 'Should return duration');
        console.log(`   Result: ${result.text ? result.text.length : 0} chars, ${Math.round(result.confidence)}% confidence, ${result.duration}ms`);
    });

    // ────────────────────────────────────────────────────────────────────
    // Test 2: OCR caching
    // ────────────────────────────────────────────────────────────────────

    await test('Cache OCR results (same image twice)', async () => {
        clearCache();
        const testImage = createTestImageBase64();

        // First extraction
        const result1 = await extractTextFromImage(testImage);
        assert(result1.success, 'First extraction should succeed');
        assert(!result1.cached, 'First extraction should not be cached');

        // Second extraction (should be cached)
        const result2 = await extractTextFromImage(testImage);
        assert(result2.success, 'Second extraction should succeed');
        assert(result2.cached, 'Second extraction should be from cache');
        assert.strictEqual(result2.text, result1.text, 'Cached text should match');
        assert.strictEqual(result2.confidence, result1.confidence, 'Cached confidence should match');

        console.log(`   Cache stats: ${getCacheStats().size} entries`);
    });

    // ────────────────────────────────────────────────────────────────────
    // Test 3: isOcrSufficient decision logic
    // ────────────────────────────────────────────────────────────────────

    await test('isOcrSufficient decision logic', async () => {
        // Case 1: High confidence, sufficient text
        const good = {
            success: true,
            text: 'This is a clear text with enough content for OCR',
            confidence: 85,
        };
        assert(isOcrSufficient(good), 'Should accept high-confidence result');

        // Case 2: Low confidence
        const lowConfidence = {
            success: true,
            text: 'Some text here',
            confidence: 50,
        };
        assert(!isOcrSufficient(lowConfidence), `Should reject confidence <${OCR_CONFIDENCE_THRESHOLD}%`);

        // Case 3: Too short
        const tooShort = {
            success: true,
            text: 'Hi',
            confidence: 90,
        };
        assert(!isOcrSufficient(tooShort), `Should reject text <${OCR_MIN_TEXT_LENGTH} chars`);

        // Case 4: Failed OCR
        const failed = {
            success: false,
            error: 'OCR failed',
        };
        assert(!isOcrSufficient(failed), 'Should reject failed OCR');

        console.log(`   Thresholds: ${OCR_CONFIDENCE_THRESHOLD}% confidence, ${OCR_MIN_TEXT_LENGTH} chars minimum`);
    });

    // ────────────────────────────────────────────────────────────────────
    // Test 4: Multiple images extraction
    // ────────────────────────────────────────────────────────────────────

    await test('Extract text from multiple images', async () => {
        clearCache();
        const images = [createTestImageBase64(), createTestImageBase64(), createTestImageBase64()];

        const result = await extractTextFromImages(images);
        assert(result.success, 'Multi-image extraction should succeed');
        assert.strictEqual(result.results.length, 3, 'Should return 3 results');
        assert(result.totalDuration !== undefined, 'Should return total duration');

        console.log(`   Processed ${result.results.length} images in ${result.totalDuration}ms`);
    });

    // ────────────────────────────────────────────────────────────────────
    // Test 5: Empty image array handling
    // ────────────────────────────────────────────────────────────────────

    await test('Handle empty image array gracefully', async () => {
        const result = await extractTextFromImages([]);
        assert(!result.success, 'Should fail for empty array');
        assert(result.error, 'Should return error message');
    });

    // ────────────────────────────────────────────────────────────────────
    // Test 6: Invalid image data handling
    // ────────────────────────────────────────────────────────────────────

    await test('Handle invalid image data gracefully', async () => {
        const result = await extractTextFromImage(null);
        assert(!result.success, 'Should fail for null image');
        assert(result.error, 'Should return error message');
    });

    // ────────────────────────────────────────────────────────────────────
    // Test 7: Cache clearing
    // ────────────────────────────────────────────────────────────────────

    await test('Clear cache removes all entries', async () => {
        // Populate cache
        await extractTextFromImage(createTestImageBase64());
        const beforeStats = getCacheStats();
        const beforeSize = beforeStats.size;

        // Clear cache
        clearCache();
        const afterStats = getCacheStats();

        assert.strictEqual(afterStats.size, 0, 'Cache should be empty after clear');
        console.log(`   Cleared ${beforeSize} cache entries`);
    });

    // ────────────────────────────────────────────────────────────────────
    // Cleanup
    // ────────────────────────────────────────────────────────────────────

    await terminateWorker();

    // ────────────────────────────────────────────────────────────────────
    // Test Results
    // ────────────────────────────────────────────────────────────────────

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Test Results: ${passedTests}/${totalTests} passed`);
    if (passedTests === totalTests) {
        console.log('✅ All tests passed!');
        console.log('\nNote: These are unit tests with mock data.');
        console.log('For full validation, test with real screenshots in integration tests.');
        process.exit(0);
    } else {
        console.log(`❌ ${totalTests - passedTests} test(s) failed`);
        process.exit(1);
    }
}

runTests().catch(error => {
    console.error('Test suite error:', error);
    process.exit(1);
});
