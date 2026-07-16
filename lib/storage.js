import { validateWebhookUrl, WebhookError, VALID_WEBHOOK_METHODS, DEFAULT_WEBHOOK_TEMPLATE } from './webhook.js';

// displayMode: 'auto' (insert if editable, tooltip if readonly)
//              'tooltip' (always tooltip)
//              'insert' (always replace text, even in readonly DOM)
const DEFAULT_ACTIONS = [
  {
    id: 'translate-english',
    name: 'Translate to English',
    template: 'Translate the following text to English, preserving formatting:\n\n{{text}}',
    displayMode: 'auto',
    modelConfigId: ''
  },
  {
    id: 'translate-polish',
    name: 'Translate to Polish',
    template: 'Translate the following text to Polish, preserving formatting:\n\n{{text}}',
    displayMode: 'auto',
    modelConfigId: ''
  },
  {
    id: 'fix-grammar',
    name: 'Fix grammar',
    template: 'Fix spelling and grammar errors in the following text. Return only the corrected text:\n\n{{text}}',
    displayMode: 'auto',
    modelConfigId: ''
  },
  {
    id: 'formal-tone',
    name: 'Formal tone',
    template: 'Rewrite the following text in a formal tone, preserving the original meaning:\n\n{{text}}',
    displayMode: 'auto',
    modelConfigId: ''
  },
  {
    id: 'explain-simply',
    name: 'Explain simply',
    template: 'Explain the following text in simple language, as if to someone without technical knowledge:\n\n{{text}}',
    displayMode: 'auto',
    modelConfigId: ''
  }
];

const DEFAULT_SYSTEM_PROMPT = 'Respond in plain text without markdown formatting. Be concise and helpful.';

const DEFAULT_TOOLTIP_SETTINGS = {
  bgColor: '#ffffff',
  fontColor: '#1f2937',
  fontSize: 14,
  position: 'below' // 'below' | 'above' | 'left' | 'right'
};

const VALID_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'google', 'deepl'];

const PROVIDER_DISPLAY_NAMES = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (GPT)',
  google: 'Google (Gemini)',
  openrouter: 'OpenRouter',
  deepl: 'DeepL'
};

const PROVIDER_DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5.4-mini',
  openrouter: 'anthropic/claude-sonnet-4-6',
  google: 'gemini-2.5-flash',
  deepl: ''
};

const VALID_DISPLAY_MODES = ['auto', 'tooltip', 'insert'];
const VALID_SHORTCUT_SLOTS = ['', '1', '2', '3', '4'];
const SYNC_QUOTA_BYTES = 102_400;
const SYNC_QUOTA_BYTES_PER_ITEM = 8_192;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function generateConfigId() {
  return 'mc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function generateWebhookId() {
  return 'wh_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function generateActionId() {
  return 'act_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function getDefaultSystemPrompt() {
  return DEFAULT_SYSTEM_PROMPT;
}

export function getDefaultActions() {
  return structuredClone(DEFAULT_ACTIONS);
}

export function getDefaultTooltipSettings() {
  return structuredClone(DEFAULT_TOOLTIP_SETTINGS);
}

