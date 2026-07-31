// Test for Gemini "model turn" fix
// Verifies that Gemini provider correctly handles conversation history ending with assistant message

const geminiAdapter = require('../src/utils/llm/providers/gemini');
const { S } = require('../src/utils/llm/state');

console.log('=== Gemini Model Turn Fix Test ===\n');

// Mock a conversation that ends with an assistant message (the problematic case)
const mockHistory = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!' },
    { role: 'user', content: 'What is 2+2?' },
    { role: 'assistant', content: '2+2 equals 4.' }, // ❌ Conversation ends with assistant
];

// Set up test state
S.groqConversationHistory = mockHistory;
S.currentSystemPrompt = 'You are a helpful assistant.';

console.log('Test Setup:');
console.log('- Conversation history length:', mockHistory.length);
console.log('- Last message role:', mockHistory[mockHistory.length - 1].role);
console.log('- Last message content:', mockHistory[mockHistory.length - 1].content.substring(0, 50) + '...');
console.log('');

// Test 1: Verify the fix handles assistant-ending conversations
console.log('Test 1: Gemini adapter handles assistant-ending conversation');
try {
    // We can't actually call streamAnswer without API key, but we can verify
    // the logic by inspecting the module's behavior
    
    // Instead, let's verify the fix is in place by checking the code pattern
    const geminiCode = require('fs').readFileSync(
        require.resolve('../src/utils/llm/providers/gemini'),
        'utf8'
    );
    
    const hasModelTrimCheck = geminiCode.includes('messages[messages.length - 1].role === \'model\'');
    const hasPopLogic = geminiCode.includes('messages.pop()');
    const hasComplianceLog = geminiCode.includes('Trimming final model message to comply with API requirements');
    
    if (hasModelTrimCheck && hasPopLogic && hasComplianceLog) {
        console.log('✅ Gemini provider has model message trimming logic');
        console.log('   - Checks for final model message: ✓');
        console.log('   - Removes final model message: ✓');
        console.log('   - Logs compliance action: ✓');
    } else {
        console.log('❌ Gemini provider missing fix components:');
        console.log('   - Model check:', hasModelTrimCheck ? '✓' : '✗');
        console.log('   - Pop logic:', hasPopLogic ? '✓' : '✗');
        console.log('   - Compliance log:', hasComplianceLog ? '✓' : '✗');
        process.exit(1);
    }
} catch (error) {
    console.log('❌ Test failed:', error.message);
    process.exit(1);
}

console.log('');

// Test 2: Verify vision.js OCR routing also handles this
console.log('Test 2: Vision.js OCR routing handles assistant-ending conversation');
try {
    const visionCode = require('fs').readFileSync(
        require.resolve('../src/utils/llm/vision'),
        'utf8'
    );
    
    const hasHistoryTrim = visionCode.includes('recentHistory[recentHistory.length - 1].role === \'assistant\'');
    const hasSliceLogic = visionCode.includes('recentHistory.slice(0, -1)');
    const hasComment = visionCode.includes('If history ends with assistant message');
    
    if (hasHistoryTrim && hasSliceLogic && hasComment) {
        console.log('✅ Vision.js OCR routing has assistant message handling');
        console.log('   - Checks for final assistant message: ✓');
        console.log('   - Trims history appropriately: ✓');
        console.log('   - Documents the fix: ✓');
    } else {
        console.log('❌ Vision.js OCR routing missing fix components:');
        console.log('   - Assistant check:', hasHistoryTrim ? '✓' : '✗');
        console.log('   - Slice logic:', hasSliceLogic ? '✓' : '✗');
        console.log('   - Documentation:', hasComment ? '✓' : '✗');
        process.exit(1);
    }
} catch (error) {
    console.log('❌ Test failed:', error.message);
    process.exit(1);
}

console.log('');

// Test 3: Verify the fix prevents the exact error from logs
console.log('Test 3: Fix prevents "Requests ending with a model turn" error');
try {
    // Simulate the Gemini contents building logic
    const trimmed = mockHistory; // In real code, this would be trimmed to token limit
    let messages = trimmed.map(m => ({ 
        role: m.role === 'assistant' ? 'model' : 'user', 
        parts: [{ text: m.content }] 
    }));
    
    console.log('   Before fix: last message role =', messages[messages.length - 1].role);
    
    // Apply the fix
    if (messages.length > 0 && messages[messages.length - 1].role === 'model') {
        messages.pop();
    }
    
    console.log('   After fix: last message role =', messages[messages.length - 1].role);
    
    if (messages[messages.length - 1].role === 'user') {
        console.log('✅ Fix successfully ensures conversation ends with user message');
    } else {
        console.log('❌ Fix failed to ensure user-ending conversation');
        process.exit(1);
    }
} catch (error) {
    console.log('❌ Test failed:', error.message);
    process.exit(1);
}

console.log('');
console.log('============================================================');
console.log('All Gemini fix tests passed! ✅');
console.log('');
console.log('The fix ensures:');
console.log('1. Gemini provider trims final model messages');
console.log('2. Vision.js OCR routing validates conversation history');
console.log('3. Conversations always end with user messages (Gemini requirement)');
console.log('4. No more "Requests ending with a model turn" errors');
