import test from 'node:test';
import assert from 'node:assert/strict';

import { saveSettings, customOrigins, getSettings } from '../lib/storage.js';

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
      modelConfigId: 'mc_1'
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

test('rejects action references to missing model configs', async () => {
  installChromeStorageMock();
  await assert.rejects(() => saveSettings(validSettings({
    actions: [{ name: 'Fix', template: '{{text}}', displayMode: 'auto', modelConfigId: 'missing' }]
  })), /unknown model/i);
});

test('rejects webhooks whose payload template is not valid JSON', async () => {
  installChromeStorageMock();
  await assert.rejects(() => saveSettings(validSettings({
    webhooks: [{ id: 'wh_1', name: 'Broken', url: 'https://api.example.com/hook', method: 'POST', headers: [], template: '{"text": {{result}}}' }]
  })), /template/i);

  await assert.doesNotReject(() => saveSettings(validSettings({
    webhooks: [{ id: 'wh_1', name: 'Fine', url: 'https://api.example.com/hook', method: 'POST', headers: [], template: '{"text": "{{result}}"}' }]
  })));
});

test('strips legacy webhookId from actions before writing to sync', async () => {
  const calls = installChromeStorageMock();
  await saveSettings(validSettings({
    actions: [{ name: 'Fix', template: '{{text}}', displayMode: 'auto', modelConfigId: 'mc_1', webhookId: 'wh_stale' }]
  }));

  assert.equal('webhookId' in calls.sync[0].actions[0], false);
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
    position: 'below',
    width: null,
    height: null
  });
});

test('clamps tooltip size and nulls invalid values', async () => {
  const calls = installChromeStorageMock();
  await saveSettings(validSettings({
    tooltipSettings: {
      bgColor: '#ffffff',
      fontColor: '#1f2937',
      fontSize: 14,
      position: 'below',
      width: 9999,
      height: 'garbage'
    }
  }));
  assert.equal(calls.sync[0].tooltipSettings.width, 1200);
  assert.equal(calls.sync[0].tooltipSettings.height, null);

  await saveSettings(validSettings({
    tooltipSettings: {
      bgColor: '#ffffff',
      fontColor: '#1f2937',
      fontSize: 14,
      position: 'below',
      width: 560,
      height: 30
    }
  }));
  assert.equal(calls.sync[1].tooltipSettings.width, 560);
  assert.equal(calls.sync[1].tooltipSettings.height, 120);
});

test('fails before writing when sync payload exceeds per-item quota', async () => {
  const calls = installChromeStorageMock();
  await assert.rejects(() => saveSettings(validSettings({
    systemPrompt: 'x'.repeat(9000)
  })), /too large/i);

  assert.equal(calls.sync.length, 0);
  assert.equal(calls.local.length, 0);
});

// ── Custom OpenAI-compatible provider ──

function customConfig(overrides = {}) {
  return { id: 'mc_1', name: 'Local', provider: 'custom', model: 'llama3', apiKey: '', baseUrl: 'http://localhost:11434/v1', ...overrides };
}

test('custom without apiKey saves', async () => {
  const calls = installChromeStorageMock();
  await assert.doesNotReject(() => saveSettings(validSettings({ modelConfigs: [customConfig()] })));
  assert.equal(calls.local[0].modelConfigs[0].baseUrl, 'http://localhost:11434/v1');
});

test('custom without baseUrl rejects', async () => {
  installChromeStorageMock();
  await assert.rejects(() => saveSettings(validSettings({ modelConfigs: [customConfig({ baseUrl: '' })] })), /base URL/i);
});

test('custom with public http rejects', async () => {
  installChromeStorageMock();
  await assert.rejects(
    () => saveSettings(validSettings({ modelConfigs: [customConfig({ baseUrl: 'http://api.example.com/v1' })] })),
    (err) => /HTTPS/.test(err.message) && err.message.startsWith('Model configuration "Local": ')
  );
});

test('custom without model rejects', async () => {
  installChromeStorageMock();
  await assert.rejects(() => saveSettings(validSettings({ modelConfigs: [customConfig({ model: ' ' })] })), /must have a model/);
});

test('openai still requires apiKey', async () => {
  installChromeStorageMock();
  await assert.rejects(() => saveSettings(validSettings({
    modelConfigs: [{ id: 'mc_1', name: 'GPT', provider: 'openai', model: 'gpt-5.4-mini', apiKey: '' }]
  })), /API key/i);
});

test('baseUrl is stored only for custom configs', async () => {
  const calls = installChromeStorageMock();
  await saveSettings(validSettings({
    modelConfigs: [
      customConfig({ baseUrl: ' http://localhost:11434/v1/ ' }),
      { id: 'mc_2', name: 'GPT', provider: 'openai', model: 'gpt-5.4-mini', apiKey: 'k', baseUrl: 'http://stale/v1' }
    ]
  }));
  const [custom, openai] = calls.local[0].modelConfigs;
  assert.equal(custom.baseUrl, 'http://localhost:11434/v1');
  assert.equal('baseUrl' in openai, false);
});

test('customOrigins dedupes and skips invalid', () => {
  assert.deepEqual(customOrigins([
    customConfig({ baseUrl: 'http://localhost:11434/v1' }),
    customConfig({ id: 'mc_2', baseUrl: 'http://localhost:11434/v1/chat/completions' }),
    customConfig({ id: 'mc_3', baseUrl: 'https://vllm.example.com/v1' }),
    customConfig({ id: 'mc_4', baseUrl: 'http://api.example.com/v1' }),
    customConfig({ id: 'mc_5', baseUrl: '' }),
    { id: 'mc_6', provider: 'openai', baseUrl: 'https://other.example.com/v1' }
  ]), ['http://localhost:11434/*', 'https://vllm.example.com/*']);
  assert.deepEqual(customOrigins(undefined), []);
});

// Legacy single-provider data without a model: the migrated config gets the
// provider's current default model
for (const [provider, model] of [
  ['anthropic', 'claude-sonnet-5-5'],
  ['openai', 'gpt-6-luna'],
  ['openrouter', 'openai/gpt-6-luna'],
  ['google', 'gemini-3.5-flash-lite']
]) {
  test(`legacy ${provider} migration uses the current default model`, async () => {
    const stored = { sync: { provider }, local: { apiKey: 'k' } };
    const area = (name) => ({
      get: async (defaults) => ({ ...defaults, ...stored[name] }),
      set: async (payload) => Object.assign(stored[name], payload),
      remove: async (keys) => { for (const k of keys) delete stored[name][k]; }
    });
    globalThis.chrome = { storage: { sync: area('sync'), local: area('local') } };
    const settings = await getSettings();
    assert.equal(settings.modelConfigs.length, 1);
    assert.equal(settings.modelConfigs[0].provider, provider);
    assert.equal(settings.modelConfigs[0].model, model);
  });
}