export async function getSettings() {
  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get({
      actions: DEFAULT_ACTIONS,
      tooltipSettings: DEFAULT_TOOLTIP_SETTINGS,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      darkMode: 'auto',
      // Old fields — read for migration, ignored after
      provider: null,
      model: null
    }),
    chrome.storage.local.get({
      modelConfigs: null,
      webhooks: [],
      apiKey: '',       // Old field for migration
      _initialized: false
    })
  ]);

  let modelConfigs = localData.modelConfigs;
  let actions = syncData.actions;
  const webhooks = (Array.isArray(localData.webhooks) ? localData.webhooks : []).map(w => ({
    ...w,
    template: w.template || DEFAULT_WEBHOOK_TEMPLATE
  }));

  // Migration: old single-provider setup → modelConfigs array
  if (modelConfigs === null) {
    const oldProvider = VALID_PROVIDERS.includes(syncData.provider) ? syncData.provider : 'anthropic';
    const oldModel = syncData.model || PROVIDER_DEFAULT_MODELS[oldProvider];
    const oldApiKey = localData.apiKey || '';

    if (oldApiKey || syncData.provider) {
      const config = {
        id: generateConfigId(),
        name: PROVIDER_DISPLAY_NAMES[oldProvider] || oldProvider,
        provider: oldProvider,
        model: oldModel,
        apiKey: oldApiKey
      };
      modelConfigs = [config];

      actions = actions.map(a => ({
        ...a,
        modelConfigId: a.modelConfigId || config.id
      }));

      await Promise.all([
        chrome.storage.local.set({ modelConfigs }),
        chrome.storage.local.remove(['apiKey']),
        chrome.storage.sync.set({ actions }),
        chrome.storage.sync.remove(['provider', 'model'])
      ]);
    } else {
      modelConfigs = [];
      await chrome.storage.local.set({ modelConfigs });
    }
  }

  // Backfill fields for actions from older versions; legacy webhookId is dropped
  // (webhooks are no longer bound to actions — sending is manual from the tooltip)
  actions = actions.map(({ webhookId: _legacy, ...a }, index) => ({
    ...a,
    id: a.id || `legacy-action-${index}`,
    displayMode: a.displayMode || 'auto',
    modelConfigId: a.modelConfigId || '',
    targetLang: a.targetLang || '',
    shortcutSlot: a.shortcutSlot || ''
  }));

  // Migrate legacy boolean darkMode → tri-state ('auto' | 'light' | 'dark')
  let darkMode = syncData.darkMode;
  if (typeof darkMode === 'boolean') {
    darkMode = darkMode ? 'dark' : 'auto';
  }
  if (darkMode !== 'auto' && darkMode !== 'light' && darkMode !== 'dark') {
    darkMode = 'auto';
  }

  return {
    modelConfigs,
    webhooks,
    actions,
    systemPrompt: syncData.systemPrompt,
    tooltipSettings: sanitizeTooltipSettings(syncData.tooltipSettings),
    darkMode
  };
}

function sanitizeTooltipSettings(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const fontSize = Number.parseInt(source.fontSize, 10);
  return {
    bgColor: HEX_COLOR_RE.test(source.bgColor || '') ? source.bgColor : DEFAULT_TOOLTIP_SETTINGS.bgColor,
    fontColor: HEX_COLOR_RE.test(source.fontColor || '') ? source.fontColor : DEFAULT_TOOLTIP_SETTINGS.fontColor,
    fontSize: Number.isFinite(fontSize) ? Math.min(Math.max(fontSize, 10), 24) : DEFAULT_TOOLTIP_SETTINGS.fontSize,
    position: ['below', 'above', 'left', 'right'].includes(source.position) ? source.position : DEFAULT_TOOLTIP_SETTINGS.position
  };
}

function getByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function assertSyncQuota(syncPayload) {
  let total = 0;
  for (const [key, value] of Object.entries(syncPayload)) {
    const itemBytes = getByteLength(value);
    if (itemBytes > SYNC_QUOTA_BYTES_PER_ITEM) {
      throw new Error(`Settings item "${key}" is too large for chrome.storage.sync (${itemBytes} bytes > ${SYNC_QUOTA_BYTES_PER_ITEM})`);
    }
    total += itemBytes;
  }
  if (total > SYNC_QUOTA_BYTES) {
    throw new Error(`Settings are too large for chrome.storage.sync (${total} bytes > ${SYNC_QUOTA_BYTES})`);
  }
}

