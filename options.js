import { getSettings, saveSettings, getDefaultActions, getDefaultTooltipSettings, getDefaultFloatingButtonSettings, getDefaultSystemPrompt, generateConfigId, generateWebhookId, generateActionId } from './lib/storage.js';
import { getAvailableModels, getDefaultModel, callAI, getDeepLUsage, DEEPL_TARGET_LANGUAGES } from './lib/api-client.js';
import { testWebhook, requestWebhookPermission, requestWebhookPermissions, originPatternForUrl, DEFAULT_WEBHOOK_TEMPLATE } from './lib/webhook.js';

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
const tooltipBgSwatches = document.getElementById('tooltipBgSwatches');
const tooltipFontColor = document.getElementById('tooltipFontColor');
const tooltipFontSwatches = document.getElementById('tooltipFontSwatches');
const tooltipPreview = document.getElementById('tooltipPreview');
const tooltipFontSize = document.getElementById('tooltipFontSize');
const tooltipFontSizeValue = document.getElementById('tooltipFontSizeValue');
const tooltipPosition = document.getElementById('tooltipPosition');
const floatingAction = document.getElementById('floatingAction');
const floatingBgColor = document.getElementById('floatingBgColor');
const floatingEmojiPicker = document.getElementById('floatingEmojiPicker');
const floatingPreview = document.getElementById('floatingPreview');
const floatingEmojiBtn = document.getElementById('floatingEmojiBtn');
const floatingPreviewEmoji = document.getElementById('floatingPreviewEmoji');
const floatingPreviewLabel = document.getElementById('floatingPreviewLabel');
const floatingSwatches = document.getElementById('floatingSwatches');
const floatingDelay = document.getElementById('floatingDelay');
const floatingDelayValue = document.getElementById('floatingDelayValue');
const floatingAllSites = document.getElementById('floatingAllSites');
const floatingDomainsList = document.getElementById('floatingDomainsList');
const systemPromptInput = document.getElementById('systemPrompt');

// ── State ───────────────────────────────────────────
let draggedCard = null;
let saveStatusTimeoutId = 0;
let floatingAllSitesStored = false; // last persisted allSites value
let floatingEmojiValue = '✨';      // button appearance state (no form inputs)
let floatingBgValue = '#ffffff';

