import test from 'node:test';
import assert from 'node:assert/strict';

import { extractAnthropicText, extractChatCompletionText, extractGeminiText } from '../lib/api-client.js';

test('extracts provider text when present', () => {
  assert.equal(extractAnthropicText({ content: [{ text: ' hello\n' }] }), ' hello\n');
  assert.equal(extractChatCompletionText({ choices: [{ message: { content: '\nhi ' } }] }, 'OpenAI'), '\nhi ');
  assert.equal(extractGeminiText({ candidates: [{ content: { parts: [{ text: ' hey\n' }] } }] }), ' hey\n');
});

test('throws useful errors for empty or blocked provider responses', () => {
  assert.throws(() => extractAnthropicText({ content: [] }), /empty response/i);
  assert.throws(() => extractChatCompletionText({ choices: [{ finish_reason: 'content_filter', message: {} }] }, 'OpenAI'), /content_filter/i);
  assert.throws(() => extractGeminiText({ promptFeedback: { blockReason: 'SAFETY' } }), /SAFETY/i);
});
