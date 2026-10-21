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
    generationConfig: { maxOutputTokens: 4096, temperature: 0.3 },
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
  assert.equal(calls[0].options.headers['X-Title'], 'ContextHelper');
  assert.equal(calls[0].options.headers['Authorization'], 'Bearer k');
});

test('openai request uses max_completion_tokens', async (t) => {
  const calls = stubFetch(t, () => new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 }));
  await callAI({ provider: 'openai', apiKey: 'k', model: 'm', prompt: 'p' });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].body.max_completion_tokens, 4096);
  assert.equal('max_tokens' in calls[0].body, false);
});

test('single assistant message keeps the Gemini model role', async (t) => {
  const calls = stubFetch(t, () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }), { status: 200 }));
  await callAI({ provider: 'google', apiKey: 'k', model: 'gm', messages: [{ role: 'assistant', content: 'Draft' }] });
  assert.equal(calls[0].options.body, JSON.stringify({
    contents: [{ role: 'model', parts: [{ text: 'Draft' }] }],
    generationConfig: { maxOutputTokens: 4096, temperature: 0.3 }
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
