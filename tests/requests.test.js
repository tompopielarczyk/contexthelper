// Request bodies and headers per provider (current API docs), the per-field
// tuning fallback, stop reasons and the reasoning-effort mapping.
import test from 'node:test';
import assert from 'node:assert/strict';

import { callAI } from '../lib/api-client.js';

const encoder = new TextEncoder();
const REAL_FETCH = globalThis.fetch;

function stubFetch(t, makeResponse) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
    return makeResponse(url, options, calls.length);
  };
  t.after(() => { globalThis.fetch = REAL_FETCH; });
  return calls;
}

function streamResponse(chunks) {
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const sse = (obj, event) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(obj)}\n\n`;
const jsonResponse = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const okChat = (content = 'ok', finish_reason = 'stop') => jsonResponse(200, { choices: [{ message: { content }, finish_reason }] });
const okAnthropic = (text = 'ok', stop_reason = 'end_turn') => jsonResponse(200, { content: [{ type: 'text', text }], stop_reason });
const okGemini = (text = 'ok', finishReason = 'STOP') => jsonResponse(200, { candidates: [{ content: { parts: [{ text }] }, finishReason }] });

// ── Request shape per provider ──

test('anthropic: version 2026-10-21, 16 000 max_tokens, no temperature, no thinking', async (t) => {
  const calls = stubFetch(t, () => okAnthropic());
  await callAI({ provider: 'anthropic', apiKey: 'k', model: 'claude-x', prompt: 'p', systemPrompt: 's' });
  assert.deepEqual(calls[0].options.headers, {
    'Content-Type': 'application/json',
    'x-api-key': 'k',
    'anthropic-version': '2026-10-21',
    'anthropic-dangerous-direct-browser-access': 'true'
  });
  assert.deepEqual(calls[0].body, {
    model: 'claude-x',
    max_tokens: 16000,
    messages: [{ role: 'user', content: 'p' }],
    system: 's'
  });
});

test('gemini: 16 000 maxOutputTokens, no temperature', async (t) => {
  const calls = stubFetch(t, () => okGemini());
  await callAI({ provider: 'google', apiKey: 'k', model: 'gm', prompt: 'p' });
  assert.deepEqual(calls[0].body, {
    contents: [{ parts: [{ text: 'p' }] }],
    generationConfig: { maxOutputTokens: 16000 }
  });
});

test('openai: 25 000 max_completion_tokens, never a temperature', async (t) => {
  const calls = stubFetch(t, () => okChat());
  await callAI({ provider: 'openai', apiKey: 'k', model: 'gpt-x', prompt: 'p' });
  assert.deepEqual(calls[0].body, {
    model: 'gpt-x',
    max_completion_tokens: 25000,
    messages: [{ role: 'user', content: 'p' }]
  });
});

test('openrouter and custom keep max_tokens 4096 and temperature 0.3', async (t) => {
  const calls = stubFetch(t, () => okChat());
  await callAI({ provider: 'openrouter', apiKey: 'k', model: 'a/b', prompt: 'p' });
  await callAI({ provider: 'custom', apiKey: '', baseUrl: 'http://localhost:11434/v1', model: 'llama', prompt: 'p' });
  for (const call of calls) {
    assert.equal(call.body.max_tokens, 4096);
    assert.equal(call.body.temperature, 0.3);
  }
  assert.equal(calls[0].options.headers['X-OpenRouter-Title'], 'ContextHelper');
  assert.equal(calls[0].options.headers['HTTP-Referer'], 'https://github.com/contexthelper');
});

test('openrouter stream: comment lines are skipped, the repeated finish_reason ends it once', async (t) => {
  stubFetch(t, () => streamResponse([
    ': OPENROUTER PROCESSING\n\n',
    sse({ choices: [{ delta: { content: 'Hi' }, finish_reason: null }] }),
    ': OPENROUTER PROCESSING\n\n',
    sse({ choices: [{ delta: { content: '!' }, finish_reason: 'stop' }] }),
    sse({ choices: [{ delta: { content: '' }, finish_reason: 'stop' }], usage: { total_tokens: 9 } }),
    'data: [DONE]\n\n'
  ]));
  const deltas = [];
  const result = await callAI({ provider: 'openrouter', apiKey: 'k', model: 'a/b', prompt: 'p', onDelta: d => deltas.push(d) });
  assert.equal(result, 'Hi!');
  assert.deepEqual(deltas, ['Hi', 'Hi!']);
});

// ── Reasoning effort mapping ──

const okByUrl = (url) => {
  if (url.includes('anthropic')) return okAnthropic();
  if (url.includes('generativelanguage')) return okGemini();
  return okChat();
};

test('effort maps to each provider\'s parameter', async (t) => {
  const calls = stubFetch(t, okByUrl);
  await callAI({ provider: 'anthropic', apiKey: 'k', model: 'eff-a', prompt: 'p', effort: 'low' });
  await callAI({ provider: 'openai', apiKey: 'k', model: 'eff-o', prompt: 'p', effort: 'medium' });
  await callAI({ provider: 'openrouter', apiKey: 'k', model: 'eff/r', prompt: 'p', effort: 'high' });
  await callAI({ provider: 'custom', apiKey: '', baseUrl: 'http://localhost:1234/v1', model: 'eff-c', prompt: 'p', effort: 'low' });
  await callAI({ provider: 'google', apiKey: 'k', model: 'eff-g', prompt: 'p', effort: 'high' });
  assert.deepEqual(calls[0].body.output_config, { effort: 'low' });
  assert.equal(calls[1].body.reasoning_effort, 'medium');
  assert.deepEqual(calls[2].body.reasoning, { effort: 'high' });
  assert.equal('reasoning_effort' in calls[2].body, false);
  assert.equal(calls[3].body.reasoning_effort, 'low');
  assert.deepEqual(calls[4].body.generationConfig, { maxOutputTokens: 16000, thinkingConfig: { thinkingLevel: 'HIGH' } });
});

test('empty or unknown effort sends no effort parameter', async (t) => {
  const calls = stubFetch(t, okByUrl);
  for (const effort of ['', undefined, 'extreme']) {
    await callAI({ provider: 'anthropic', apiKey: 'k', model: 'none-a', prompt: 'p', effort });
    await callAI({ provider: 'openai', apiKey: 'k', model: 'none-o', prompt: 'p', effort });
    await callAI({ provider: 'openrouter', apiKey: 'k', model: 'none/r', prompt: 'p', effort });
    await callAI({ provider: 'google', apiKey: 'k', model: 'none-g', prompt: 'p', effort });
  }
  assert.equal(calls.length, 12);
  for (const { body } of calls) {
    for (const key of ['output_config', 'reasoning_effort', 'reasoning']) assert.equal(key in body, false, key);
    if (body.generationConfig) assert.equal('thinkingConfig' in body.generationConfig, false);
  }
});

test('DeepL ignores effort', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(200, { translations: [{ text: 'Hallo' }] }));
  await callAI({ provider: 'deepl', apiKey: 'k:fx', prompt: 'Hi', targetLang: 'DE', effort: 'high' });
  assert.deepEqual(calls[0].body, { text: ['Hi'], target_lang: 'DE' });
});

// ── Per-field tuning fallback (a 400 before the stream starts) ──

const err400 = (message) => jsonResponse(400, { error: { message } });
const TEMPERATURE_MSG = "Unsupported value: 'temperature' does not support 0.3 with this model.";
const EFFORT_MSG = 'Unrecognized request argument supplied: reasoning_effort';

test('custom endpoint rejecting reasoning_effort: retried without it only, then cached', async (t) => {
  const calls = stubFetch(t, (url, options, n) => (n === 1 ? err400(EFFORT_MSG) : okChat('ok')));
  const req = { provider: 'custom', apiKey: '', baseUrl: 'http://localhost:1234/v1', model: 'fb-custom', prompt: 'p', effort: 'high' };
  assert.equal(await callAI(req), 'ok');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.reasoning_effort, 'high');
  assert.equal('reasoning_effort' in calls[1].body, false);
  assert.equal(calls[1].body.temperature, 0.3, 'temperature is kept');

  assert.equal(await callAI(req), 'ok');
  assert.equal(calls.length, 3);
  assert.equal('reasoning_effort' in calls[2].body, false, 'cached: omitted from the start');
  assert.equal(calls[2].body.temperature, 0.3);
});

test('temperature and effort rejected one after the other: one retry per field', async (t) => {
  const calls = stubFetch(t, (url, options, n) => (n === 1 ? err400(TEMPERATURE_MSG) : n === 2 ? err400(EFFORT_MSG) : okChat('ok')));
  assert.equal(await callAI({ provider: 'openrouter', apiKey: 'k', model: 'fb/both', prompt: 'p', effort: 'low' }), 'ok');
  assert.equal(calls.length, 3);
  assert.equal('temperature' in calls[1].body, false);
  assert.deepEqual(calls[1].body.reasoning, { effort: 'low' });
  assert.equal('reasoning' in calls[2].body, false);
});

test('an unrelated 400 that mentions reasoning is not retried when no effort was sent', async (t) => {
  const calls = stubFetch(t, () => err400('This model requires reasoning to be enabled for tool use'));
  await assert.rejects(callAI({ provider: 'openrouter', apiKey: 'k', model: 'fb/unrelated', prompt: 'p' }), /requires reasoning/);
  assert.equal(calls.length, 1);
});

test('a 400 naming a field that was not sent is not retried (anthropic temperature)', async (t) => {
  const calls = stubFetch(t, () => err400('temperature: Extra inputs are not permitted'));
  await assert.rejects(callAI({ provider: 'anthropic', apiKey: 'k', model: 'fb-a-temp', prompt: 'p', effort: 'low' }), /Extra inputs/);
  assert.equal(calls.length, 1);
});

test('the rejection is cached only after the retry succeeds', async (t) => {
  let fail = true;
  const calls = stubFetch(t, () => (fail ? err400(EFFORT_MSG) : okChat('ok')));
  const req = { provider: 'openai', apiKey: 'k', model: 'fb-nocache', prompt: 'p', effort: 'medium' };
  await assert.rejects(callAI(req), /reasoning_effort/);
  assert.equal(calls.length, 2, 'one retry, then the second 400 is final');
  fail = false;
  await callAI(req);
  assert.equal(calls[2].body.reasoning_effort, 'medium', 'not cached after a failed retry');
});

test('anthropic rejecting output_config is retried without it and cached', async (t) => {
  const calls = stubFetch(t, (url, options, n) => (n === 1 ? err400('output_config.effort: Extra inputs are not permitted') : okAnthropic('ok')));
  const req = { provider: 'anthropic', apiKey: 'k', model: 'fb-a-eff', prompt: 'p', effort: 'high' };
  assert.equal(await callAI(req), 'ok');
  assert.equal(calls.length, 2);
  assert.equal('output_config' in calls[1].body, false);
  await callAI(req);
  assert.equal('output_config' in calls[2].body, false);
});

test('gemini rejecting thinkingLevel: retried, cached across stream and non-stream', async (t) => {
  const calls = stubFetch(t, (url, options, n) => {
    if (n === 1) return err400('Invalid JSON payload received. Unknown name "thinkingLevel" at \'generation_config.thinking_config\'');
    if (url.includes('alt=sse')) return streamResponse([sse({ candidates: [{ content: { parts: [{ text: 'streamed' }] }, finishReason: 'STOP' }] })]);
    return okGemini('ok');
  });
  assert.equal(await callAI({ provider: 'google', apiKey: 'k', model: 'fb-g', prompt: 'p', effort: 'low' }), 'ok');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.generationConfig, { maxOutputTokens: 16000 });
  // The streaming endpoint is another URL for the same model
  const deltas = [];
  assert.equal(await callAI({ provider: 'google', apiKey: 'k', model: 'fb-g', prompt: 'p', effort: 'low', onDelta: d => deltas.push(d) }), 'streamed');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].body.generationConfig, { maxOutputTokens: 16000 });
  assert.deepEqual(deltas, ['streamed']);
});

test('the retry streams with the same onDelta', async (t) => {
  const calls = stubFetch(t, (url, options, n) => (n === 1
    ? err400(EFFORT_MSG)
    : streamResponse([sse({ choices: [{ delta: { content: 'yo' }, finish_reason: 'stop' }] })])));
  const deltas = [];
  const result = await callAI({ provider: 'openai', apiKey: 'k', model: 'fb-stream', prompt: 'p', effort: 'low', onDelta: d => deltas.push(d) });
  assert.equal(result, 'yo');
  assert.deepEqual(deltas, ['yo']);
  assert.equal(calls[1].body.stream, true);
});

test('abort between attempts sends no retry', async (t) => {
  const controller = new AbortController();
  const calls = stubFetch(t, () => {
    // The abort lands after the 400 body was read, while its message is inspected
    const data = { get error() { controller.abort(); return { message: EFFORT_MSG }; } };
    return { ok: false, status: 400, body: null, json: async () => data };
  });
  await assert.rejects(
    callAI({ provider: 'openai', apiKey: 'k', model: 'fb-abort', prompt: 'p', effort: 'low', signal: controller.signal }),
    (err) => err.name === 'AbortError'
  );
  assert.equal(calls.length, 1);
});

test('abort during the retry rejects with AbortError', async (t) => {
  const controller = new AbortController();
  const calls = stubFetch(t, (url, options, n) => {
    if (n === 1) return err400(EFFORT_MSG);
    setTimeout(() => controller.abort(), 10);
    return new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode('{"choi')); } }), { status: 200 });
  });
  await assert.rejects(
    callAI({ provider: 'openai', apiKey: 'k', model: 'fb-abort-2', prompt: 'p', effort: 'low', signal: controller.signal }),
    (err) => err.name === 'AbortError'
  );
  assert.equal(calls.length, 2);
});
