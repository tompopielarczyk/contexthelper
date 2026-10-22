import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractAnthropicText, extractChatCompletionText, extractGeminiText,
  createSSEParser, parseStreamEvent, getDefaultModel, callAI,
  normalizeBaseUrl, isPrivateHost, getAvailableModels, fetchAvailableModels
} from '../lib/api-client.js';
import { isRetryableError } from '../lib/chat.js';

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

// Restore to the real fetch, not the previous stub: a test may stub twice
const REAL_FETCH = globalThis.fetch;

function stubFetch(t, makeResponse) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
    return makeResponse(url, options);
  };
  t.after(() => { globalThis.fetch = REAL_FETCH; });
  return calls;
}

const sse = (obj, event) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(obj)}\n\n`;
const anthropicDelta = (text) => sse({ type: 'content_block_delta', delta: { type: 'text_delta', text } }, 'content_block_delta');
const chatDelta = (content) => sse({ choices: [{ delta: { content }, finish_reason: null }] });

test('anthropic stream resolves full text', async (t) => {
  const calls = stubFetch(t, () => streamResponse([anthropicDelta('He'), anthropicDelta('llo'), sse({ type: 'message_stop' }, 'message_stop')]));
  const deltas = [];
  const result = await callAI({ provider: 'anthropic', apiKey: 'k', model: 'm', prompt: 'p', onDelta: d => deltas.push(d) });
  assert.deepEqual(deltas, ['He', 'Hello']);
  assert.equal(result, 'Hello');
  assert.equal(calls[0].body.stream, true);
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
    callAI({ provider: 'anthropic', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {}, streamTimeouts: { preAnswerIdleMs: 20, idleMs: 20, totalMs: 1000 } }),
    /stalled/
  );
});

// Body that enqueues each step after its delay (ms from the previous step),
// then hangs or closes
function timedStreamResponse(steps, { hang = false } = {}) {
  const timers = [];
  const body = new ReadableStream({
    start(controller) {
      let at = 0;
      for (const [delay, chunk] of steps) {
        at += delay;
        timers.push(setTimeout(() => controller.enqueue(encoder.encode(chunk)), at));
      }
      if (!hang) timers.push(setTimeout(() => controller.close(), at + 1));
    },
    cancel() { timers.forEach(clearTimeout); }
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

test('a silent wait longer than idleMs before the first answer text resolves', async (t) => {
  // Reasoning models think for a while after the role chunk
  stubFetch(t, () => timedStreamResponse([
    [0, sse({ choices: [{ delta: { role: 'assistant' }, finish_reason: null }] })],
    [80, chatDelta('Hi')],
    [5, sse({ choices: [{ delta: {}, finish_reason: 'stop' }] })]
  ]));
  const result = await callAI({
    provider: 'openai', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {},
    streamTimeouts: { preAnswerIdleMs: 500, idleMs: 30, totalMs: 2000 }
  });
  assert.equal(result, 'Hi');
});

test('keep-alive bytes reset the pre-answer inactivity limit', async (t) => {
  stubFetch(t, () => timedStreamResponse([
    [0, ': ping\n\n'], [40, ': ping\n\n'], [40, ': ping\n\n'], [40, ': ping\n\n'],
    [40, anthropicDelta('ok')],
    [5, sse({ type: 'message_stop' }, 'message_stop')]
  ]));
  const result = await callAI({
    provider: 'anthropic', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {},
    streamTimeouts: { preAnswerIdleMs: 80, idleMs: 10, totalMs: 2000 }
  });
  assert.equal(result, 'ok');
});

test('no bytes before preAnswerIdleMs rejects as stalled', async (t) => {
  stubFetch(t, () => timedStreamResponse([
    [0, sse({ choices: [{ delta: { role: 'assistant' }, finish_reason: null }] })]
  ], { hang: true }));
  await assert.rejects(
    callAI({
      provider: 'openai', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {},
      streamTimeouts: { preAnswerIdleMs: 40, idleMs: 1000, totalMs: 2000 }
    }),
    /stalled/
  );
});

test('a pause longer than idleMs after the first answer text rejects', async (t) => {
  stubFetch(t, () => timedStreamResponse([
    [0, chatDelta('Hel')],
    [100, chatDelta('lo')]
  ], { hang: true }));
  await assert.rejects(
    callAI({
      provider: 'openai', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {},
      streamTimeouts: { preAnswerIdleMs: 1000, idleMs: 30, totalMs: 2000 }
    }),
    /stalled/
  );
});

test('the total limit also bounds the pre-answer phase', async (t) => {
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
    callAI({
      provider: 'anthropic', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {},
      streamTimeouts: { preAnswerIdleMs: 1000, idleMs: 1000, totalMs: 40 }
    }),
    /took too long/
  );
});

test('anthropic thinking, signature and ping events are not answer text', async (t) => {
  for (const delta of [{ type: 'thinking_delta', thinking: 'hmm' }, { type: 'signature_delta', signature: 'sig' }]) {
    assert.deepEqual(parseStreamEvent('anthropic', { type: 'content_block_delta', delta }), { delta: '', done: false, error: null });
  }
  stubFetch(t, () => streamResponse([
    sse({ type: 'ping' }, 'ping'),
    sse({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'secret' } }, 'content_block_delta'),
    sse({ type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'sig' } }, 'content_block_delta'),
    anthropicDelta('Answer'),
    sse({ type: 'message_stop' }, 'message_stop')
  ]));
  const deltas = [];
  const result = await callAI({ provider: 'anthropic', apiKey: 'k', model: 'm', prompt: 'p', onDelta: d => deltas.push(d) });
  assert.equal(result, 'Answer');
  assert.deepEqual(deltas, ['Answer']);
});

test('gemini thought parts are not answer text', async (t) => {
  assert.equal(
    parseStreamEvent('google', { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'Answer' }] } }] }).delta,
    'Answer'
  );
  assert.equal(
    extractGeminiText({ candidates: [{ content: { parts: [{ text: 'plan', thought: true }, { text: 'Final' }] } }] }),
    'Final'
  );
  assert.throws(
    () => extractGeminiText({ candidates: [{ content: { parts: [{ text: 'only thoughts', thought: true }] }, finishReason: 'MAX_TOKENS' }] }),
    /empty response \(MAX_TOKENS\)/
  );
  stubFetch(t, () => streamResponse([
    sse({ candidates: [{ content: { parts: [{ text: 'reasoning', thought: true }] } }] }),
    sse({ candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }] })
  ]));
  const deltas = [];
  const result = await callAI({ provider: 'google', apiKey: 'k', model: 'm', prompt: 'p', onDelta: d => deltas.push(d) });
  assert.equal(result, 'Done');
  assert.deepEqual(deltas, ['Done']);
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
    max_completion_tokens: 25000,
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

test('SSE parser calls onDone once for [DONE]', () => {
  const got = [];
  let doneCount = 0;
  const p = createSSEParser(d => got.push(d), () => doneCount++);
  p.push('data: {"a":1}\n\ndata: [DONE]\n\n');
  p.end();
  assert.deepEqual(got, ['{"a":1}']);
  assert.equal(doneCount, 1);
});

test('openai stream ending with [DONE] and no finish_reason resolves', async (t) => {
  const calls = stubFetch(t, () => streamResponse([chatDelta('local answer'), 'data: [DONE]\n\n']));
  const result = await callAI({ provider: 'openai', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {} });
  assert.equal(result, 'local answer');
  assert.equal(calls[0].body.stream, true);
});

test('openai stream with plain EOF and no [DONE] still rejects', async (t) => {
  stubFetch(t, () => streamResponse([chatDelta('local answer')]));
  await assert.rejects(
    callAI({ provider: 'openai', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {} }),
    /ended unexpectedly/
  );
});

test('[DONE] does not end an anthropic stream', async (t) => {
  stubFetch(t, () => streamResponse([anthropicDelta('Hi'), 'data: [DONE]\n\n']));
  await assert.rejects(
    callAI({ provider: 'anthropic', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {} }),
    /ended unexpectedly/
  );
});

test('network drop mid-stream rejects with a retryable APIError', async (t) => {
  stubFetch(t, () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(chatDelta('par')));
        setTimeout(() => controller.error(new TypeError('network')), 5);
      }
    });
    return new Response(body, { status: 200 });
  });
  await assert.rejects(
    callAI({ provider: 'openai', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {} }),
    (err) => err.name === 'APIError' && /Connection lost/.test(err.message) && isRetryableError(err)
  );
});

test('streamed Gemini finish with no text keeps the reason', async (t) => {
  stubFetch(t, () => streamResponse([sse({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] })]));
  await assert.rejects(
    callAI({ provider: 'google', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {} }),
    /Google Gemini returned an empty response \(SAFETY\)/
  );
});

test('single-prompt Gemini body is unchanged', async (t) => {
  const calls = stubFetch(t, () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }), { status: 200 }));
  await callAI({ provider: 'google', apiKey: 'k', model: 'gm', prompt: 'p', systemPrompt: 's' });
  assert.match(calls[0].url, /\/gm:generateContent$/);
  assert.equal(calls[0].options.body, JSON.stringify({
    contents: [{ parts: [{ text: 'p' }] }],
    generationConfig: { maxOutputTokens: 16000 },
    systemInstruction: { parts: [{ text: 's' }] }
  }));

  // A single user turn passed as messages (what runAction sends) is the same request
  await callAI({ provider: 'google', apiKey: 'k', model: 'gm', messages: [{ role: 'user', content: 'p' }], systemPrompt: 's' });
  assert.equal(calls[1].options.body, calls[0].options.body);
});

test('openrouter request shape', async (t) => {
  const calls = stubFetch(t, () => new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 }));
  await callAI({ provider: 'openrouter', apiKey: 'k', model: 'm', prompt: 'p' });
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].body.max_tokens, 4096);
  assert.equal('max_completion_tokens' in calls[0].body, false);
  assert.equal(calls[0].options.headers['HTTP-Referer'], 'https://github.com/contexthelper');
  assert.equal(calls[0].options.headers['X-OpenRouter-Title'], 'ContextHelper');
  assert.equal('X-Title' in calls[0].options.headers, false);
  assert.equal(calls[0].body.temperature, 0.3);
  assert.equal(calls[0].options.headers['Authorization'], 'Bearer k');
});

test('openai request uses max_completion_tokens', async (t) => {
  const calls = stubFetch(t, () => new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 }));
  await callAI({ provider: 'openai', apiKey: 'k', model: 'm', prompt: 'p' });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].body.max_completion_tokens, 25000);
  assert.equal('max_tokens' in calls[0].body, false);
  assert.equal('temperature' in calls[0].body, false);
});

test('single assistant message keeps the Gemini model role', async (t) => {
  const calls = stubFetch(t, () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }), { status: 200 }));
  await callAI({ provider: 'google', apiKey: 'k', model: 'gm', messages: [{ role: 'assistant', content: 'Draft' }] });
  assert.equal(calls[0].options.body, JSON.stringify({
    contents: [{ role: 'model', parts: [{ text: 'Draft' }] }],
    generationConfig: { maxOutputTokens: 16000 }
  }));
});

// ── Custom OpenAI-compatible provider ──

test('normalizeBaseUrl strips trailing slash and /chat/completions', () => {
  assert.equal(normalizeBaseUrl(' http://localhost:11434/v1/ '), 'http://localhost:11434/v1');
  assert.equal(normalizeBaseUrl('https://x.example.com/v1/chat/completions'), 'https://x.example.com/v1');
});

test('normalizeBaseUrl allows http only for local/private hosts', () => {
  for (const ok of ['http://127.0.0.1:1234/v1', 'http://192.168.1.5/v1', 'http://10.0.0.2/v1', 'http://172.20.0.1/v1', 'http://nas.local/v1', 'http://app.localhost/v1'])
    assert.doesNotThrow(() => normalizeBaseUrl(ok), ok);
  assert.throws(() => normalizeBaseUrl('http://api.example.com/v1'), /HTTPS/);
  assert.throws(() => normalizeBaseUrl('http://172.32.0.1/v1'), /HTTPS/);
  assert.throws(() => normalizeBaseUrl('ftp://localhost/v1'), /Invalid base URL/);
  assert.throws(() => normalizeBaseUrl('not a url'), /Invalid base URL/);
});

test('normalizeBaseUrl rejects IPv6 literal hosts (not grantable as match patterns)', () => {
  for (const url of ['http://[::1]:8080/v1', 'https://[2001:db8::1]/v1'])
    assert.throws(() => normalizeBaseUrl(url), /^Error: IPv6 addresses are not supported — use localhost or 127\.0\.0\.1$/, url);
});

test('normalizeBaseUrl rejects empty and non-string input', () => {
  assert.throws(() => normalizeBaseUrl(''), /Invalid base URL/);
  assert.throws(() => normalizeBaseUrl(undefined), /Invalid base URL/);
});

test('isPrivateHost covers loopback, mDNS and RFC 1918 ranges only', () => {
  for (const h of ['localhost', 'app.localhost', 'nas.local', '127.0.0.1', '127.9.9.9', '[::1]', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1'])
    assert.equal(isPrivateHost(h), true, h);
  for (const h of ['example.com', '172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', 'localhost.example.com', '8.8.8.8'])
    assert.equal(isPrivateHost(h), false, h);
});

test('isPrivateHost accepts LAN and VPN hosts', () => {
  for (const h of ['gpu-box', 'nas', 'box1', '100.64.0.0', '100.100.1.2', '100.127.255.255', '169.254.0.1', '169.254.255.255',
    'ollama.internal', 'x.lan', 'printer.home.arpa', 'GPU-Box'])
    assert.equal(isPrivateHost(h), true, h);
});

test('isPrivateHost rejects near misses, malformed and spoofed hosts', () => {
  for (const h of ['100.63.255.255', '100.128.0.0', '100.128.0.1', '169.255.0.1', '169.253.255.255',
    '300.1.1.1', '100.64.0.256', 'evil.lan.example.com', 'lan.example.com', 'x.internal.example.com', 'home.arpa.evil.com',
    '', '-bad', 'bad-', 'a_b', 'a b', '.', 'x.', '300', '0x7f', '[fd00::1]', 'fe80::1', '[::]', null, undefined])
    assert.equal(isPrivateHost(h), false, String(h));
});

test('normalizeBaseUrl accepts plain http for LAN and VPN hosts', () => {
  assert.equal(normalizeBaseUrl('http://gpu-box:11434/v1'), 'http://gpu-box:11434/v1');
  assert.equal(normalizeBaseUrl('http://100.101.102.103:1234/v1/'), 'http://100.101.102.103:1234/v1');
  assert.equal(normalizeBaseUrl('http://llm.home.arpa/v1'), 'http://llm.home.arpa/v1');
  assert.throws(() => normalizeBaseUrl('http://evil.lan.example.com/v1'), /HTTPS/);
});

test('custom provider: no auth header without key, defaults', async (t) => {
  const calls = stubFetch(t, () => new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 }));
  const result = await callAI({ provider: 'custom', apiKey: '', model: 'llama3', baseUrl: 'http://localhost:11434/v1/', prompt: 'p' });
  assert.equal(result, 'hi');
  assert.equal(calls[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal('Authorization' in calls[0].options.headers, false);
  assert.equal(calls[0].body.model, 'llama3');
  assert.equal(calls[0].body.max_tokens, 4096);
  assert.deepEqual(getAvailableModels('custom'), []);
  assert.equal(getDefaultModel('custom'), '');
});

test('custom provider sends Bearer when a key is set', async (t) => {
  const calls = stubFetch(t, () => new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 }));
  await callAI({ provider: 'custom', apiKey: ' sk-x ', model: 'm', baseUrl: 'https://vllm.example.com/v1/chat/completions', prompt: 'p' });
  assert.equal(calls[0].url, 'https://vllm.example.com/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-x');
});

test('custom provider streams chat-completions chunks ending in [DONE]', async (t) => {
  stubFetch(t, () => streamResponse([chatDelta('he'), chatDelta('y'), 'data: [DONE]\n\n']));
  const result = await callAI({ provider: 'custom', apiKey: '', model: 'm', baseUrl: 'http://localhost:1234/v1', prompt: 'p', onDelta: () => {} });
  assert.equal(result, 'hey');
});

test('custom provider maps 403 to the OLLAMA_ORIGINS hint', async (t) => {
  stubFetch(t, () => new Response('', { status: 403 }));
  await assert.rejects(
    callAI({ provider: 'custom', apiKey: '', model: 'm', baseUrl: 'http://localhost:11434/v1', prompt: 'p' }),
    (err) => err.name === 'APIError' && err.status === 403 &&
      err.message === 'Endpoint refused the request (403). For Ollama, set OLLAMA_ORIGINS=chrome-extension://* and restart it.'
  );
});

test('custom provider keeps the hint for a JSON-bodied 403', async (t) => {
  stubFetch(t, () => new Response(JSON.stringify({ error: { message: 'x' } }), { status: 403 }));
  await assert.rejects(
    callAI({ provider: 'custom', apiKey: '', model: 'm', baseUrl: 'http://localhost:11434/v1', prompt: 'p' }),
    (err) => err.status === 403 && /OLLAMA_ORIGINS/.test(err.message)
  );
});

test('custom provider passes 401 and 500 through with the normal messages', async (t) => {
  for (const status of [401, 500]) {
    stubFetch(t, () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status }));
    await assert.rejects(
      callAI({ provider: 'custom', apiKey: 'k', model: 'm', baseUrl: 'http://localhost:11434/v1', prompt: 'p' }),
      (err) => err.name === 'APIError' && err.status === status && !/OLLAMA_ORIGINS/.test(err.message) &&
        err.message === (status === 401 ? 'Invalid API key. Please check your settings.' : 'API server temporarily unavailable. Please try again.')
    );
  }
});

test('custom provider names itself in errors and rejects a bad base URL before fetching', async (t) => {
  const calls = stubFetch(t, () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }));
  await assert.rejects(
    callAI({ provider: 'custom', apiKey: '', model: 'm', baseUrl: 'http://localhost:11434/v1', prompt: 'p' }),
    /Custom endpoint returned an empty response/
  );
  await assert.rejects(
    callAI({ provider: 'custom', apiKey: '', model: 'm', baseUrl: 'http://api.example.com/v1', prompt: 'p' }),
    /HTTPS/
  );
  assert.equal(calls.length, 1);
});

test('fetchAvailableModels for custom reads data[].id from base/models', async (t) => {
  const calls = stubFetch(t, () => new Response(JSON.stringify({ data: [{ id: 'llama3' }, { id: 'qwen2.5' }] }), { status: 200 }));
  const models = await fetchAvailableModels('custom', '', undefined, 'http://localhost:11434/v1/');
  assert.equal(calls[0].url, 'http://localhost:11434/v1/models');
  assert.equal('Authorization' in calls[0].options.headers, false);
  assert.deepEqual(models.map(m => m.id), ['llama3', 'qwen2.5']);
});

// ── Non-streaming body reads keep cancellation and the request deadline ──

// Headers arrive, then the JSON body stalls forever
function stalledJSONResponse() {
  const body = new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode('{"choi')); }
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('non-streaming custom call: abort after headers rejects with AbortError', async (t) => {
  const controller = new AbortController();
  stubFetch(t, () => {
    setTimeout(() => controller.abort(), 10);
    return stalledJSONResponse();
  });
  await assert.rejects(
    callAI({ provider: 'custom', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'm', prompt: 'p', signal: controller.signal }),
    (err) => err.name === 'AbortError'
  );
});

test('non-streaming openai call: abort after headers rejects with AbortError', async (t) => {
  const controller = new AbortController();
  stubFetch(t, () => {
    setTimeout(() => controller.abort(), 10);
    return stalledJSONResponse();
  });
  await assert.rejects(
    callAI({ provider: 'openai', apiKey: 'k', model: 'm', prompt: 'p', signal: controller.signal }),
    (err) => err.name === 'AbortError'
  );
});

test('DeepL translate: abort after headers rejects with AbortError', async (t) => {
  const controller = new AbortController();
  stubFetch(t, () => {
    setTimeout(() => controller.abort(), 10);
    return stalledJSONResponse();
  });
  await assert.rejects(
    callAI({ provider: 'deepl', apiKey: 'k:fx', prompt: 'p', targetLang: 'DE', signal: controller.signal }),
    (err) => err.name === 'AbortError'
  );
});

test('non-streaming body stall past the request deadline rejects as timed out', async (t) => {
  stubFetch(t, () => stalledJSONResponse());
  await assert.rejects(
    callAI({ provider: 'anthropic', apiKey: 'k', model: 'm', prompt: 'p', requestTimeoutMs: 30 }),
    /timed out/
  );
});

test('non-streaming error status still surfaces the body message', async (t) => {
  stubFetch(t, () => new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 }));
  await assert.rejects(
    callAI({ provider: 'openai', apiKey: 'k', model: 'm', prompt: 'p' }),
    /model not found/
  );
});

test('openai stream chunk with finish_reason length counts as done', async (t) => {
  // No [DONE] and the body hangs: only finish_reason can end the read
  stubFetch(t, () => streamResponse([
    chatDelta('cut '),
    sse({ choices: [{ delta: { content: 'off' }, finish_reason: 'length' }] })
  ], { hang: true }));
  const result = await callAI({
    provider: 'openai', apiKey: 'k', model: 'm', prompt: 'p', onDelta: () => {},
    streamTimeouts: { idleMs: 1000, totalMs: 2000 }
  });
  assert.equal(result, 'cut off');
});

// ── Temperature fallback and token budget (Revision 3, item 10) ──

const TEMPERATURE_400 = { error: { message: "Unsupported value: 'temperature' does not support 0.3 with this model. Only the default (1) value is supported." } };
const jsonResponse = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const okChat = (content) => jsonResponse(200, { choices: [{ message: { content }, finish_reason: 'stop' }] });

test('a temperature 400 is retried once without temperature, and the model is remembered', async (t) => {
  let n = 0;
  const calls = stubFetch(t, () => (++n === 1 ? jsonResponse(400, TEMPERATURE_400) : okChat('ok')));
  assert.equal(await callAI({ provider: 'openrouter', apiKey: 'k', model: 'reasoner-a', prompt: 'p' }), 'ok');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.temperature, 0.3);
  assert.equal('temperature' in calls[1].body, false);

  // Same url + model: no temperature from the first request on
  assert.equal(await callAI({ provider: 'openrouter', apiKey: 'k', model: 'reasoner-a', prompt: 'p' }), 'ok');
  assert.equal(calls.length, 3);
  assert.equal('temperature' in calls[2].body, false);
});

test('the temperature fallback also covers streaming and other chat-completions providers', async (t) => {
  let n = 0;
  const calls = stubFetch(t, () => (++n === 1
    ? jsonResponse(400, TEMPERATURE_400)
    : streamResponse([chatDelta('hi'), sse({ choices: [{ delta: {}, finish_reason: 'stop' }] })])));
  const result = await callAI({ provider: 'openrouter', apiKey: 'k', model: 'reasoner-stream', prompt: 'p', onDelta: () => {} });
  assert.equal(result, 'hi');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.stream, true);
  assert.equal('temperature' in calls[1].body, false);
});

test('an unrelated 400 is not retried', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(400, { error: { message: 'Invalid messages array' } }));
  await assert.rejects(callAI({ provider: 'openrouter', apiKey: 'k', model: 'reasoner-b', prompt: 'p' }), /Invalid messages array/);
  assert.equal(calls.length, 1);
});

test('two temperature 400s in a row reject after two calls', async (t) => {
  const calls = stubFetch(t, () => jsonResponse(400, TEMPERATURE_400));
  await assert.rejects(callAI({ provider: 'custom', apiKey: '', baseUrl: 'http://localhost:1234/v1', model: 'reasoner-c', prompt: 'p' }), /temperature/);
  assert.equal(calls.length, 2);
});

test('OpenAI gets a 25 000 token budget, OpenRouter keeps max_tokens 4096', async (t) => {
  const calls = stubFetch(t, () => okChat('ok'));
  await callAI({ provider: 'openai', apiKey: 'k', model: 'gpt-x', prompt: 'p' });
  await callAI({ provider: 'openrouter', apiKey: 'k', model: 'some/model', prompt: 'p' });
  assert.equal(calls[0].body.max_completion_tokens, 25000);
  assert.equal(calls[1].body.max_tokens, 4096);
  assert.equal('max_completion_tokens' in calls[1].body, false);
});

// ── Default models and fallback lists (Revision 3, item 11) ──

test('getDefaultModel per provider', () => {
  assert.equal(getDefaultModel('anthropic'), 'claude-sonnet-5-5');
  assert.equal(getDefaultModel('openai'), 'gpt-6-luna');
  assert.equal(getDefaultModel('openrouter'), 'openai/gpt-6-luna');
  assert.equal(getDefaultModel('google'), 'gemini-3.5-flash-lite');
  assert.equal(getDefaultModel('deepl'), '');
  assert.equal(getDefaultModel('custom'), '');
});

test('fallback model lists carry the current models and include each default', () => {
  const ids = (provider) => getAvailableModels(provider).map(m => m.id);
  assert.deepEqual(ids('anthropic'), ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5']);
  assert.deepEqual(ids('openai'), ['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.4-mini']);
  assert.deepEqual(ids('google'), ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash']);
  const openrouter = ids('openrouter');
  assert.deepEqual(openrouter.slice(0, 3), ['anthropic/claude-sonnet-5.5', 'openai/gpt-6-luna', 'google/gemini-3.8-flash']);
  assert.ok(openrouter.includes('deepseek/deepseek-v3.2') && openrouter.includes('stepfun/step-3.5-flash'));
  assert.equal(openrouter.length, 11);
  for (const provider of ['anthropic', 'openai', 'openrouter', 'google'])
    assert.ok(ids(provider).includes(getDefaultModel(provider)), provider);
});
