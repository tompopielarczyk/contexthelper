import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchDeepLTargetLanguages } from '../lib/api-client.js';
import { deeplLangsCacheKey, targetLangOptions } from '../lib/model-list.js';

const REAL_FETCH = globalThis.fetch;

function stubFetch(t, makeResponse) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return makeResponse(String(url), options, calls.length);
  };
  t.after(() => { globalThis.fetch = REAL_FETCH; });
  return calls;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json' }
});

// ── fetchDeepLTargetLanguages ──

test('v3: keeps usable_as_target, upper-cases BCP-47 codes, sorts by name', async (t) => {
  const calls = stubFetch(t, () => json([
    { lang: 'en-US', name: 'English (American)', usable_as_source: false, usable_as_target: true },
    { lang: 'de', name: 'German', usable_as_source: true, usable_as_target: true },
    { lang: 'en', name: 'English', usable_as_source: true, usable_as_target: false },
    { lang: 'zh-Hant', name: 'Chinese (traditional)', usable_as_source: false, usable_as_target: true }
  ]));
  const langs = await fetchDeepLTargetLanguages('pro-key');
  assert.deepEqual(langs, [
    { id: 'ZH-HANT', name: 'Chinese (traditional)' },
    { id: 'EN-US', name: 'English (American)' },
    { id: 'DE', name: 'German' }
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepl.com/v3/languages?resource=translate_text');
  assert.equal(calls[0].options.headers['Authorization'], 'DeepL-Auth-Key pro-key');
});

test('a free key (:fx) uses api-free.deepl.com', async (t) => {
  const calls = stubFetch(t, () => json([{ lang: 'pl', name: 'Polish', usable_as_target: true }]));
  await fetchDeepLTargetLanguages('free-key:fx');
  assert.match(calls[0].url, /^https:\/\/api-free\.deepl\.com\/v3\/languages\?/);
});

test('v3 404 falls back to /v2/languages?type=target', async (t) => {
  const calls = stubFetch(t, (url) => (url.includes('/v3/')
    ? json({ message: 'Not found' }, 404)
    : json([
      { language: 'PT-BR', name: 'Portuguese (Brazilian)', supports_formality: true },
      { language: 'bg', name: 'Bulgarian', supports_formality: false }
    ])));
  const langs = await fetchDeepLTargetLanguages('k:fx');
  assert.deepEqual(langs, [
    { id: 'BG', name: 'Bulgarian' },
    { id: 'PT-BR', name: 'Portuguese (Brazilian)' }
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api-free.deepl.com/v2/languages?type=target');
  assert.equal(calls[1].options.headers['Authorization'], 'DeepL-Auth-Key k:fx');
});

test('duplicate codes (case-insensitive) are dropped, malformed entries skipped', async (t) => {
  stubFetch(t, () => json([
    { lang: 'de', name: 'German', usable_as_target: true },
    { lang: 'DE', name: 'German again', usable_as_target: true },
    { lang: '', name: 'Empty', usable_as_target: true },
    { name: 'No code', usable_as_target: true },
    null
  ]));
  assert.deepEqual(await fetchDeepLTargetLanguages('k'), [{ id: 'DE', name: 'German' }]);
});

test('a bad key (403) maps to the invalid-key error, other errors do not fall back', async (t) => {
  const calls = stubFetch(t, () => json({ message: 'Forbidden' }, 403));
  await assert.rejects(fetchDeepLTargetLanguages('bad'), (err) => err.status === 401);
  assert.equal(calls.length, 1);
});

// ── Pure helpers ──

test('deeplLangsCacheKey: deepl-langs:<fingerprint>, none without one', () => {
  assert.equal(deeplLangsCacheKey('abcdef012345'), 'deepl-langs:abcdef012345');
  assert.equal(deeplLangsCacheKey(''), null);
});

const LIST = [{ id: 'DE', name: 'German' }, { id: 'EN-US', name: 'English (American)' }];

test('targetLangOptions: the list as is, the saved value selected', () => {
  const { options, value } = targetLangOptions(LIST, { saved: 'EN-US' });
  assert.deepEqual(options, LIST);
  assert.equal(value, 'EN-US');
});

test('a saved value missing from the list is kept as an option', () => {
  const { options, value } = targetLangOptions(LIST, { saved: 'XX-YY' });
  assert.deepEqual(options.map(o => o.id), ['DE', 'EN-US', 'XX-YY']);
  assert.equal(value, 'XX-YY');
});

test('a saved lowercase value is normalized to upper case', () => {
  const { options, value } = targetLangOptions(LIST, { saved: ' en-us ' });
  assert.deepEqual(options.map(o => o.id), ['DE', 'EN-US']);
  assert.equal(value, 'EN-US');
  const other = targetLangOptions(LIST, { saved: 'zh-hant' });
  assert.deepEqual(other.options.map(o => o.id), ['DE', 'EN-US', 'ZH-HANT']);
  assert.equal(other.value, 'ZH-HANT');
});

test('the current selection wins over the saved value; both stay as options', () => {
  const { options, value } = targetLangOptions(LIST, { saved: 'XX', current: 'YY' });
  assert.deepEqual(options.map(o => o.id), ['DE', 'EN-US', 'XX', 'YY']);
  assert.equal(value, 'YY');
});

test('no saved or current value: no extra option, the first entry is selected', () => {
  const { options, value } = targetLangOptions(LIST, {});
  assert.deepEqual(options, LIST);
  assert.equal(value, 'DE');
  assert.deepEqual(targetLangOptions([], {}), { options: [], value: '' });
});

test('list entries are normalized and deduplicated too', () => {
  const { options } = targetLangOptions([{ id: 'de', name: 'German' }, { id: 'DE', name: 'Dup' }], {});
  assert.deepEqual(options, [{ id: 'DE', name: 'German' }]);
});