const ALL_SITE_ORIGINS = ['http://*/*', 'https://*/*'];

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
  tooltipFontSize.value = ts.fontSize;
  tooltipFontSizeValue.textContent = `${ts.fontSize}px`;
  tooltipPosition.value = ts.position;

  initSwatchGroup(tooltipBgSwatches, TOOLTIP_BG_PRESETS, tooltipBgColor, updateTooltipPreview)
    .select(ts.bgColor);
  initSwatchGroup(tooltipFontSwatches, TOOLTIP_FONT_PRESETS, tooltipFontColor, updateTooltipPreview)
    .select(ts.fontColor);

  tooltipFontSize.addEventListener('input', () => {
    tooltipFontSizeValue.textContent = `${tooltipFontSize.value}px`;
    updateTooltipPreview();
  });
  tooltipPosition.addEventListener('change', () => {
    updateTooltipPreview();
    // Re-appear at the new spot (order flips don't transition) — same
    // restart-by-reflow trick as the floating preview
    tooltipPreview.style.animation = 'none';
    void tooltipPreview.offsetWidth;
    tooltipPreview.style.animation = '';
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
      headers: [],
      template: DEFAULT_WEBHOOK_TEMPLATE
    });
  });

  // Actions
  renderActions(settings.actions || getDefaultActions());

  addActionBtn.addEventListener('click', () => {
    addActionCard({ name: '', template: '{{text}}', displayMode: 'auto', modelConfigId: '', targetLang: '', shortcutSlot: '' });
  });

  // Floating button (domains are owned by the page context-menu toggle)
  const fb = settings.floatingButtonSettings || getDefaultFloatingButtonSettings();
  floatingAllSitesStored = fb.allSites;
  floatingDelay.value = fb.delayMs;
  floatingDelayValue.textContent = `${fb.delayMs} ms`;
  floatingAllSites.checked = fb.allSites;
  refreshFloatingActionSelect(fb.actionId || '');
  renderFloatingDomains(fb.domains);
  syncFloatingVisibility();
  initFloatingAppearance(fb);

  floatingDelay.addEventListener('input', () => {
    floatingDelayValue.textContent = `${floatingDelay.value} ms`;
  });
  floatingAllSites.addEventListener('change', syncFloatingVisibility);
  // Re-populate from the live action cards right before the dropdown opens,
  // so freshly added/renamed (unsaved) actions are pickable too.
  floatingAction.addEventListener('mousedown', () => {
    refreshFloatingActionSelect(floatingAction.value);
  });
  floatingAction.addEventListener('change', () => {
    updateFloatingPreview();
    syncFloatingVisibility();
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
  const payloadTemplateInput = card.querySelector('.webhook-payload-template');
  const testBtn = card.querySelector('.webhook-test');
  const testResult = card.querySelector('.webhook-test-result');
  const deleteBtn = card.querySelector('.webhook-delete');

  nameInput.value = webhook.name || '';
  methodSelect.value = webhook.method || 'POST';
  urlInput.value = webhook.url || '';
  payloadTemplateInput.value = webhook.template || DEFAULT_WEBHOOK_TEMPLATE;

  for (const header of webhook.headers || []) {
    addWebhookHeaderRow(headersList, header);
  }

  addHeaderBtn.addEventListener('click', () => {
    addWebhookHeaderRow(headersList, { key: '', value: '' });
  });

  testBtn.addEventListener('click', async () => {
    await runWebhookTest(card, testBtn, testResult);
  });

  deleteBtn.addEventListener('click', () => {
    if (nameInput.value.trim() === '' || confirm('Delete this webhook?')) {
      card.style.opacity = '0';
      card.style.transform = 'translateY(-4px)';
      setTimeout(() => card.remove(), 150);
    }
  });

  webhooksList.appendChild(card);
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
    headers,
    template: card.querySelector('.webhook-payload-template').value.trim() || DEFAULT_WEBHOOK_TEMPLATE
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

// ── Floating Button ─────────────────────────────────
const FLOATING_EMOJI_CHOICES = [
  '✨', '🌐', '🔤', '📝', '✏️', '🖊️', '📖', '📚',
  '🧠', '🤖', '💬', '🗨️', '💡', '🔍', '🔎', '🎯',
  '⚡', '🚀', '🔧', '🛠️', '📋', '📌', '⭐', '❤️',
  '🔥', '✅', '❓', '❗', '➡️', '🔁', '🌍', '🗣️',
  '👁️', '🧪', '🧾', '🧹', '🎓', '🪄', '📤', '🎨'
];

const FLOATING_BG_PRESETS = ['#ffffff', '#f3f4f6', '#1f2937', '#f97316', '#fef3c7', '#dbeafe', '#dcfce7'];
const TOOLTIP_BG_PRESETS = FLOATING_BG_PRESETS;
const TOOLTIP_FONT_PRESETS = ['#1f2937', '#374151', '#6b7280', '#f9fafb', '#ffffff', '#f97316'];

// Live tooltip preview in the scene — same fields content.js applies on the
// page; the position select moves the preview around the fake selection
function updateTooltipPreview() {
  tooltipPreview.style.background = tooltipBgColor.value;
  tooltipPreview.style.color = tooltipFontColor.value;
  tooltipPreview.style.fontSize = `${tooltipFontSize.value}px`;
  const pos = tooltipPosition.value || 'below';
  tooltipPreview.className = `tooltip-preview pos-${pos}`;
  const scene = tooltipPreview.closest('.floating-scene');
  scene.classList.toggle('scene-horizontal', pos === 'left' || pos === 'right');

  // The real tooltip opens aligned with the selection's left edge — mirror
  // that for above/below by indenting to the fake selection's position
  if (pos === 'below' || pos === 'above') {
    const mark = scene.querySelector('.floating-scene-selection');
    const text = scene.querySelector('.floating-scene-text');
    const offset = Math.max(0, mark.getBoundingClientRect().left - text.getBoundingClientRect().left);
    tooltipPreview.style.marginLeft = `${offset}px`;
  } else {
    tooltipPreview.style.marginLeft = '';
  }
}

// Live preview pill (click = emoji grid) + background swatches; state lives in
// floatingEmojiValue/floatingBgValue, no form inputs.
function initFloatingAppearance(fb) {
  floatingEmojiValue = fb.emoji;
  floatingBgValue = fb.bgColor;
  floatingBgColor.value = fb.bgColor;

  for (const emoji of FLOATING_EMOJI_CHOICES) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'emoji-picker-item';
    item.textContent = emoji;
    item.addEventListener('click', () => {
      floatingEmojiValue = emoji;
      floatingEmojiPicker.hidden = true;
      updateFloatingPreview();
    });
    floatingEmojiPicker.appendChild(item);
  }

  floatingEmojiBtn.addEventListener('click', () => {
    floatingEmojiPicker.hidden = !floatingEmojiPicker.hidden;
  });

  document.addEventListener('click', (e) => {
    if (floatingEmojiPicker.hidden) return;
    if (!floatingEmojiPicker.contains(e.target) && !floatingEmojiBtn.contains(e.target)) {
      floatingEmojiPicker.hidden = true;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') floatingEmojiPicker.hidden = true;
  });

  initSwatchGroup(floatingSwatches, FLOATING_BG_PRESETS, floatingBgColor, (color) => {
    floatingBgValue = color;
    updateFloatingPreview();
  }).select(fb.bgColor);
}

// Preset circles + a "custom" swatch backed by a hidden native color input.
// select(color) marks the matching preset (or custom) active and fires onPick.
function initSwatchGroup(container, presets, colorInput, onPick) {
  const select = (color) => {
    colorInput.value = color;
    for (const swatch of container.querySelectorAll('.floating-swatch')) {
      const isCustom = swatch.classList.contains('floating-swatch-custom');
      swatch.classList.toggle('active', isCustom
        ? !presets.includes(color)
        : swatch.dataset.color === color);
    }
    onPick(color);
  };

  for (const color of presets) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'floating-swatch';
    swatch.dataset.color = color;
    swatch.style.background = color;
    swatch.title = color;
    swatch.addEventListener('click', () => select(color));
    container.appendChild(swatch);
  }

  const custom = document.createElement('button');
  custom.type = 'button';
  custom.className = 'floating-swatch floating-swatch-custom';
  custom.title = 'Custom color';
  custom.addEventListener('click', () => colorInput.click());
  container.appendChild(custom);

  colorInput.addEventListener('input', () => select(colorInput.value));

  return { select };
}

// Mirrors the content.js button: custom background inline + auto-contrast label
function updateFloatingPreview() {
  // Restart the fade-in/scale animation, like the button appearing on a page
  floatingPreview.style.animation = 'none';
  void floatingPreview.offsetWidth;
  floatingPreview.style.animation = '';

  floatingPreviewEmoji.textContent = floatingEmojiValue || '✨';
  floatingEmojiBtn.textContent = floatingEmojiValue || '✨';
  const selected = floatingAction.options[floatingAction.selectedIndex];
  floatingPreviewLabel.textContent = floatingAction.value && selected ? selected.textContent : 'no action';
  floatingPreview.style.background = floatingBgValue;
  const r = parseInt(floatingBgValue.slice(1, 3), 16);
  const g = parseInt(floatingBgValue.slice(3, 5), 16);
  const b = parseInt(floatingBgValue.slice(5, 7), 16);
  const dark = 0.299 * r + 0.587 * g + 0.114 * b < 128;
  floatingPreviewLabel.style.color = dark ? '#f9fafb' : '#374151';
  floatingPreview.style.borderColor = dark ? 'rgba(255, 255, 255, 0.3)' : '';
}

function refreshFloatingActionSelect(selectedId) {
  floatingAction.textContent = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '(no action pinned)';
  floatingAction.appendChild(none);
  for (const action of collectActions()) {
    const opt = document.createElement('option');
    opt.value = action.id;
    opt.textContent = action.name;
    if (action.id === selectedId) opt.selected = true;
    floatingAction.appendChild(opt);
  }
}

function renderFloatingDomains(domains) {
  floatingDomainsList.textContent = '';
  if (!domains?.length) {
    const empty = document.createElement('span');
    empty.className = 'floating-domains-empty';
    empty.textContent = 'No domains enabled yet';
    floatingDomainsList.appendChild(empty);
    return;
  }
  for (const host of domains) {
    const chip = document.createElement('span');
    chip.className = 'floating-domain-chip';
    const name = document.createElement('span');
    name.textContent = host;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'floating-domain-remove';
    removeBtn.title = `Remove ${host}`;
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => removeFloatingDomain(host));
    chip.appendChild(name);
    chip.appendChild(removeBtn);
    floatingDomainsList.appendChild(chip);
  }
}

