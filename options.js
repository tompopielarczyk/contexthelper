import { getSettings, saveSettings, getDefaultActions, getDefaultTooltipSettings, getDefaultSystemPrompt, generateConfigId, generateWebhookId, generateActionId } from './lib/storage.js';
import { getAvailableModels, getDefaultModel, callAI, getDeepLUsage, DEEPL_TARGET_LANGUAGES } from './lib/api-client.js';
import { testWebhook, requestWebhookPermission, originPatternForUrl } from './lib/webhook.js';

// ── DOM refs ────────────────────────────────────────
const modelConfigsList = document.getElementById('modelConfigsList');
const addModelConfigBtn = document.getElementById('addModelConfig');
const webhooksList = document.getElementById('webhooksList');
const addWebhookBtn = document.getElementById('addWebhook');
const actionsList = document.getElementById('actionsList');
const addActionBtn = document.getElementById('addAction');
const restoreDefaultsBtn = document.getElementById('restoreDefaults');
const saveBtn = document.getElementById('saveBtn');
const saveStatus = document.getElementById('saveStatus');
const actionTemplate = document.getElementById('actionTemplate');
const modelConfigTemplate = document.getElementById('modelConfigTemplate');
const webhookTemplate = document.getElementById('webhookTemplate');
const webhookHeaderTemplate = document.getElementById('webhookHeaderTemplate');
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');
const darkModeToggle = document.getElementById('darkModeToggle');
const tooltipBgColor = document.getElementById('tooltipBgColor');
const tooltipBgColorText = document.getElementById('tooltipBgColorText');
const tooltipFontColor = document.getElementById('tooltipFontColor');
const tooltipFontColorText = document.getElementById('tooltipFontColorText');
const tooltipFontSize = document.getElementById('tooltipFontSize');
const tooltipFontSizeValue = document.getElementById('tooltipFontSizeValue');
const tooltipPosition = document.getElementById('tooltipPosition');
const systemPromptInput = document.getElementById('systemPrompt');

// ── State ───────────────────────────────────────────
let draggedCard = null;
let saveStatusTimeoutId = 0;

const CUSTOM_MODEL_VALUE = '__custom__';
const SHORTCUT_SLOTS = ['1', '2', '3', '4'];
const COMMAND_SLOT_RE = /^run-action-([1-4])$/;
const commandShortcuts = new Map(); // slot -> current key combo ('' when unbound)

// ── Init ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

let darkModeState = 'auto';
const systemDarkMedia = window.matchMedia('(prefers-color-scheme: dark)');

