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
