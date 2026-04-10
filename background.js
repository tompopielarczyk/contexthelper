import { getSettings, onSettingsChanged, isFirstRun, markInitialized } from './lib/storage.js';
import { callAI } from './lib/api-client.js';

const MENU_PARENT_ID = 'contexthelper-parent';

let _requestId = 0;
let _currentAbortController = null;

// Must register listener synchronously — survives service worker restarts
chrome.contextMenus.onClicked.addListener(handleMenuClick);

chrome.runtime.onInstalled.addListener(async () => {
  await rebuildContextMenu();

  if (await isFirstRun()) {
    await markInitialized();
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(() => {
  rebuildContextMenu();
});

onSettingsChanged(() => {
  rebuildContextMenu();
});

async function rebuildContextMenu() {
  await chrome.contextMenus.removeAll();

  const { actions } = await getSettings();
  if (!actions?.length) return;

  chrome.contextMenus.create({
    id: MENU_PARENT_ID,
    title: 'ContextHelper',
    contexts: ['selection']
  });

  actions.forEach((action, index) => {
    chrome.contextMenus.create({
      id: `action-${index}`,
      parentId: MENU_PARENT_ID,
      title: action.name,
      contexts: ['selection']
    });
  });
}

function resolveModelConfig(configs, configId) {
  if (!configs?.length) return null;
  if (configId) {
    return configs.find(c => c.id === configId) || configs[0];
  }
  return configs[0];
}

async function handleMenuClick(info, tab) {
  const match = info.menuItemId.match(/^action-(\d+)$/);
  if (!match) return;

  const requestId = ++_requestId;

  if (_currentAbortController) _currentAbortController.abort();
  _currentAbortController = new AbortController();
  const signal = _currentAbortController.signal;

  const actionIndex = parseInt(match[1], 10);
  const settings = await getSettings();
  const action = settings.actions[actionIndex];
  if (!action) return;

  const selectedText = info.selectionText;
  if (!selectedText?.trim()) return;

  // Notify content script: show loading indicator
  await sendToTab(tab.id, {
    type: 'AI_PROCESSING_START',
    requestId,
    tooltipSettings: settings.tooltipSettings
  });

  const prompt = action.template.replaceAll('{{text}}', selectedText);

  try {
    const config = resolveModelConfig(settings.modelConfigs, action.modelConfigId);
    if (!config) {
      throw new Error('No model configured. Please add a model in the extension settings.');
    }
    if (!config.apiKey) {
      throw new Error('Missing API key. Please configure the API key in settings.');
    }

    const result = await callAI({
      provider: config.provider,
      apiKey: config.apiKey,
      model: config.model,
      prompt,
      systemPrompt: settings.systemPrompt,
      signal
    });

    if (signal.aborted) return;

    await sendToTab(tab.id, {
      type: 'AI_RESULT',
      requestId,
      text: result,
      editable: info.editable,
      displayMode: action.displayMode || 'auto',
      tooltipSettings: settings.tooltipSettings
    });
  } catch (err) {
    if (signal.aborted) return;
    await sendToTab(tab.id, {
      type: 'AI_ERROR',
      requestId,
      message: err.message || 'An unknown error occurred',
      tooltipSettings: settings.tooltipSettings
    });
  } finally {
    if (_currentAbortController?.signal === signal) {
      _currentAbortController = null;
    }
  }
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Content script not loaded — can happen on restricted pages (chrome://, etc.)
  }
}
