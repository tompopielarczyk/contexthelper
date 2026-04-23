import { getSettings, saveSettings, getDefaultActions, getDefaultTooltipSettings, getDefaultSystemPrompt, generateConfigId } from './lib/storage.js';
import { getAvailableModels, getDefaultModel, callAI } from './lib/api-client.js';

// ── DOM refs ────────────────────────────────────────
const modelConfigsList = document.getElementById('modelConfigsList');
const addModelConfigBtn = document.getElementById('addModelConfig');
const actionsList = document.getElementById('actionsList');
const addActionBtn = document.getElementById('addAction');
const restoreDefaultsBtn = document.getElementById('restoreDefaults');
const saveBtn = document.getElementById('saveBtn');
const saveStatus = document.getElementById('saveStatus');
const actionTemplate = document.getElementById('actionTemplate');
const modelConfigTemplate = document.getElementById('modelConfigTemplate');
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

const CUSTOM_MODEL_VALUE = '__custom__';

// ── Init ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

async function init() {
  const settings = await getSettings();

  // Dark mode
  if (settings.darkMode) document.body.classList.add('dark');
  darkModeToggle.addEventListener('click', toggleDarkMode);

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

  // Actions
  renderActions(settings.actions || getDefaultActions());

  addActionBtn.addEventListener('click', () => {
    addActionCard({ name: '', template: '{{text}}', displayMode: 'auto', modelConfigId: '' });
  });

  // Restore defaults
  restoreDefaultsBtn.addEventListener('click', onRestoreDefaults);

  // Save
  saveBtn.addEventListener('click', onSave);
}

// ── Dark Mode ──────────────────────────────────────
function toggleDarkMode() {
  document.body.classList.toggle('dark');
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

  providerSelect.addEventListener('change', () => {
    populateModelSelect(modelSelect, customModelInput, providerSelect.value, '');
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

// ── Action Model Selectors Sync ────────────────────
function collectModelConfigs() {
  const cards = modelConfigsList.querySelectorAll('.model-config-card');
  const configs = [];
  for (const card of cards) {
    const modelSelect = card.querySelector('.model-config-model');
    const customModel = card.querySelector('.model-config-custom-model');
    const model = modelSelect.value === CUSTOM_MODEL_VALUE
      ? customModel.value.trim()
      : modelSelect.value;

    configs.push({
      id: card.dataset.configId,
      name: card.querySelector('.model-config-name').value.trim(),
      provider: card.querySelector('.model-config-provider').value,
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
      continue;
    }

    for (const config of configs) {
      const opt = document.createElement('option');
      opt.value = config.id;
      opt.textContent = config.name || '(unnamed)';
      if (config.id === currentValue) opt.selected = true;
      select.appendChild(opt);
    }
  }
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

  const nameInput = card.querySelector('.action-name');
  const templateInput = card.querySelector('.action-template');
  const displayModeSelect = card.querySelector('.action-display-mode');
  const modelConfigSelect = card.querySelector('.action-model-config');
  const deleteBtn = card.querySelector('.action-delete');

  nameInput.value = action.name;
  templateInput.value = action.template;
  displayModeSelect.value = action.displayMode || 'auto';

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
  const actions = collectActions();
  const systemPrompt = systemPromptInput.value;
  const darkMode = document.body.classList.contains('dark');

  const tooltipSettings = {
    bgColor: tooltipBgColor.value,
    fontColor: tooltipFontColor.value,
    fontSize: parseInt(tooltipFontSize.value, 10),
    position: tooltipPosition.value
  };

  try {
    await saveSettings({ modelConfigs, actions, tooltipSettings, systemPrompt, darkMode });
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
    if (name) {
      actions.push({ name, template, displayMode, modelConfigId });
    }
  }
  return actions;
}

function showSaveStatus(message, success) {
  saveStatus.textContent = message;
  saveStatus.className = `save-status ${success ? 'success' : 'error'}`;
  saveStatus.hidden = false;
  setTimeout(() => { saveStatus.hidden = true; }, 3000);
}