async function init() {
  const settings = await getSettings();

  // Load current key combos before rendering action cards (labels depend on them)
  try {
    for (const command of await chrome.commands.getAll()) {
      const slot = COMMAND_SLOT_RE.exec(command.name)?.[1];
      if (slot) commandShortcuts.set(slot, command.shortcut || '');
    }
  } catch {
    // commands API unavailable — selects fall back to "(not set)" labels
  }

  // Tabs
  initTabs();

  // Dark mode (tri-state: 'auto' | 'light' | 'dark')
  darkModeState = settings.darkMode || 'auto';
  applyDarkMode();
  systemDarkMedia.addEventListener('change', () => {
    if (darkModeState === 'auto') applyDarkMode();
  });
  darkModeToggle.addEventListener('click', cycleDarkMode);

  // Tooltip settings
  const ts = settings.tooltipSettings || getDefaultTooltipSettings();
  tooltipBgColor.value = ts.bgColor;
  tooltipBgColorText.value = ts.bgColor;
  tooltipFontColor.value = ts.fontColor;
  tooltipFontColorText.value = ts.fontColor;
  tooltipFontSize.value = ts.fontSize;
  tooltipFontSizeValue.textContent = `${ts.fontSize}px`;
  tooltipPosition.value = ts.position;

  tooltipBgColor.addEventListener('input', () => {
    tooltipBgColorText.value = tooltipBgColor.value;
  });
  tooltipBgColorText.addEventListener('input', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(tooltipBgColorText.value)) {
      tooltipBgColor.value = tooltipBgColorText.value;
    }
  });
  tooltipFontColor.addEventListener('input', () => {
    tooltipFontColorText.value = tooltipFontColor.value;
  });
  tooltipFontColorText.addEventListener('input', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(tooltipFontColorText.value)) {
      tooltipFontColor.value = tooltipFontColorText.value;
    }
  });
  tooltipFontSize.addEventListener('input', () => {
    tooltipFontSizeValue.textContent = `${tooltipFontSize.value}px`;
  });

  // System prompt
  systemPromptInput.value = settings.systemPrompt ?? getDefaultSystemPrompt();

  // Model configurations
  for (const config of settings.modelConfigs) {
    addModelConfigCard(config);
  }
  addModelConfigBtn.addEventListener('click', () => {
    addModelConfigCard({
      id: generateConfigId(),
      name: '',
      provider: 'anthropic',
      model: '',
      apiKey: ''
    });
  });

  // Webhooks
  for (const webhook of settings.webhooks || []) {
    addWebhookCard(webhook);
  }
  addWebhookBtn.addEventListener('click', () => {
    addWebhookCard({
      id: generateWebhookId(),
      name: '',
      url: '',
      method: 'POST',
      headers: []
    });
  });

  // Actions
  renderActions(settings.actions || getDefaultActions());

  addActionBtn.addEventListener('click', () => {
    addActionCard({ name: '', template: '{{text}}', displayMode: 'auto', modelConfigId: '', webhookId: '', targetLang: '', shortcutSlot: '' });
  });

  // chrome:// URLs are blocked as plain anchors — open via tabs API
  document.getElementById('openShortcutsPage').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  // Restore defaults
  restoreDefaultsBtn.addEventListener('click', onRestoreDefaults);

  // Save
  saveBtn.addEventListener('click', onSave);
}

// ── Tabs ───────────────────────────────────────────
function initTabs() {
  for (const btn of tabButtons) {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  }
}

