import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldWarnUnknownModel, modelCacheKey, keyFingerprint } from '../lib/model-list.js';

const IDS = ['claude-sonnet-5-5', 'claude-opus-5-5'];

test('never warns against the built-in list', () => {
  assert.equal(shouldWarnUnknownModel('claude-new-6', IDS, 'builtin', false), false);
});

test('warns for an ID missing from a live or cached list', () => {
  assert.equal(shouldWarnUnknownModel('claude-new-6', IDS, 'live', false), true);
  assert.equal(shouldWarnUnknownModel('claude-new-6', IDS, 'cache', false), true);
});

test('no warning for an ID on the list, an empty value or an empty list', () => {
  assert.equal(shouldWarnUnknownModel('claude-opus-5-5', IDS, 'live', false), false);
  assert.equal(shouldWarnUnknownModel('  claude-opus-5-5 ', IDS, 'live', false), false);
  assert.equal(shouldWarnUnknownModel('', IDS, 'live', false), false);
  assert.equal(shouldWarnUnknownModel('x', [], 'live', false), false);
});

test('a model confirmed by Test never warns', () => {
  assert.equal(shouldWarnUnknownModel('claude-new-6', IDS, 'live', true), false);
});

test('unknown list sources are treated as untrusted', () => {
  assert.equal(shouldWarnUnknownModel('x', IDS, undefined, false), false);
  assert.equal(shouldWarnUnknownModel('x', IDS, 'stale', false), false);
});

test('cache keys: per key fingerprint, bare openrouter, custom per base URL, none for DeepL', () => {
  assert.equal(modelCacheKey('anthropic', 'abcdef012345'), 'anthropic:abcdef012345');
  assert.equal(modelCacheKey('openai', 'ffffffffffff'), 'openai:ffffffffffff');
  assert.equal(modelCacheKey('google', '000000000000'), 'google:000000000000');
  assert.equal(modelCacheKey('openrouter', 'abcdef012345'), 'openrouter');
  assert.equal(modelCacheKey('custom', '', 'http://localhost:11434/v1'), 'custom:http://localhost:11434/v1');
  assert.equal(modelCacheKey('deepl', 'abcdef012345'), null);
});

test('a keyed provider without a fingerprint has no cache key', () => {
  assert.equal(modelCacheKey('anthropic', ''), null);
  assert.equal(modelCacheKey('custom', '', ''), null);
});

test('keyFingerprint is the first 12 hex chars of SHA-256', async () => {
  assert.equal(await keyFingerprint('abc'), 'ba7816bf8f01');
  assert.notEqual(await keyFingerprint('sk-one'), await keyFingerprint('sk-two'));
  assert.match(await keyFingerprint('sk-ant-secret'), /^[0-9a-f]{12}$/);
});
