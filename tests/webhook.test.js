import test from 'node:test';
import assert from 'node:assert/strict';

import { originPatternForUrl, sendWebhook } from '../lib/webhook.js';

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
