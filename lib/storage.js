// displayMode: 'auto' (insert if editable, tooltip if readonly)
//              'tooltip' (always tooltip)
//              'insert' (always replace text, even in readonly DOM)
const DEFAULT_ACTIONS = [
  {
    name: 'Translate to English',
    template: 'Translate the following text to English, preserving formatting:\n\n{{text}}',
    displayMode: 'auto',
    modelConfigId: ''
  },
  {
    name: 'Translate to Polish',
    template: 'Translate the following text to Polish, preserving formatting:\n\n{{text}}',
    displayMode: 'auto',
    modelConfigId: ''
  },
  {
    name: 'Fix grammar',
    template: 'Fix spelling and grammar errors in the following text. Return only the corrected text:\n\n{{text}}',
    displayMode: 'auto',
    modelConfigId: ''
  },
  {
    name: 'Formal tone',
    template: 'Rewrite the following text in a formal tone, preserving the original meaning:\n\n{{text}}',
    displayMode: 'auto',
    modelConfigId: ''
  },
  {
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

const VALID_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'google'];

const PROVIDER_DISPLAY_NAMES = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (GPT)',
  google: 'Google (Gemini)',
  openrouter: 'OpenRouter'
};

const VALID_WEBHOOK_METHODS = ['POST', 'PUT', 'PATCH'];

export function generateConfigId() {
  return 'mc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function generateWebhookId() {
  return 'wh_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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
  const webhooks = Array.isArray(localData.webhooks) ? localData.webhooks : [];

  // Migration: old single-provider setup → modelConfigs array
  if (modelConfigs === null) {
    const oldProvider = syncData.provider || 'anthropic';
    const oldModel = syncData.model || '';
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

  // Backfill fields for actions from older versions
  actions = actions.map(a => ({
    ...a,
    displayMode: a.displayMode || 'auto',
    modelConfigId: a.modelConfigId || '',
    webhookId: a.webhookId || ''
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
    tooltipSettings: { ...DEFAULT_TOOLTIP_SETTINGS, ...syncData.tooltipSettings },
    darkMode
  };
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
        const u = new URL(wh.url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          throw new Error('proto');
        }
      } catch {
        throw new Error(`Webhook "${wh.name}" has an invalid URL`);
      }
      if (!VALID_WEBHOOK_METHODS.includes(wh.method)) {
        throw new Error(`Webhook "${wh.name}" has invalid method: ${wh.method}`);
      }
      if (wh.headers && !Array.isArray(wh.headers)) {
        throw new Error(`Webhook "${wh.name}" headers must be a list`);
      }
    }
  }

  if (actions) {
    for (const action of actions) {
      if (!action.name?.trim()) {
        throw new Error('Every action must have a name');
      }
      if (!action.template?.includes('{{text}}')) {
        throw new Error(`Action "${action.name}" template must contain {{text}}`);
      }
    }
  }

  const syncPayload = {};
  const localPayload = {};

  if (actions) syncPayload.actions = actions;
  if (tooltipSettings) syncPayload.tooltipSettings = tooltipSettings;
  if (systemPrompt !== undefined) syncPayload.systemPrompt = systemPrompt;
  if (darkMode !== undefined) {
    if (darkMode !== 'auto' && darkMode !== 'light' && darkMode !== 'dark') {
      throw new Error(`Invalid darkMode value: ${darkMode}`);
    }
    syncPayload.darkMode = darkMode;
  }
  if (modelConfigs) localPayload.modelConfigs = modelConfigs;
  if (webhooks) localPayload.webhooks = webhooks;

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
