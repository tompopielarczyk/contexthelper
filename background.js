import { getSettings, onSettingsChanged, isFirstRun, markInitialized } from './lib/storage.js';
import { callAI } from './lib/api-client.js';
import { sendWebhook, buildWebhookPayload } from './lib/webhook.js';

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

function resolveWebhook(webhooks, webhookId) {
  if (!webhookId || !webhooks?.length) return null;
  return webhooks.find(w => w.id === webhookId) || null;
}

function willShowTooltip(displayMode, editable) {
  if (displayMode === 'tooltip') return true;
  if (displayMode === 'insert') return false;
  // 'auto' (default): tooltip iff context is read-only
  return !editable;
}

function dispatchWebhook({ webhook, action, result, sourceText, modelUsed, tab, requestId }) {
  const payload = buildWebhookPayload({
    action,
    result,
    sourceText,
    pageUrl: tab?.url || '',
    pageTitle: tab?.title || '',
    modelUsed
  });
  sendWebhook(webhook, payload).catch((err) => {
    sendToTab(tab.id, {
      type: 'WEBHOOK_FAILED',
      requestId,
      message: err?.message || 'Webhook delivery failed'
    });
  });
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

  await ensureContentScript(tab.id);

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

    const displayMode = action.displayMode || 'auto';

    await sendToTab(tab.id, {
      type: 'AI_RESULT',
      requestId,
      text: result,
      editable: info.editable,
      displayMode,
      tooltipSettings: settings.tooltipSettings
    });

    const webhook = resolveWebhook(settings.webhooks, action.webhookId);
    if (webhook && willShowTooltip(displayMode, info.editable)) {
      dispatchWebhook({
        webhook,
        action,
        result,
        sourceText: selectedText,
        modelUsed: config.model || '',
        tab,
        requestId
      });
    }
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

async function ensureContentScript(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!window.__contexthelper_loaded
    });
    if (results[0]?.result) return;
  } catch {
    return;
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content.css']
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  } catch {
    // Restricted page (chrome://, about:, etc.)
  }
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Content script not loaded — can happen on restricted pages (chrome://, etc.)
  }
}
