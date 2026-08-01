// OCR text extraction using Tesseract.js — extract text from screenshots before
// sending to vision API to reduce costs.
//
// Flow: screenshot → OCR → if text confidence >70% use OCR result, else fallback to vision API
// Caching: same screenshot (by base64 hash) → reuse cached OCR result

const { createWorker } = require('tesseract.js');

// OCR result cache: { [imageHash]: { text, confidence, timestamp } }
const ocrCache = new Map();
const OCR_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const OCR_CONFIDENCE_THRESHOLD = 85; // Use OCR only if confidence >= 85% (below this, junk text slipped through)
const OCR_MIN_TEXT_LENGTH = 200; // Must extract a substantial block of text — short fragments (menu labels, window chrome) are NOT a text-heavy screenshot
const OCR_MIN_WORD_RATIO = 0.7; // At least 70% of extracted tokens must look like real words

let worker = null;
let workerInitializing = false;

/**
 * Initialize Tesseract worker (lazy initialization).
 * Returns the worker instance or throws error.
 */
async function initializeWorker() {
    if (worker) return worker;
    if (workerInitializing) {
        // Wait for existing initialization to complete
        while (workerInitializing) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return worker;
    }

    workerInitializing = true;
    try {
        console.log('[OCR] Initializing Tesseract worker...');
        const startTime = Date.now();
        worker = await createWorker('eng');
        const duration = Date.now() - startTime;
        console.log(`[OCR] Worker initialized in ${duration}ms`);
        workerInitializing = false;
        return worker;
    } catch (error) {
        workerInitializing = false;
        console.error('[OCR] Worker initialization failed:', error);
        throw error;
    }
}

/**
 * Terminate the Tesseract worker to free resources.
 */
async function terminateWorker() {
    if (worker) {
        try {
            await worker.terminate();
            worker = null;
            console.log('[OCR] Worker terminated');
        } catch (error) {
            console.error('[OCR] Worker termination error:', error);
        }
    }
}

/**
 * Generate a simple hash from base64 image data for caching.
 * Uses first 100 + last 100 chars to detect identical screenshots.
 */
function hashImageData(base64Data) {
    const prefix = base64Data.substring(0, 100);
    const suffix = base64Data.substring(Math.max(0, base64Data.length - 100));
    return `${prefix}_${suffix}_${base64Data.length}`;
}

/**
 * Clean up expired cache entries.
 */
function cleanExpiredCache() {
    const now = Date.now();
    for (const [hash, entry] of ocrCache.entries()) {
        if (now - entry.timestamp > OCR_CACHE_TTL_MS) {
            ocrCache.delete(hash);
        }
    }
}

/**
 * Extract text from a screenshot using OCR.
 * 
 * @param {string} base64Image - Base64-encoded image data (without data:image/jpeg;base64, prefix)
 * @returns {Promise<{ success: boolean, text?: string, confidence?: number, cached?: boolean, duration?: number, error?: string }>}
 */
async function extractTextFromImage(base64Image) {
    if (!base64Image || typeof base64Image !== 'string') {
        return { success: false, error: 'Invalid image data' };
    }

    // Check cache first
    const imageHash = hashImageData(base64Image);
    cleanExpiredCache();

    if (ocrCache.has(imageHash)) {
        const cached = ocrCache.get(imageHash);
        console.log(`[OCR] Cache hit (${cached.text.length} chars, ${cached.confidence}% confidence)`);
        return {
            success: true,
            text: cached.text,
            confidence: cached.confidence,
            cached: true,
            duration: 0,
        };
    }

    // Perform OCR
    const startTime = Date.now();
    try {
        const ocrWorker = await initializeWorker();

        // Convert base64 to buffer
        const buffer = Buffer.from(base64Image, 'base64');

        // Recognize text
        const { data } = await ocrWorker.recognize(buffer);
        const duration = Date.now() - startTime;

        const extractedText = data.text?.trim() || '';
        const confidence = data.confidence || 0;

        console.log(`[OCR] Extracted ${extractedText.length} chars in ${duration}ms (${Math.round(confidence)}% confidence)`);

        // Cache the result
        ocrCache.set(imageHash, {
            text: extractedText,
            confidence,
            timestamp: Date.now(),
        });

        return {
            success: true,
            text: extractedText,
            confidence,
            cached: false,
            duration,
        };
    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`[OCR] Extraction failed after ${duration}ms:`, error.message);
        return {
            success: false,
            error: error.message,
            duration,
        };
    }
}

/**
 * Determine if OCR result is good enough to use instead of vision API.
 * 
 * @param {Object} ocrResult - Result from extractTextFromImage
 * @returns {boolean} True if OCR is sufficient, false if vision API needed
 */
function isOcrSufficient(ocrResult) {
    if (!ocrResult.success) return false;
    if (!ocrResult.text || ocrResult.text.length < OCR_MIN_TEXT_LENGTH) return false;
    if (ocrResult.confidence < OCR_CONFIDENCE_THRESHOLD) return false;

    // Sanity check: most extracted tokens should look like real words.
    // OCR of graphical UIs produces fragments like "x O @ # |] {" that used to
    // pass the old length/confidence check and starve the LLM of the actual
    // image, producing generic "I'm ready to help" answers.
    const tokens = ocrResult.text.split(/\s+/).filter(t => t.length > 0);
    if (tokens.length < 20) return false; // too few words to be a text-heavy screen
    const wordLike = tokens.filter(t => /^[A-Za-z0-9][A-Za-z0-9.,;:!?'"()\-_/]*$/.test(t)).length;
    if (wordLike / tokens.length < OCR_MIN_WORD_RATIO) return false;

    return true;
}

/**
 * Extract text from multiple screenshots.
 * 
 * @param {string[]} base64Images - Array of base64-encoded images
 * @returns {Promise<{ success: boolean, results: Array, allSufficient: boolean, totalDuration: number }>}
 */
async function extractTextFromImages(base64Images) {
    if (!Array.isArray(base64Images) || base64Images.length === 0) {
        return { success: false, results: [], allSufficient: false, totalDuration: 0, error: 'No images provided' };
    }

    const startTime = Date.now();
    const results = [];
    let allSufficient = true;

    for (const image of base64Images) {
        const result = await extractTextFromImage(image);
        results.push(result);
        if (!isOcrSufficient(result)) {
            allSufficient = false;
        }
    }

    const totalDuration = Date.now() - startTime;

    return {
        success: true,
        results,
        allSufficient,
        totalDuration,
    };
}

/**
 * Get cache statistics for debugging.
 */
function getCacheStats() {
    cleanExpiredCache();
    return {
        size: ocrCache.size,
        entries: Array.from(ocrCache.entries()).map(([hash, entry]) => ({
            hash: hash.substring(0, 20) + '...',
            textLength: entry.text.length,
            confidence: Math.round(entry.confidence),
            age: Math.round((Date.now() - entry.timestamp) / 1000) + 's',
        })),
    };
}

/**
 * Clear the OCR cache.
 */
function clearCache() {
    ocrCache.clear();
    console.log('[OCR] Cache cleared');
}

module.exports = {
    extractTextFromImage,
    extractTextFromImages,
    isOcrSufficient,
    terminateWorker,
    getCacheStats,
    clearCache,
    OCR_CONFIDENCE_THRESHOLD,
    OCR_MIN_TEXT_LENGTH,
};