function activateTab(tabId) {
  for (const btn of tabButtons) {
    const active = btn.dataset.tab === tabId;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  for (const panel of tabPanels) {
    const active = panel.dataset.tab === tabId;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  }
}

// ── Dark Mode ──────────────────────────────────────
function resolvedDarkMode() {
  if (darkModeState === 'dark') return true;
  if (darkModeState === 'light') return false;
  return systemDarkMedia.matches;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function makeSvgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const THEME_ICON_BUILDERS = {
  auto: () => [
    makeSvgEl('rect', { x: 2, y: 3, width: 20, height: 14, rx: 2, ry: 2 }),
    makeSvgEl('line', { x1: 8, y1: 21, x2: 16, y2: 21 }),
    makeSvgEl('line', { x1: 12, y1: 17, x2: 12, y2: 21 })
  ],
  light: () => [
    makeSvgEl('circle', { cx: 12, cy: 12, r: 4 }),
    makeSvgEl('line', { x1: 12, y1: 2, x2: 12, y2: 5 }),
    makeSvgEl('line', { x1: 12, y1: 19, x2: 12, y2: 22 }),
    makeSvgEl('line', { x1: 2, y1: 12, x2: 5, y2: 12 }),
    makeSvgEl('line', { x1: 19, y1: 12, x2: 22, y2: 12 }),
    makeSvgEl('line', { x1: 4.2, y1: 4.2, x2: 6.3, y2: 6.3 }),
    makeSvgEl('line', { x1: 17.7, y1: 17.7, x2: 19.8, y2: 19.8 }),
    makeSvgEl('line', { x1: 4.2, y1: 19.8, x2: 6.3, y2: 17.7 }),
    makeSvgEl('line', { x1: 17.7, y1: 6.3, x2: 19.8, y2: 4.2 })
  ],
  dark: () => [
    makeSvgEl('path', { d: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z' })
  ]
};

function applyDarkMode() {
  document.body.classList.toggle('dark', resolvedDarkMode());
  const labels = { auto: 'Theme: System (click to change)', light: 'Theme: Light (click to change)', dark: 'Theme: Dark (click to change)' };
  darkModeToggle.title = labels[darkModeState];
  darkModeToggle.dataset.mode = darkModeState;
  const icon = document.getElementById('darkModeIcon');
  if (icon) {
    icon.textContent = '';
    for (const child of THEME_ICON_BUILDERS[darkModeState]()) icon.appendChild(child);
  }
}

function cycleDarkMode() {
  darkModeState = darkModeState === 'auto' ? 'light'
    : darkModeState === 'light' ? 'dark'
    : 'auto';
  applyDarkMode();
}

// ── Model Configurations ───────────────────────────
function addModelConfigCard(config) {
  const fragment = modelConfigTemplate.content.cloneNode(true);
  const card = fragment.querySelector('.model-config-card');
  card.dataset.configId = config.id;

  const nameInput = card.querySelector('.model-config-name');
  const providerSelect = card.querySelector('.model-config-provider');
  const modelSelect = card.querySelector('.model-config-model');
  const customModelInput = card.querySelector('.model-config-custom-model');
  const apiKeyInput = card.querySelector('.model-config-apikey');
  const toggleKeyBtn = card.querySelector('.model-config-toggle-key');
  const testBtn = card.querySelector('.model-config-test');
  const testResult = card.querySelector('.model-config-test-result');
  const deleteBtn = card.querySelector('.model-config-delete');

  nameInput.value = config.name;
  providerSelect.value = config.provider;
  apiKeyInput.value = config.apiKey;

  populateModelSelect(modelSelect, customModelInput, config.provider, config.model);

  // DeepL has no model — hide the whole Model field
  const modelField = modelSelect.closest('.field');
  const syncProviderFields = () => {
    const isDeepL = providerSelect.value === 'deepl';
    modelField.hidden = isDeepL;
    if (isDeepL) customModelInput.hidden = true;
  };
  syncProviderFields();

  providerSelect.addEventListener('change', () => {
    if (providerSelect.value !== 'deepl') {
      populateModelSelect(modelSelect, customModelInput, providerSelect.value, '');
    }
    syncProviderFields();
    refreshActionModelSelectors();
  });

  modelSelect.addEventListener('change', () => {
    const isCustom = modelSelect.value === CUSTOM_MODEL_VALUE;
    customModelInput.hidden = !isCustom;
    if (isCustom) customModelInput.focus();
  });

  toggleKeyBtn.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    toggleKeyBtn.title = isPassword ? 'Hide key' : 'Show key';
  });

  testBtn.addEventListener('click', async () => {
    const btnText = testBtn.querySelector('.btn-text');
    const btnSpinner = testBtn.querySelector('.btn-spinner');
    const apiKey = apiKeyInput.value.trim();

    if (!apiKey) {
      showTestResultInCard(testResult, 'Enter an API key', false);
      return;
    }

    btnText.textContent = 'Testing...';
    btnSpinner.hidden = false;
    testBtn.disabled = true;
    testResult.hidden = true;

    try {
      if (providerSelect.value === 'deepl') {
        const usage = await getDeepLUsage(apiKey);
        const fmt = n => n.toLocaleString('pl-PL');
        showTestResultInCard(testResult, `Connection OK — ${fmt(usage.characterCount)} / ${fmt(usage.characterLimit)} characters used`, true);
      } else {
        const model = modelSelect.value === CUSTOM_MODEL_VALUE
          ? customModelInput.value.trim()
          : modelSelect.value;
        await callAI({
          provider: providerSelect.value,
          apiKey,
          model,
          prompt: 'Say OK'
        });
        showTestResultInCard(testResult, 'Connection OK', true);
      }
    } catch (err) {
      showTestResultInCard(testResult, err.message, false);
    } finally {
      btnText.textContent = 'Test';
      btnSpinner.hidden = true;
      testBtn.disabled = false;
    }
  });

  deleteBtn.addEventListener('click', () => {
    if (nameInput.value.trim() === '' || confirm('Delete this model configuration?')) {
      card.style.opacity = '0';
      card.style.transform = 'translateY(-4px)';
      setTimeout(() => {
        card.remove();
        refreshActionModelSelectors();
      }, 150);
    }
  });

  // Update action selectors when name changes
  nameInput.addEventListener('input', () => {
    refreshActionModelSelectors();
  });

  modelConfigsList.appendChild(card);
  refreshActionModelSelectors();
}

function showTestResultInCard(el, message, success) {
  el.textContent = message;
  el.className = `test-result model-config-test-result ${success ? 'success' : 'error'}`;
  el.hidden = false;
}

function populateModelSelect(selectEl, customInput, provider, selectedModel) {
  const models = getAvailableModels(provider);
  const defaultModel = getDefaultModel(provider);
  const knownIds = models.map(m => m.id);
  const isCustom = selectedModel && !knownIds.includes(selectedModel);

  selectEl.textContent = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    if (!isCustom && m.id === (selectedModel || defaultModel)) {
      opt.selected = true;
    }
    selectEl.appendChild(opt);
  }

  const customOpt = document.createElement('option');
  customOpt.value = CUSTOM_MODEL_VALUE;
  customOpt.textContent = 'Other...';
  if (isCustom) customOpt.selected = true;
  selectEl.appendChild(customOpt);

  customInput.hidden = !isCustom;
  if (isCustom) customInput.value = selectedModel;
}

// ── Webhooks ───────────────────────────────────────
function addWebhookCard(webhook) {
  const fragment = webhookTemplate.content.cloneNode(true);
  const card = fragment.querySelector('.webhook-card');
  card.dataset.webhookId = webhook.id;

  const nameInput = card.querySelector('.webhook-name');
  const methodSelect = card.querySelector('.webhook-method');
  const urlInput = card.querySelector('.webhook-url');
  const headersList = card.querySelector('.webhook-headers-list');
  const addHeaderBtn = card.querySelector('.webhook-add-header');
  const testBtn = card.querySelector('.webhook-test');
  const testResult = card.querySelector('.webhook-test-result');
  const deleteBtn = card.querySelector('.webhook-delete');

  nameInput.value = webhook.name || '';
  methodSelect.value = webhook.method || 'POST';
  urlInput.value = webhook.url || '';

  for (const header of webhook.headers || []) {
    addWebhookHeaderRow(headersList, header);
  }

  addHeaderBtn.addEventListener('click', () => {
    addWebhookHeaderRow(headersList, { key: '', value: '' });
  });

  nameInput.addEventListener('input', () => refreshActionWebhookSelectors());

  testBtn.addEventListener('click', async () => {
    await runWebhookTest(card, testBtn, testResult);
  });

  deleteBtn.addEventListener('click', () => {
    if (nameInput.value.trim() === '' || confirm('Delete this webhook?')) {
      card.style.opacity = '0';
      card.style.transform = 'translateY(-4px)';
      setTimeout(() => {
        card.remove();
        refreshActionWebhookSelectors();
      }, 150);
    }
  });

  webhooksList.appendChild(card);
  refreshActionWebhookSelectors();
}

function addWebhookHeaderRow(container, header) {
  const fragment = webhookHeaderTemplate.content.cloneNode(true);
  const row = fragment.querySelector('.webhook-header-row');
  row.querySelector('.webhook-header-key').value = header.key || '';
  row.querySelector('.webhook-header-value').value = header.value || '';
  row.querySelector('.webhook-header-delete').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function collectWebhookFromCard(card) {
  const headers = [];
  for (const row of card.querySelectorAll('.webhook-header-row')) {
    const key = row.querySelector('.webhook-header-key').value.trim();
    const value = row.querySelector('.webhook-header-value').value;
    if (key) headers.push({ key, value });
  }
  return {
    id: card.dataset.webhookId,
    name: card.querySelector('.webhook-name').value.trim(),
    url: card.querySelector('.webhook-url').value.trim(),
    method: card.querySelector('.webhook-method').value,
    headers
  };
}

function collectWebhooks() {
  const cards = webhooksList.querySelectorAll('.webhook-card');
  return [...cards].map(collectWebhookFromCard);
}

async function runWebhookTest(card, testBtn, testResult) {
  const config = collectWebhookFromCard(card);
  const btnText = testBtn.querySelector('.btn-text');
  const btnSpinner = testBtn.querySelector('.btn-spinner');

  if (!config.url) {
    showTestResult(testResult, 'Enter a URL first', false);
    return;
  }
  const origin = originPatternForUrl(config.url);
  if (!origin) {
    showTestResult(testResult, 'Invalid URL (use http/https)', false);
    return;
  }

  // chrome.permissions.request requires user activation — call before any await
  // chains away the gesture. Already-granted origins resolve immediately.
  const grantedPromise = requestWebhookPermission(config.url);

  btnText.textContent = 'Testing...';
  btnSpinner.hidden = false;
  testBtn.disabled = true;
  testResult.hidden = true;

  try {
    const granted = await grantedPromise;
    if (!granted) {
      showTestResult(testResult, 'Permission denied for this origin', false);
      return;
    }

    const result = await testWebhook(config);
    if (result.error) {
      showTestResult(testResult, `${result.error} (${result.durationMs}ms)`, false);
    } else if (result.ok) {
      const snippet = result.body ? ` — ${truncate(result.body, 80)}` : '';
      showTestResult(testResult, `${result.status} OK (${result.durationMs}ms)${snippet}`, true);
    } else {
      const snippet = result.body ? ` — ${truncate(result.body, 80)}` : '';
      showTestResult(testResult, `HTTP ${result.status}${snippet}`, false);
    }
  } catch (err) {
    showTestResult(testResult, err.message || 'Test failed', false);
  } finally {
    btnText.textContent = 'Test';
    btnSpinner.hidden = true;
    testBtn.disabled = false;
  }
}

function showTestResult(el, message, success) {
  el.textContent = message;
  el.className = `test-result webhook-test-result ${success ? 'success' : 'error'}`;
  el.hidden = false;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function refreshActionWebhookSelectors() {
  const webhooks = collectWebhooks();
  const selectors = actionsList?.querySelectorAll('.action-webhook') || [];
  for (const select of selectors) {
    const currentValue = select.value;
    populateWebhookSelect(select, webhooks, currentValue);
  }
}

function populateWebhookSelect(select, webhooks, selectedId) {
  select.textContent = '';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '(no webhook)';
  if (!selectedId) noneOpt.selected = true;
  select.appendChild(noneOpt);

  for (const wh of webhooks) {
    const opt = document.createElement('option');
    opt.value = wh.id;
    opt.textContent = wh.name || '(unnamed)';
    if (wh.id === selectedId) opt.selected = true;
    select.appendChild(opt);
  }
}

// ── Action Model Selectors Sync ────────────────────
function collectModelConfigs() {
  const cards = modelConfigsList.querySelectorAll('.model-config-card');
  const configs = [];
  for (const card of cards) {
    const provider = card.querySelector('.model-config-provider').value;
    const modelSelect = card.querySelector('.model-config-model');
    const customModel = card.querySelector('.model-config-custom-model');
    const model = provider === 'deepl'
      ? ''
      : (modelSelect.value === CUSTOM_MODEL_VALUE ? customModel.value.trim() : modelSelect.value);

    configs.push({
      id: card.dataset.configId,
      name: card.querySelector('.model-config-name').value.trim(),
      provider,
      model,
      apiKey: card.querySelector('.model-config-apikey').value.trim()
    });
  }
  return configs;
}

function refreshActionModelSelectors() {
  const configs = collectModelConfigs();
  const selectors = actionsList.querySelectorAll('.action-model-config');
  for (const select of selectors) {
    const currentValue = select.value;
    select.textContent = '';

    if (configs.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(no models configured)';
      select.appendChild(opt);
    } else {
      for (const config of configs) {
        const opt = document.createElement('option');
        opt.value = config.id;
        opt.textContent = config.name || '(unnamed)';
        if (config.id === currentValue) opt.selected = true;
        select.appendChild(opt);
      }
    }

    syncActionCardMode(select.closest('.action-card'), configs);
  }
}

function slotLabel(slot) {
  const combo = commandShortcuts.get(slot);
  return combo ? `Shortcut ${slot} (${combo})` : `Shortcut ${slot} (not set)`;
}

// DeepL-backed actions have no template — swap the textarea for a target-language select.
// The textarea stays in the DOM (hidden) so its value survives switching configs.
function syncActionCardMode(card, configs) {
  const select = card.querySelector('.action-model-config');
  const config = configs.find(c => c.id === select.value) || configs[0];
  const isDeepL = config?.provider === 'deepl';
  card.querySelector('.action-template').hidden = isDeepL;
  card.querySelector('.action-hint').hidden = isDeepL;
  card.querySelector('.action-target-lang').hidden = !isDeepL;
}

// ── Actions ─────────────────────────────────────────
function renderActions(actions) {
  actionsList.textContent = '';
  for (const action of actions) {
    addActionCard(action);
  }
}

function addActionCard(action) {
  const fragment = actionTemplate.content.cloneNode(true);
  const card = fragment.querySelector('.action-card');
  card.dataset.actionId = action.id || generateActionId();

  const nameInput = card.querySelector('.action-name');
  const templateInput = card.querySelector('.action-template');
  const targetLangSelect = card.querySelector('.action-target-lang');
  const displayModeSelect = card.querySelector('.action-display-mode');
  const modelConfigSelect = card.querySelector('.action-model-config');
  const webhookSelect = card.querySelector('.action-webhook');
  const shortcutSelect = card.querySelector('.action-shortcut');
  const deleteBtn = card.querySelector('.action-delete');

  nameInput.value = action.name;
  templateInput.value = action.template;
  displayModeSelect.value = action.displayMode || 'auto';

  for (const lang of DEEPL_TARGET_LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = lang.id;
    opt.textContent = lang.name;
    if (lang.id === action.targetLang) opt.selected = true;
    targetLangSelect.appendChild(opt);
  }

  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = 'No shortcut';
  shortcutSelect.appendChild(noneOpt);
  for (const slot of SHORTCUT_SLOTS) {
    const opt = document.createElement('option');
    opt.value = slot;
    opt.textContent = slotLabel(slot);
    if (slot === action.shortcutSlot) opt.selected = true;
    shortcutSelect.appendChild(opt);
  }

  // A slot binds to one action — picking a taken slot steals it (radio-like);
  // saveSettings rejects duplicates as the backstop.
  shortcutSelect.addEventListener('change', () => {
    if (!shortcutSelect.value) return;
    for (const other of actionsList.querySelectorAll('.action-shortcut')) {
      if (other !== shortcutSelect && other.value === shortcutSelect.value) other.value = '';
    }
  });

  // Populate model config selector
  const configs = collectModelConfigs();
  if (configs.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no models configured)';
    modelConfigSelect.appendChild(opt);
  } else {
    for (const config of configs) {
      const opt = document.createElement('option');
      opt.value = config.id;
      opt.textContent = config.name || '(unnamed)';
      if (config.id === action.modelConfigId) opt.selected = true;
      modelConfigSelect.appendChild(opt);
    }
  }

  syncActionCardMode(card, configs);
  modelConfigSelect.addEventListener('change', () => {
    syncActionCardMode(card, collectModelConfigs());
  });

  // Populate webhook selector (always includes "no webhook")
  populateWebhookSelect(webhookSelect, collectWebhooks(), action.webhookId || '');

  // Webhook only fires for tooltip path — disable dropdown when displayMode is 'insert'
  const syncWebhookEnabled = () => {
    const insertOnly = displayModeSelect.value === 'insert';
    webhookSelect.disabled = insertOnly;
    webhookSelect.title = insertOnly
      ? 'Webhooks only fire when result shows in a tooltip (not in insert mode)'
      : 'POST result to webhook (tooltip mode only)';
  };
  syncWebhookEnabled();
  displayModeSelect.addEventListener('change', syncWebhookEnabled);

  deleteBtn.addEventListener('click', () => {
    if (card.querySelector('.action-name').value.trim() === '' || confirm('Delete this action?')) {
      card.style.opacity = '0';
      card.style.transform = 'translateY(-4px)';
      setTimeout(() => card.remove(), 150);
    }
  });

  // Drag & drop — only armed when grabbed via the dedicated handle
  const dragHandle = card.querySelector('.action-drag-handle');
  const disarmDrag = () => { card.draggable = false; };
  dragHandle.addEventListener('mousedown', () => {
    card.draggable = true;
    document.addEventListener('mouseup', disarmDrag, { once: true });
  });
  card.addEventListener('dragend', disarmDrag);

  card.addEventListener('dragstart', onDragStart);
  card.addEventListener('dragend', onDragEnd);
  card.addEventListener('dragover', onDragOver);
  card.addEventListener('dragenter', onDragEnter);
  card.addEventListener('dragleave', onDragLeave);
  card.addEventListener('drop', onDrop);

  actionsList.appendChild(card);
}

// ── Drag & Drop ─────────────────────────────────────
function onDragStart(e) {
  draggedCard = e.currentTarget;
  draggedCard.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  // Required for Firefox
  e.dataTransfer.setData('text/plain', '');
}

function onDragEnd() {
  if (draggedCard) {
    draggedCard.classList.remove('dragging');
    draggedCard = null;
  }
  for (const card of actionsList.querySelectorAll('.drag-over')) {
    card.classList.remove('drag-over');
  }
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function onDragEnter(e) {
  e.preventDefault();
  const card = e.currentTarget;
  if (card !== draggedCard) {
    card.classList.add('drag-over');
  }
}

function onDragLeave(e) {
  const card = e.currentTarget;
  if (!card.contains(e.relatedTarget)) {
    card.classList.remove('drag-over');
  }
}

function onDrop(e) {
  e.preventDefault();
  const targetCard = e.currentTarget;
  targetCard.classList.remove('drag-over');

  if (!draggedCard || targetCard === draggedCard) return;

  const cards = [...actionsList.children];
  const dragIdx = cards.indexOf(draggedCard);
  const dropIdx = cards.indexOf(targetCard);

  if (dragIdx < dropIdx) {
    actionsList.insertBefore(draggedCard, targetCard.nextSibling);
  } else {
    actionsList.insertBefore(draggedCard, targetCard);
  }
}

// ── Restore Defaults ────────────────────────────────
function onRestoreDefaults() {
  if (confirm('Restore default actions? Current actions will be replaced.')) {
    renderActions(getDefaultActions());
  }
}

// ── Save ────────────────────────────────────────────
async function onSave() {
  const modelConfigs = collectModelConfigs();
  const webhooks = collectWebhooks();
  const actions = collectActions();
  const systemPrompt = systemPromptInput.value;
  const darkMode = darkModeState;

  const tooltipSettings = {
    bgColor: tooltipBgColor.value,
    fontColor: tooltipFontColor.value,
    fontSize: parseInt(tooltipFontSize.value, 10),
    position: tooltipPosition.value
  };

  try {
    await saveSettings({ modelConfigs, webhooks, actions, tooltipSettings, systemPrompt, darkMode });
    showSaveStatus('Saved', true);
  } catch (err) {
    showSaveStatus(err.message, false);
  }
}

function collectActions() {
  const cards = actionsList.querySelectorAll('.action-card');
  const actions = [];
  for (const card of cards) {
    const name = card.querySelector('.action-name').value.trim();
    const template = card.querySelector('.action-template').value;
    const displayMode = card.querySelector('.action-display-mode').value;
    const modelConfigId = card.querySelector('.action-model-config').value;
    const webhookId = card.querySelector('.action-webhook')?.value || '';
    const targetLang = card.querySelector('.action-target-lang').value;
    const shortcutSlot = card.querySelector('.action-shortcut')?.value || '';
    if (name) {
      actions.push({ id: card.dataset.actionId || generateActionId(), name, template, displayMode, modelConfigId, webhookId, targetLang, shortcutSlot });
    }
  }
  return actions;
}

function showSaveStatus(message, success) {
  if (saveStatusTimeoutId) clearTimeout(saveStatusTimeoutId);
  saveStatus.textContent = message;
  saveStatus.className = `save-status ${success ? 'success' : 'error'}`;
  saveStatus.hidden = false;
  saveStatusTimeoutId = setTimeout(() => { saveStatus.hidden = true; }, 3000);
}
