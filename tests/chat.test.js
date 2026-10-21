import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldStream, pickLLMConfig, ASK_ACTION_ID, createThrottle, isRetryableError } from '../lib/chat.js';

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
