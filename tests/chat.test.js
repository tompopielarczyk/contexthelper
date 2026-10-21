import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldStream, pickLLMConfig, ASK_ACTION_ID, createThrottle, isRetryableError, buildAskPrompt } from '../lib/chat.js';

test('shouldStream truth table', () => {
  assert.equal(shouldStream({ provider: 'deepl', displayMode: 'tooltip', editable: false }), false);
  assert.equal(shouldStream({ provider: 'anthropic', displayMode: 'tooltip', editable: false }), true);
  assert.equal(shouldStream({ provider: 'anthropic', displayMode: 'auto', editable: true }), false);
  assert.equal(shouldStream({ provider: 'anthropic', displayMode: 'auto', editable: false }), true);
  assert.equal(shouldStream({ provider: 'anthropic', displayMode: 'insert', editable: false }), false);
});

test('pickLLMConfig', () => {
  const deepl = { id: 'd', provider: 'deepl' };
  const claude = { id: 'c', provider: 'anthropic' };
  const gpt = { id: 'g', provider: 'openai' };
  assert.equal(pickLLMConfig([deepl, claude, gpt], 'g'), gpt);
  assert.equal(pickLLMConfig([deepl, claude, gpt], 'missing'), claude);
  assert.equal(pickLLMConfig([deepl, claude, gpt]), claude);
  assert.equal(pickLLMConfig([deepl]), null);
  assert.equal(pickLLMConfig([]), null);
  assert.equal(pickLLMConfig(undefined), null);
});

test('ASK_ACTION_ID', () => {
  assert.equal(ASK_ACTION_ID, '__ask__');
});

test('createThrottle fires once with the last arg', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const got = [];
  const th = createThrottle(v => got.push(v), 100);
  th.call(1);
  t.mock.timers.tick(30);
  th.call(2);
  t.mock.timers.tick(30);
  th.call(3);
  assert.deepEqual(got, []);
  t.mock.timers.tick(100);
  assert.deepEqual(got, [3]);
  t.mock.timers.tick(500);
  assert.deepEqual(got, [3]);
});

test('createThrottle flush calls immediately with the pending arg', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const got = [];
  const th = createThrottle(v => got.push(v), 100);
  th.call('a');
  th.flush();
  assert.deepEqual(got, ['a']);
  t.mock.timers.tick(200);
  assert.deepEqual(got, ['a']);
  th.flush(); // nothing pending
  assert.deepEqual(got, ['a']);
});

test('createThrottle cancel drops the pending arg', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const got = [];
  const th = createThrottle(v => got.push(v), 100);
  th.call('a');
  th.cancel();
  t.mock.timers.tick(200);
  th.flush();
  assert.deepEqual(got, []);
});

function apiError(status) {
  const err = new Error('x');
  err.name = 'APIError';
  err.status = status;
  return err;
}

test('isRetryableError', () => {
  assert.equal(isRetryableError(apiError(0)), true);
  assert.equal(isRetryableError(apiError(429)), true);
  assert.equal(isRetryableError(apiError(500)), true);
  assert.equal(isRetryableError(apiError(503)), true);
  assert.equal(isRetryableError(apiError(401)), false);
  assert.equal(isRetryableError(apiError(403)), false);
  assert.equal(isRetryableError(apiError(456)), false);
  assert.equal(isRetryableError(apiError(400)), false);
  assert.equal(isRetryableError(new Error('Missing API key')), false);
  assert.equal(isRetryableError(new DOMException('Request cancelled', 'AbortError')), false);
  assert.equal(isRetryableError(null), false);
});

// --- Task 4: refine ---------------------------------------------------------
import { buildRefineMessages, sanitizeConversation, REFINE_PRESETS, MAX_CONVERSATION_MESSAGES } from '../lib/chat.js';