// Applied immediately (not on Save) — mirrors the page context-menu toggle,
// which also writes straight to storage.
async function removeFloatingDomain(host) {
  const { floatingButtonSettings: fb, webhooks } = await getSettings();
  const domains = (fb.domains || []).filter(d => d !== host);
  await saveSettings({ floatingButtonSettings: { ...fb, domains } });
  const usedByWebhook = (webhooks || []).some(w => {
    try { return new URL(w.url).hostname.toLowerCase() === host; } catch { return false; }
  });
  // Removing a host covered by a required manifest pattern would subtract it
  // from the active set and break API fetches (see onSave)
  const isApiHost = chrome.runtime.getManifest().host_permissions
    .some(pattern => pattern.includes(`//${host}/`));
  if (!usedByWebhook && !isApiHost) {
    try {
      await chrome.permissions.remove({ origins: [`https://${host}/*`, `http://${host}/*`] });
    } catch { /* keep the grant */ }
  }
  renderFloatingDomains(domains);
}

// No pinned action → only the Action row (and the bare scene) stay visible;
// all-sites on → the domain list is irrelevant and disappears entirely
function syncFloatingVisibility() {
  const hasAction = !!floatingAction.value;
  floatingPreview.hidden = !hasAction;
  for (const row of document.querySelectorAll('.floating-extra')) {
    row.hidden = !hasAction;
  }
  document.querySelector('.floating-domains-field').hidden = !hasAction || floatingAllSites.checked;
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

  // Grant webhook origins while we still have the click gesture (before any
  // await) — otherwise the first tooltip send would fail with a network error.
  const permissionsPromise = requestWebhookPermissions(webhooks.map(w => w.url).filter(Boolean));

  // The all-sites grant/cleanup needs the same gesture — start before any
  // await too. Removing the broad https://*/* grant SUBTRACTS everything it
  // contains from the active/granted permission sets, INCLUDING the required
  // API host_permissions from the manifest AND the per-domain opt-in grants
  // (Chromium collapses pattern sets) — fetches then hit CORS and the button
  // dies on listed domains. The repair: one combined re-request of the
  // manifest hosts plus every listed domain right after the remove (a single
  // prompt at most; silent when everything is still granted). It runs on
  // every save as a self-heal for profiles already affected.
  const wantAllSites = floatingAllSites.checked;
  // Domains read from the rendered chips — the storage read comes only after
  // an await, which would forfeit the click gesture
  const domainOrigins = [...floatingDomainsList.querySelectorAll('.floating-domain-chip > span:first-child')]
    .flatMap(el => [`https://${el.textContent}/*`, `http://${el.textContent}/*`]);
  const allSitesPromise = (async () => {
    let granted = true;
    if (wantAllSites && !floatingAllSitesStored) {
      granted = await chrome.permissions.request({ origins: ALL_SITE_ORIGINS }).catch(() => false);
    } else if (!wantAllSites && floatingAllSitesStored) {
      await chrome.permissions.remove({ origins: ALL_SITE_ORIGINS }).catch(() => { /* keep the grant */ });
    }
    await chrome.permissions.request({
      origins: [...chrome.runtime.getManifest().host_permissions, ...domainOrigins]
    }).catch(() => { /* gesture consumed by a prompt above — next save repairs */ });
    return granted;
  })();

  // width/height are owned by the tooltip's resize handle (content.js), and
  // domains by the page context-menu toggle — re-read them fresh so saving
  // options doesn't reset them.
  const { tooltipSettings: currentTs, floatingButtonSettings: currentFb } = await getSettings();

  const tooltipSettings = {
    bgColor: tooltipBgColor.value,
    fontColor: tooltipFontColor.value,
    fontSize: parseInt(tooltipFontSize.value, 10),
    position: tooltipPosition.value,
    width: currentTs.width,
    height: currentTs.height
  };

  const allSitesGranted = await allSitesPromise;
  if (!allSitesGranted) floatingAllSites.checked = false;

  const floatingButtonSettings = {
    delayMs: parseInt(floatingDelay.value, 10),
    actionId: floatingAction.value || null,
    emoji: floatingEmojiValue,
    bgColor: floatingBgValue,
    domains: currentFb.domains,
    allSites: wantAllSites && allSitesGranted
  };

  try {
    await saveSettings({ modelConfigs, webhooks, actions, tooltipSettings, floatingButtonSettings, systemPrompt, darkMode });
    floatingAllSitesStored = floatingButtonSettings.allSites;
    syncFloatingVisibility();
    const granted = await permissionsPromise;
    const warnings = [];
    if (!granted) warnings.push('webhook origin permission not granted, sending will fail');
    if (wantAllSites && !allSitesGranted) warnings.push('all-sites permission denied — floating button stays per-domain');
    showSaveStatus(warnings.length ? `Saved — ${warnings.join('; ')}` : 'Saved', warnings.length === 0);
  } catch (err) {
    await permissionsPromise.catch(() => {});
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
    const targetLang = card.querySelector('.action-target-lang').value;
    const shortcutSlot = card.querySelector('.action-shortcut')?.value || '';
    if (name) {
      actions.push({ id: card.dataset.actionId || generateActionId(), name, template, displayMode, modelConfigId, targetLang, shortcutSlot });
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
