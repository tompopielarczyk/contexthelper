import test from 'node:test';
import assert from 'node:assert/strict';

import { saveSettings } from '../lib/storage.js';

function validSettings(overrides = {}) {
  return {
    modelConfigs: [{
      id: 'mc_1',
      name: 'Primary model',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'sk-test'
    }],
    webhooks: [],
    actions: [{
      name: 'Fix',
      template: 'Fix this:\n\n{{text}}',
      displayMode: 'auto',
      modelConfigId: 'mc_1',
      webhookId: ''
    }],
    tooltipSettings: {
      bgColor: '#ffffff',
      fontColor: '#1f2937',
      fontSize: 14,
      position: 'below'
    },
    systemPrompt: 'Be concise.',
    darkMode: 'auto',
    ...overrides
  };
}

function installChromeStorageMock() {
  const calls = { sync: [], local: [] };
  globalThis.chrome = {
    storage: {
      sync: {
        set: async (payload) => calls.sync.push(payload)
      },
      local: {
        set: async (payload) => calls.local.push(payload)
      }
    }
  };
  return calls;
}

test('rejects non-local HTTP webhook URLs', async () => {
  installChromeStorageMock();
  const settings = validSettings({
    webhooks: [{ id: 'wh_1', name: 'Unsafe', url: 'http://api.example.com/hook', method: 'POST', headers: [] }]
  });

  await assert.rejects(() => saveSettings(settings), /must use HTTPS/i);
});

test('allows loopback HTTP webhook URLs for local development', async () => {
  installChromeStorageMock();
  const settings = validSettings({
    webhooks: [{ id: 'wh_1', name: 'Local', url: 'http://localhost:5678/hook', method: 'POST', headers: [] }]
  });

  await assert.doesNotReject(() => saveSettings(settings));
});

test('requires model API key and model id', async () => {
  installChromeStorageMock();
  await assert.rejects(() => saveSettings(validSettings({
    modelConfigs: [{ id: 'mc_1', name: 'Broken', provider: 'anthropic', model: '', apiKey: 'sk-test' }]
  })), /model/i);

  await assert.rejects(() => saveSettings(validSettings({
    modelConfigs: [{ id: 'mc_1', name: 'Broken', provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: '' }]
  })), /API key/i);
});

test('allows default actions without model config during initial setup', async () => {
  installChromeStorageMock();
  const settings = validSettings({
    modelConfigs: [],
    actions: [{ name: 'Fix', template: '{{text}}', displayMode: 'auto', modelConfigId: '', webhookId: '' }]
  });

  await assert.doesNotReject(() => saveSettings(settings));
});

test('rejects action references to missing model configs and webhooks', async () => {
  installChromeStorageMock();
  await assert.rejects(() => saveSettings(validSettings({
    actions: [{ name: 'Fix', template: '{{text}}', displayMode: 'auto', modelConfigId: 'missing', webhookId: '' }]
  })), /unknown model/i);

  await assert.rejects(() => saveSettings(validSettings({
    webhooks: [{ id: 'wh_1', name: 'Safe', url: 'https://api.example.com/hook', method: 'POST', headers: [] }],
    actions: [{ name: 'Fix', template: '{{text}}', displayMode: 'auto', modelConfigId: 'mc_1', webhookId: 'missing' }]
  })), /unknown webhook/i);
});

test('sanitizes tooltip settings before saving', async () => {
  const calls = installChromeStorageMock();
  await saveSettings(validSettings({
    tooltipSettings: {
      bgColor: 'url(https://tracker.example/pixel)',
      fontColor: 'red',
      fontSize: 999,
      position: 'diagonal'
    }
  }));

  assert.deepEqual(calls.sync[0].tooltipSettings, {
    bgColor: '#ffffff',
    fontColor: '#1f2937',
    fontSize: 24,
    position: 'below'
  });
});

test('fails before writing when sync payload exceeds per-item quota', async () => {
  const calls = installChromeStorageMock();
  await assert.rejects(() => saveSettings(validSettings({
    systemPrompt: 'x'.repeat(9000)
  })), /too large/i);

  assert.equal(calls.sync.length, 0);
  assert.equal(calls.local.length, 0);
});