const conv = [{ role: 'user', content: 'P' }, { role: 'assistant', content: 'R' }];
test('buildRefineMessages appends instruction / drops last answer on retry', () => {
  assert.deepEqual(buildRefineMessages(conv, ' Shorter '), [...conv, { role: 'user', content: 'Shorter' }]);
  assert.deepEqual(buildRefineMessages(conv, null), [{ role: 'user', content: 'P' }]);
});
test('sanitizeConversation rejects malformed input', () => {
  assert.equal(sanitizeConversation(null), null);
  assert.equal(sanitizeConversation([]), null);
  assert.equal(sanitizeConversation([{ role: 'assistant', content: 'x' }]), null);
  assert.equal(sanitizeConversation([{ role: 'user', content: 'x' }]), null); // must end with assistant
  assert.equal(sanitizeConversation([{ role: 'user', content: 1 }, { role: 'assistant', content: 'r' }]), null);
  assert.equal(sanitizeConversation([{ role: 'system', content: 'x' }, { role: 'assistant', content: 'r' }]), null);
  assert.deepEqual(sanitizeConversation(conv), conv);
});
test('sanitizeConversation trims to first pair + last 18', () => {
  const long = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) }));
  const out = sanitizeConversation(long);
  assert.equal(out.length, 20);
  assert.deepEqual(out.slice(0, 3).map(m => m.content), ['0', '1', '22']);
  out.forEach((m, i) => i && assert.notEqual(m.role, out[i - 1].role));
});
test('sanitizeConversation rejects broken alternation, oversize content and non-arrays', () => {
  assert.equal(sanitizeConversation('nope'), null);
  assert.equal(sanitizeConversation([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' },
    { role: 'assistant', content: 'c' }, { role: 'assistant', content: 'd' }]), null);
  assert.equal(sanitizeConversation([{ role: 'user', content: 'x'.repeat(100_001) }, { role: 'assistant', content: 'r' }]), null);
  assert.deepEqual(sanitizeConversation([{ role: 'user', content: 'x'.repeat(100_000) }, { role: 'assistant', content: 'r' }])?.length, 2);
  assert.equal(sanitizeConversation([null, { role: 'assistant', content: 'r' }]), null);
});
test('sanitizeConversation strips extra fields', () => {
  const out = sanitizeConversation([{ role: 'user', content: 'P', extra: 1 }, { role: 'assistant', content: 'R' }]);
  assert.deepEqual(out, conv);
});
test('REFINE_PRESETS and MAX_CONVERSATION_MESSAGES', () => {
  assert.equal(MAX_CONVERSATION_MESSAGES, 20);
  assert.deepEqual(REFINE_PRESETS, {
    shorter: 'Make it shorter. Return only the revised text.',
    longer: 'Expand it with more detail. Return only the revised text.',
    simpler: 'Rewrite it in simpler language. Return only the revised text.'
  });
});

// --- Task 4 review fixes ----------------------------------------------------
import { resolveRefineInstruction, sanitizeClientId } from '../lib/chat.js';

test('sanitizeConversation keeps exactly 20 messages untrimmed', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) }));
  assert.deepEqual(sanitizeConversation(twenty), twenty);
});
test('resolveRefineInstruction maps presets, follow-ups and retry', () => {
  assert.equal(resolveRefineInstruction({ preset: 'shorter' }), REFINE_PRESETS.shorter);
  assert.equal(resolveRefineInstruction({ preset: 'longer' }), REFINE_PRESETS.longer);
  assert.equal(resolveRefineInstruction({ preset: 'simpler' }), REFINE_PRESETS.simpler);
  assert.equal(resolveRefineInstruction({ instruction: '  Make it formal ' }), 'Make it formal');
  assert.equal(resolveRefineInstruction({}), null);
  assert.equal(resolveRefineInstruction({ instruction: null }), null);
});
test('resolveRefineInstruction rejects unknown presets and bad instructions', () => {
  for (const bad of [{ preset: 'toString' }, { preset: 'louder' }, { preset: 1 },
    { instruction: '   ' }, { instruction: 5 }]) {
    assert.throws(() => resolveRefineInstruction(bad), { message: 'Unknown refine option' });
  }
});
test('sanitizeClientId', () => {
  assert.equal(sanitizeClientId('abc-123'), 'abc-123');
  assert.equal(sanitizeClientId('x'.repeat(64)), 'x'.repeat(64));
  assert.equal(sanitizeClientId('x'.repeat(65)), null);
  assert.equal(sanitizeClientId(''), null);
  assert.equal(sanitizeClientId(42), null);
  assert.equal(sanitizeClientId(undefined), null);
});

test('buildAskPrompt', () => {
  assert.equal(buildAskPrompt('  Why? ', 'abc'), 'Why?\n\nSelected text:\n"""\nabc\n"""');
});
