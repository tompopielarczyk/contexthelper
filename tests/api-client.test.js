import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractAnthropicText, extractChatCompletionText, extractGeminiText,
  createSSEParser, parseStreamEvent, getDefaultModel, callAI
} from '../lib/api-client.js';

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

test('SSE parser buffers split lines, CRLF, comments, DONE', () => {
  const got = [];
  const p = createSSEParser((d, e) => got.push([e, d]));
  p.push(': OPENROUTER PROCESSING\r\n\r\nevent: content_block_delta\r\ndata: {"a"');
  p.push(':1}\r\n\r\ndata: [DONE]\n\n');
  p.end();
  assert.deepEqual(got, [['content_block_delta', '{"a":1}']]);
});

test('SSE parser joins multi-line data', () => {
  const got = [];
  const p = createSSEParser(d => got.push(d));
  p.push('data: x\ndata: y\n\n'); p.end();
  assert.deepEqual(got, ['x\ny']);
});

test('SSE parser end() flushes a pending event', () => {
  const got = [];
  const p = createSSEParser(d => got.push(d));
  p.push('data: tail');
  p.end();
  assert.deepEqual(got, ['tail']);
});

test('parseStreamEvent per provider', () => {
  assert.deepEqual(parseStreamEvent('anthropic', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }), { delta: 'Hi', done: false, error: null });
  assert.equal(parseStreamEvent('anthropic', { type: 'message_stop' }).done, true);
  assert.equal(parseStreamEvent('anthropic', { type: 'error', error: { message: 'Overloaded' } }).error, 'Overloaded');
  assert.equal(parseStreamEvent('openai', { choices: [{ delta: { content: 'a' } }] }).delta, 'a');
  assert.equal(parseStreamEvent('openrouter', { choices: [{ delta: {}, finish_reason: 'stop' }] }).done, true);
  assert.equal(parseStreamEvent('openrouter', { error: { message: 'upstream died' }, choices: [{ delta: {}, finish_reason: 'error' }] }).error, 'upstream died');
  assert.equal(parseStreamEvent('google', { candidates: [{ content: { parts: [{ text: 'g' }, { text: 'h' }] } }] }).delta, 'gh');
  assert.equal(parseStreamEvent('google', { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }).done, true);
});

test('parseStreamEvent edge cases', () => {
  assert.deepEqual(parseStreamEvent('openrouter', { choices: [] }), { delta: '', done: false, error: null });
  assert.equal(parseStreamEvent('openai', { choices: [{ delta: {}, finish_reason: 'error' }] }).error, 'Stream error');
  assert.equal(parseStreamEvent('google', { promptFeedback: { blockReason: 'SAFETY' } }).error, 'Blocked (SAFETY)');
  assert.deepEqual(parseStreamEvent('anthropic', { type: 'ping' }), { delta: '', done: false, error: null });
});

test('getDefaultModel keeps empty defaults', () => {
  assert.equal(getDefaultModel('deepl'), '');
  assert.equal(getDefaultModel('nope'), getDefaultModel('anthropic'));
});

// ── Streaming through callAI with a stubbed fetch ──

const encoder = new TextEncoder();

