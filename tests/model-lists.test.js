import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchAvailableModels } from '../lib/api-client.js';

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

const ids = (models) => models.map(m => m.id);

// ── Anthropic ──

test('anthropic: asks for 1000 per page and follows after_id while has_more', async (t) => {
  const calls = stubFetch(t, (url, _o, n) => (n === 1
    ? json({ data: [{ id: 'claude-a', display_name: 'Claude A' }], has_more: true, last_id: 'claude-a' })
    : json({ data: [{ id: 'claude-b', display_name: 'Claude B' }], has_more: false, last_id: 'claude-b' })));
  const models = await fetchAvailableModels('anthropic', 'k');
  assert.deepEqual(models, [{ id: 'claude-a', name: 'Claude A' }, { id: 'claude-b', name: 'Claude B' }]);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/v1\/models\?limit=1000$/);
  assert.match(calls[1].url, /[?&]after_id=claude-a(&|$)/);
  assert.equal(calls[0].options.headers['x-api-key'], 'k');
});

test('anthropic: stops after 5 pages even when has_more stays true', async (t) => {
  const calls = stubFetch(t, (_u, _o, n) => json({ data: [{ id: `m${n}` }], has_more: true, last_id: `m${n}` }));
  const models = await fetchAvailableModels('anthropic', 'k');
  assert.equal(calls.length, 5);
  assert.deepEqual(ids(models), ['m1', 'm2', 'm3', 'm4', 'm5']);
});

test('anthropic: has_more without last_id ends the loop', async (t) => {
  const calls = stubFetch(t, () => json({ data: [{ id: 'x' }], has_more: true }));
  await fetchAvailableModels('anthropic', 'k');
  assert.equal(calls.length, 1);
});

test('anthropic: drops deprecated and retired models, keeps active and unlabeled', async (t) => {
  stubFetch(t, () => json({
    data: [
      { id: 'a-active', lifecycle: 'active' },
      { id: 'a-deprecated', lifecycle: 'deprecated' },
      { id: 'a-retired', lifecycle: 'retired' },
      { id: 'a-plain' }
    ],
    has_more: false
  }));
  assert.deepEqual(ids(await fetchAvailableModels('anthropic', 'k')), ['a-active', 'a-plain']);
});

// ── Gemini ──

test('google: asks for 1000 per page and follows nextPageToken', async (t) => {
  const gen = ['generateContent'];
  const calls = stubFetch(t, (_u, _o, n) => (n === 1
    ? json({ models: [{ name: 'models/gemini-a', displayName: 'Gemini A', supportedGenerationMethods: gen }], nextPageToken: 'tok 1' })
    : json({ models: [{ name: 'models/gemini-b', displayName: 'Gemini B', supportedGenerationMethods: gen }] })));
  const models = await fetchAvailableModels('google', 'k');
  assert.deepEqual(models, [{ id: 'gemini-a', name: 'Gemini A' }, { id: 'gemini-b', name: 'Gemini B' }]);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\?pageSize=1000$/);
  assert.match(calls[1].url, /[?&]pageToken=tok%201(&|$)/);
});

test('google: stops after 5 pages', async (t) => {
  const calls = stubFetch(t, (_u, _o, n) => json({
    models: [{ name: `models/gemini-${n}`, supportedGenerationMethods: ['generateContent'] }],
    nextPageToken: `t${n}`
  }));
  await fetchAvailableModels('google', 'k');
  assert.equal(calls.length, 5);
});

test('google: keeps text models, drops non-generateContent and image/tts/embedding/live/etc.', async (t) => {
  const gen = ['generateContent', 'countTokens'];
  const names = [
    'gemini-3.8-flash', 'gemini-4-argon', 'gemini-3.5-flash-lite',
    'gemini-3.6-flash-image', 'gemini-embedding-002', 'imagen-5', 'veo-4',
    'gemini-3.6-flash-tts', 'gemini-live-3.6-flash', 'aqa', 'nano-banana-pro',
    'gemini-3-transcribe', 'gemini-robotics-er-2', 'gemini-3-computer-use',
    'lyria-3', 'gemini-omni-1', 'gemini-translate-1'
  ];
  stubFetch(t, () => json({
    models: [
      ...names.map(n => ({ name: `models/${n}`, supportedGenerationMethods: gen })),
      { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] }
    ]
  }));
  assert.deepEqual(ids(await fetchAvailableModels('google', 'k')), ['gemini-3.8-flash', 'gemini-4-argon', 'gemini-3.5-flash-lite']);
});

// ── OpenAI ──

test('openai: keeps chat-completions models, drops non-chat and Responses-only ones', async (t) => {
  const kept = ['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.4-mini', 'o3', 'o4-mini', 'chat-latest', 'chatgpt-4o-latest'];
  const dropped = [
    'gpt-6.1-sol-pro', 'gpt-5.2-codex', 'gpt-realtime', 'text-embedding-3-large', 'tts-1',
    'whisper-1', 'gpt-image-2', 'dall-e-3', 'omni-moderation-latest', 'gpt-5-search-api',
    'computer-use-preview', 'o3-deep-research', 'gpt-oss-120b', 'gpt-3.5-turbo-instruct',
    'babbage-002', 'davinci-002', 'gpt-4o-audio-preview', 'gpt-4o-transcribe', 'gpt-live-1',
    'gpt-6-cyber', 'gpt-daybreak-1', 'ft:custom-model'
  ];
  stubFetch(t, () => json({ data: [...kept, ...dropped].map(id => ({ id, object: 'model' })) }));
  const got = ids(await fetchAvailableModels('openai', 'k'));
  assert.deepEqual([...got].sort(), [...kept].sort());
});

// ── OpenRouter ──

test('openrouter: drops :batch entries and models without text output', async (t) => {
  stubFetch(t, () => json({
    data: [
      { id: 'a/text-model', name: 'A Text', architecture: { output_modalities: ['text'] } },
      { id: 'a/text-model:batch', name: 'A Text (batch)', architecture: { output_modalities: ['text'] } },
      { id: 'b/image-only', name: 'B Image', architecture: { output_modalities: ['image'] } },
      { id: 'c/mixed', name: 'C Mixed', architecture: { output_modalities: ['image', 'text'] } },
      { id: 'd/no-arch', name: 'D No arch' }
    ]
  }));
  assert.deepEqual(ids(await fetchAvailableModels('openrouter', '')), ['a/text-model', 'c/mixed', 'd/no-arch']);
});

test('model list errors surface as APIError', async (t) => {
  stubFetch(t, () => json({ error: { message: 'invalid x-api-key' } }, 401));
  await assert.rejects(fetchAvailableModels('anthropic', 'bad'), (err) => err.name === 'APIError' && err.status === 401);
});
