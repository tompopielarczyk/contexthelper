import test from 'node:test';
import assert from 'node:assert/strict';

import {
  originPatternForUrl,
  sendWebhook,
  renderTemplate,
  DEFAULT_WEBHOOK_TEMPLATE,
  WebhookError
} from '../lib/webhook.js';

const SAMPLE_DATA = {
  result: 'line one\nline "two"',
  actionName: 'Fix grammar',
  sourceText: 'orig',
  pageUrl: 'https://example.com/page',
  pageTitle: 'Example',
  timestamp: '2026-07-16T00:00:00.000Z',
  modelUsed: 'claude-sonnet-4-6'
};

test('default template renders every payload field, preserving quotes and newlines', () => {
  const payload = renderTemplate(DEFAULT_WEBHOOK_TEMPLATE, SAMPLE_DATA);
  assert.deepEqual(payload, SAMPLE_DATA);
});

test('substitutes placeholders in nested objects and arrays, repeated occurrences included', () => {
  const template = JSON.stringify({
    text: '{{result}}',
    blocks: [{ note: 'From {{pageTitle}}: {{result}}' }],
    meta: { url: '{{pageUrl}}' }
  });
  const payload = renderTemplate(template, SAMPLE_DATA);
  assert.equal(payload.text, SAMPLE_DATA.result);
  assert.equal(payload.blocks[0].note, `From Example: ${SAMPLE_DATA.result}`);
  assert.equal(payload.meta.url, 'https://example.com/page');
});

test('leaves unknown placeholders and non-string values untouched', () => {
  const template = JSON.stringify({ keep: '{{nope}}', n: 42, flag: true, nothing: null });
  const payload = renderTemplate(template, SAMPLE_DATA);
  assert.deepEqual(payload, { keep: '{{nope}}', n: 42, flag: true, nothing: null });
});

test('renders missing data fields as empty strings', () => {
  const payload = renderTemplate(JSON.stringify({ text: '{{result}}' }), {});
  assert.deepEqual(payload, { text: '' });
});

test('rejects templates that are not valid JSON', () => {
  assert.throws(() => renderTemplate('{"text": {{result}}}', SAMPLE_DATA), WebhookError);
  assert.throws(() => renderTemplate('not json', SAMPLE_DATA), /template/i);
});

test('origin pattern omits explicit ports for Chrome permission match patterns', () => {
  assert.equal(originPatternForUrl('http://localhost:5678/hook'), 'http://localhost/*');
  assert.equal(originPatternForUrl('https://api.example.com:8443/hook'), 'https://api.example.com/*');
});

test('origin pattern omits default ports and rejects unsupported schemes', () => {
  assert.equal(originPatternForUrl('https://api.example.com/hook'), 'https://api.example.com/*');
  assert.equal(originPatternForUrl('ftp://api.example.com/hook'), null);
  assert.equal(originPatternForUrl('not a url'), null);
});

test('sendWebhook rejects non-local HTTP before fetch', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response('{}');
  };

  try {
    await assert.rejects(() => sendWebhook({
      name: 'Unsafe',
      url: 'http://api.example.com/hook',
      method: 'POST',
      headers: []
    }, { ok: true }), /HTTPS/i);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