function streamResponse(chunks, { hang = false } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? encoder.encode(c) : c);
      if (!hang) controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function stubFetch(t, makeResponse) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
    return makeResponse(url, options);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const sse = (obj, event) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(obj)}\n\n`;
const anthropicDelta = (text) => sse({ type: 'content_block_delta', delta: { type: 'text_delta', text } }, 'content_block_delta');
const chatDelta = (content) => sse({ choices: [{ delta: { content }, finish_reason: null }] });

test('anthropic stream resolves full text', async (t) => {
  stubFetch(t, () => streamResponse([anthropicDelta('He'), anthropicDelta('llo'), sse({ type: 'message_stop' }, 'message_stop')]));
  const deltas = [];
  const result = await callAI({ provider: 'anthropic', apiKey: 'k', model: 'm', prompt: 'p', onDelta: d => deltas.push(d) });
  assert.deepEqual(deltas, ['He', 'Hello']);
  assert.equal(result, 'Hello');
});

test('split UTF-8 across chunks', async (t) => {
  const bytes = encoder.encode(anthropicDelta('zażółć') + sse({ type: 'message_stop' }));
  // Split inside the two-byte 'ż' (0xC5 0xBC)
  const cut = bytes.indexOf(0xC5) + 1;
  stubFetch(t, () => streamResponse([bytes.slice(0, cut), bytes.slice(cut)]));
  const result = await callAI({ provider: 'anthropic', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {} });
  assert.equal(result, 'zażółć');
});

test('openrouter error after deltas rejects', async (t) => {
  stubFetch(t, () => streamResponse([
    chatDelta('partial'),
    'data: {"error":{"message":"upstream died"},"choices":[{"delta":{},"finish_reason":"error"}]}\n\n'
  ]));
  await assert.rejects(
    callAI({ provider: 'openrouter', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {} }),
    /upstream died/
  );
});

test('anthropic error event rejects', async (t) => {
  stubFetch(t, () => streamResponse([anthropicDelta('Hi'), sse({ type: 'error', error: { message: 'Overloaded' } }, 'error')]));
  await assert.rejects(
    callAI({ provider: 'anthropic', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {} }),
    /Overloaded/
  );
});

test('EOF after partial text rejects', async (t) => {
  stubFetch(t, () => streamResponse([chatDelta('half an answ')]));
  await assert.rejects(
    callAI({ provider: 'openai', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {} }),
    /ended unexpectedly/
  );
});

test('malformed JSON rejects', async (t) => {
  stubFetch(t, () => streamResponse(['data: {oops\n\n']));
  await assert.rejects(
    callAI({ provider: 'openai', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {} }),
    /malformed/
  );
});

test('done with empty text rejects with the empty-response message', async (t) => {
  stubFetch(t, () => streamResponse([sse({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] })]));
  await assert.rejects(
    callAI({ provider: 'google', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {} }),
    /Google Gemini returned an empty response/
  );
});

test('idle stall rejects', async (t) => {
  stubFetch(t, () => streamResponse([], { hang: true }));
  await assert.rejects(
    callAI({ provider: 'anthropic', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {}, streamTimeouts: { idleMs: 20, totalMs: 1000 } }),
    /stalled/
  );
});

test('total timeout rejects even while bytes keep arriving', async (t) => {
  stubFetch(t, () => {
    let timer;
    const body = new ReadableStream({
      start(controller) {
        timer = setInterval(() => controller.enqueue(encoder.encode(': ping\n\n')), 5);
      },
      cancel() { clearInterval(timer); }
    });
    return new Response(body, { status: 200 });
  });
  await assert.rejects(
    callAI({ provider: 'anthropic', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {}, streamTimeouts: { idleMs: 1000, totalMs: 40 } }),
    /took too long/
  );
});

test('external abort rejects with AbortError', async (t) => {
  stubFetch(t, () => streamResponse([anthropicDelta('He')], { hang: true }));
  const controller = new AbortController();
  await assert.rejects(
    callAI({
      provider: 'anthropic', apiKey: 'k', model: 'm', prompt: 'p', signal: controller.signal,
      onDelta: () => controller.abort(),
      streamTimeouts: { idleMs: 1000, totalMs: 2000 }
    }),
    (err) => err.name === 'AbortError'
  );
});

test('streaming request sets stream and uses the Gemini SSE endpoint', async (t) => {
  const calls = stubFetch(t, () => streamResponse([sse({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })]));
  const result = await callAI({ provider: 'google', apiKey: 'k', model: 'gm', prompt: 'p', onDelta: () => {} });
  assert.equal(result, 'ok');
  assert.match(calls[0].url, /\/gm:streamGenerateContent\?alt=sse$/);
});

test('non-OK streaming response keeps the JSON error path', async (t) => {
  stubFetch(t, () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }));
  await assert.rejects(
    callAI({ provider: 'openai', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {} }),
    (err) => err.name === 'APIError' && err.status === 401
  );
});

test('non-streaming request unchanged', async (t) => {
  const calls = stubFetch(t, () => new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 }));
  const result = await callAI({ provider: 'openai', apiKey: 'k', model: 'm', prompt: 'p', systemPrompt: 's' });
  assert.equal(result, 'hi');
  assert.equal('stream' in calls[0].body, false);
  assert.deepEqual(calls[0].body, {
    model: 'm',
    max_completion_tokens: 4096,
    temperature: 0.3,
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'p' }]
  });
});

test('multi-turn messages', async (t) => {
  const messages = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' }
  ];

  const openaiCalls = stubFetch(t, () => new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 }));
  await callAI({ provider: 'openai', apiKey: 'k', model: 'm', prompt: 'ignored', messages, systemPrompt: 'sys' });
  assert.deepEqual(openaiCalls[0].body.messages, [{ role: 'system', content: 'sys' }, ...messages]);

  const googleCalls = stubFetch(t, () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }), { status: 200 }));
  await callAI({ provider: 'google', apiKey: 'k', model: 'm', messages, systemPrompt: 'sys' });
  assert.deepEqual(googleCalls[0].body.contents.map(c => c.role), ['user', 'model', 'user']);

  const anthropicCalls = stubFetch(t, () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'x' }] }), { status: 200 }));
  await callAI({ provider: 'anthropic', apiKey: 'k', model: 'm', messages, systemPrompt: 'sys' });
  assert.equal(anthropicCalls[0].body.messages.length, 3);
  assert.equal(anthropicCalls[0].body.system, 'sys');
});