export async function saveSettings(settings) {
  const { modelConfigs, webhooks, actions, tooltipSettings, systemPrompt, darkMode } = settings;

  if (modelConfigs) {
    for (const config of modelConfigs) {
      if (!config.name?.trim()) {
        throw new Error('Every model configuration must have a name');
      }
      if (!config.provider || !VALID_PROVIDERS.includes(config.provider)) {
        throw new Error(`Unknown provider for "${config.name}": ${config.provider}`);
      }
      if (config.provider !== 'deepl' && !config.model?.trim()) {
        throw new Error(`Model configuration "${config.name}" must have a model`);
      }
      if (!config.apiKey?.trim()) {
        throw new Error(`Model configuration "${config.name}" must have an API key`);
      }
    }
  }

  if (webhooks) {
    for (const wh of webhooks) {
      if (!wh.name?.trim()) {
        throw new Error('Every webhook must have a name');
      }
      if (!wh.url?.trim()) {
        throw new Error(`Webhook "${wh.name}" must have a URL`);
      }
      try {
        validateWebhookUrl(wh.url);
      } catch (err) {
        if (err instanceof WebhookError && err.message.includes('HTTPS')) {
          throw new Error(`Webhook "${wh.name}" must use HTTPS`);
        }
        throw new Error(`Webhook "${wh.name}" has an invalid URL`);
      }
      if (!VALID_WEBHOOK_METHODS.includes(wh.method)) {
        throw new Error(`Webhook "${wh.name}" has invalid method: ${wh.method}`);
      }
      if (wh.headers && !Array.isArray(wh.headers)) {
        throw new Error(`Webhook "${wh.name}" headers must be a list`);
      }
      if (wh.template) {
        try {
          JSON.parse(wh.template);
        } catch {
          throw new Error(`Webhook "${wh.name}" has an invalid JSON payload template`);
        }
      }
    }
  }

  if (actions) {
    const modelIds = new Set((modelConfigs || []).map(c => c.id));
    const providerById = new Map((modelConfigs || []).map(c => [c.id, c.provider]));
    const seenSlots = new Set();
    for (const action of actions) {
      if (!action.name?.trim()) {
        throw new Error('Every action must have a name');
      }
      // Resolve like runtime does: empty modelConfigId falls back to the first config.
      // Unknown provider (partial save without modelConfigs) keeps the template check.
      const provider = providerById.get(action.modelConfigId) || modelConfigs?.[0]?.provider;
      if (provider === 'deepl') {
        if (!action.targetLang?.trim()) {
          throw new Error(`Action "${action.name}" must have a target language`);
        }
      } else if (!action.template?.includes('{{text}}')) {
        throw new Error(`Action "${action.name}" template must contain {{text}}`);
      }
      if (!VALID_DISPLAY_MODES.includes(action.displayMode || 'auto')) {
        throw new Error(`Action "${action.name}" has invalid display mode: ${action.displayMode}`);
      }
      if (action.modelConfigId && !modelIds.has(action.modelConfigId)) {
        throw new Error(`Action "${action.name}" references unknown model configuration`);
      }
      if (!VALID_SHORTCUT_SLOTS.includes(action.shortcutSlot || '')) {
        throw new Error(`Action "${action.name}" has invalid shortcut slot: ${action.shortcutSlot}`);
      }
      if (action.shortcutSlot) {
        if (seenSlots.has(action.shortcutSlot)) {
          throw new Error(`Shortcut ${action.shortcutSlot} is assigned to more than one action`);
        }
        seenSlots.add(action.shortcutSlot);
      }
    }
  }

  const syncPayload = {};
  const localPayload = {};

  if (actions) syncPayload.actions = actions.map(({ webhookId: _legacy, ...a }, index) => ({
    ...a,
    id: a.id || `legacy-action-${index}`,
    displayMode: a.displayMode || 'auto',
    targetLang: a.targetLang || '',
    shortcutSlot: a.shortcutSlot || ''
  }));
  if (tooltipSettings) syncPayload.tooltipSettings = sanitizeTooltipSettings(tooltipSettings);
  if (systemPrompt !== undefined) syncPayload.systemPrompt = systemPrompt;
  if (darkMode !== undefined) {
    if (darkMode !== 'auto' && darkMode !== 'light' && darkMode !== 'dark') {
      throw new Error(`Invalid darkMode value: ${darkMode}`);
    }
    syncPayload.darkMode = darkMode;
  }
  if (modelConfigs) localPayload.modelConfigs = modelConfigs;
  if (webhooks) localPayload.webhooks = webhooks;

  assertSyncQuota(syncPayload);

  const promises = [];
  if (Object.keys(syncPayload).length) promises.push(chrome.storage.sync.set(syncPayload));
  if (Object.keys(localPayload).length) promises.push(chrome.storage.local.set(localPayload));
  await Promise.all(promises);
}

export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      callback(changes);
    }
  });
}

export async function isFirstRun() {
  const data = await chrome.storage.local.get({ _initialized: false });
  return !data._initialized;
}

export async function markInitialized() {
  await chrome.storage.local.set({ _initialized: true });
}
