import { getSettings, saveSettings, onSettingsChanged, isFirstRun, markInitialized } from './lib/storage.js';
import { callAI } from './lib/api-client.js';
import { sendWebhook, renderTemplate } from './lib/webhook.js';

const MENU_PARENT_ID = 'contexthelper-parent';
const FLOATING_MENU_ID = 'contexthelper-floating-toggle';
const FLOATING_SCRIPT_ID = 'contexthelper-floating';

let _requestId = 0;
let _menuRebuildQueue = Promise.resolve();
const _abortControllersByTab = new Map();

// Must register listeners synchronously — survives service worker restarts
chrome.contextMenus.onClicked.addListener(handleMenuClick);
chrome.commands.onCommand.addListener(handleCommand);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'SEND_WEBHOOK') {
    handleSendWebhook(message).then(sendResponse);
    return true; // keep the channel open for the async response
  }
  if (message?.type === 'RUN_ACTION') {
    handleRunAction(message, sender);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await rebuildContextMenu();
  await syncFloatingButtonRegistration();

  if (await isFirstRun()) {
    await markInitialized();
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(() => {
  rebuildContextMenu();
  syncFloatingButtonRegistration();
});

onSettingsChanged(() => {
  rebuildContextMenu();
  syncFloatingButtonRegistration();
});

async function rebuildContextMenu() {
  _menuRebuildQueue = _menuRebuildQueue.catch(() => {}).then(rebuildContextMenuNow);
  return _menuRebuildQueue;
}

async function rebuildContextMenuNow() {
  await chrome.contextMenus.removeAll();

  const { actions } = await getSettings();
  if (!actions?.length) return;

  const shortcutBySlot = await getShortcutsBySlot();

  // Parent also matches 'page' so the floating-button toggle is reachable
  // without a selection; action items stay selection-only.
  chrome.contextMenus.create({
    id: MENU_PARENT_ID,
    title: 'ContextHelper',
    contexts: ['selection', 'page']
  });

  actions.forEach((action, index) => {
    const combo = action.shortcutSlot && shortcutBySlot.get(action.shortcutSlot);
    chrome.contextMenus.create({
      id: getMenuId(action, index),
      parentId: MENU_PARENT_ID,
      title: combo ? `${action.name} (${combo})` : action.name,
      contexts: ['selection']
    });
  });

  chrome.contextMenus.create({
    id: `${FLOATING_MENU_ID}-separator`,
    parentId: MENU_PARENT_ID,
    type: 'separator',
    contexts: ['selection', 'page']
  });
  chrome.contextMenus.create({
    id: FLOATING_MENU_ID,
    parentId: MENU_PARENT_ID,
    title: 'Floating button: enable/disable on this domain',
    contexts: ['selection', 'page']
  });
}

const COMMAND_SLOT_RE = /^run-action-([1-4])$/;

async function getShortcutsBySlot() {
  const bySlot = new Map();
  try {
    for (const command of await chrome.commands.getAll()) {
      const slot = COMMAND_SLOT_RE.exec(command.name)?.[1];
      if (slot && command.shortcut) bySlot.set(slot, command.shortcut);
    }
  } catch {
    // commands API unavailable — plain titles
  }
  return bySlot;
}

function getMenuId(action, index) {
  return `action-${action.id || `legacy-action-${index}`}`;
}

function resolveActionByMenuId(actions, menuItemId) {
  const match = String(menuItemId).match(/^action-(.+)$/);
  if (!match) return null;
  return actions.find((action, index) => (action.id || `legacy-action-${index}`) === match[1]) || null;
}

function resolveModelConfig(configs, configId) {
  if (!configs?.length) return null;
  if (configId) {
    return configs.find(c => c.id === configId) || null;
  }
  return configs[0];
}

// Manual delivery triggered by the send button in the result tooltip.
async function handleSendWebhook({ webhookId, webhookData }) {
  try {
    const { webhooks } = await getSettings();
    const webhook = webhooks.find(w => w.id === webhookId);
    if (!webhook) {
      throw new Error('Webhook not found — check the extension settings');
    }
    const payload = renderTemplate(webhook.template, {
      ...webhookData,
      timestamp: new Date().toISOString()
    });
    await sendWebhook(webhook, payload);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || 'Webhook delivery failed' };
  }
}

async function handleMenuClick(info, tab) {
  if (!tab?.id) return;

  if (info.menuItemId === FLOATING_MENU_ID) {
    await handleFloatingToggle(info, tab);
    return;
  }

  const settings = await getSettings();
  const action = resolveActionByMenuId(settings.actions, info.menuItemId);
  if (!action) return;

  if (!info.selectionText?.trim()) return;

  await runAction(action, { selectionText: info.selectionText, editable: info.editable }, tab, settings);
}

function floatingOriginsForHost(host) {
  return [`https://${host}/*`, `http://${host}/*`];
}

// Context-menu toggle: opt the current domain in or out of the floating button.
async function handleFloatingToggle(info, tab) {
  let host;
  try {
    const url = new URL(info.pageUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    host = url.hostname.toLowerCase();
  } catch {
    return;
  }

  // Request before any await — chrome.permissions.request needs the click
  // gesture. Already-granted origins (including the toggle-off path) resolve
  // silently without a prompt.
  let grantedPromise;
  try {
    // .catch also swallows the rejection on the toggle-off path, which never awaits
    grantedPromise = chrome.permissions.request({ origins: floatingOriginsForHost(host) }).catch(() => false);
  } catch {
    return; // pattern rejected (unlikely for a parsed http(s) hostname)
  }

  const settings = await getSettings();
  const fb = settings.floatingButtonSettings;

  if (fb.domains.includes(host)) {
    await saveSettings({ floatingButtonSettings: { ...fb, domains: fb.domains.filter(d => d !== host) } });
    // Revoke the origin unless a webhook still needs it (webhook grants use the
    // same per-origin patterns).
    const usedByWebhook = (settings.webhooks || []).some(w => {
      try { return new URL(w.url).hostname.toLowerCase() === host; } catch { return false; }
    });
    if (!usedByWebhook) {
      try { await chrome.permissions.remove({ origins: floatingOriginsForHost(host) }); } catch { /* keep the grant */ }
    }
    return;
  }

  if (!await grantedPromise) return;
  await saveSettings({ floatingButtonSettings: { ...fb, domains: [...fb.domains, host] } });

  if (!fb.actionId) {
    await showTabNotice(tab.id,
      'Floating button enabled here — now pick its action in the ContextHelper settings (Appearance tab)',
      settings);
  }
}

// Floating button click in the content script — resolve the pinned action and
// run the shared AI flow.
async function handleRunAction({ actionId, selectionText, editable }, sender) {
  const tab = sender?.tab;
  if (!tab?.id || !selectionText?.trim()) return;

  const settings = await getSettings();
  const action = (settings.actions || []).find(a => a.id === actionId);
  if (!action) {
    await showTabNotice(tab.id, 'Floating button action no longer exists — pick a new one in the extension settings', settings);
    return;
  }

  await runAction(action, { selectionText, editable }, tab, settings);
}

// Error tooltip outside the AI flow — content.js gates AI_ERROR on the
// requestId set by AI_PROCESSING_START, so the notice needs the full pair.
async function showTabNotice(tabId, message, settings) {
  if (!await ensureContentScript(tabId)) return;
  const requestId = ++_requestId;
  const ok = await sendToTab(tabId, {
    type: 'AI_PROCESSING_START',
    requestId,
    tooltipSettings: settings.tooltipSettings
  });
  if (!ok) return;
  await sendToTab(tabId, {
    type: 'AI_ERROR',
    requestId,
    message,
    tooltipSettings: settings.tooltipSettings
  });
}

// Keep the registered content script in step with the opt-in list: the button
// must be listening before any action runs, unlike the on-demand injection
// used by the menu/shortcut flows.
async function syncFloatingButtonRegistration() {
  try {
    const { floatingButtonSettings: fb } = await getSettings();
    let matches = fb.allSites
      ? ['http://*/*', 'https://*/*']
      : fb.domains.flatMap(floatingOriginsForHost);

    // Drop origins whose grant was revoked (e.g. via chrome://extensions)
    if (matches.length) {
      const checks = await Promise.all(matches.map(async pattern =>
        await chrome.permissions.contains({ origins: [pattern] }) ? pattern : null
      ));
      matches = checks.filter(Boolean);
    }

    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [FLOATING_SCRIPT_ID] });
    if (!matches.length) {
      if (existing.length) {
        await chrome.scripting.unregisterContentScripts({ ids: [FLOATING_SCRIPT_ID] });
      }
      return;
    }

    const script = {
      id: FLOATING_SCRIPT_ID,
      js: ['content.js'],
      css: ['content.css'],
      matches,
      runAt: 'document_idle',
      persistAcrossSessions: true
    };
    if (existing.length) {
      await chrome.scripting.updateContentScripts([script]);
    } else {
      await chrome.scripting.registerContentScripts([script]);
    }
  } catch {
    // Registration is self-healing — retried on the next startup/settings change
  }
}

async function handleCommand(command, tab) {
  const slot = COMMAND_SLOT_RE.exec(command)?.[1];
  if (!slot) return;

  if (!tab?.id) {
    // onCommand passes tab since Chrome 117 — query is the fallback
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab?.id) return;

  const settings = await getSettings();
  const action = (settings.actions || []).find(a => a.shortcutSlot === slot);
  if (!action) return;

  const selection = await getSelectionFromTab(tab.id);
  if (!selection) return; // restricted page (chrome://, Web Store, ...)

  if (!selection.text.trim()) {
    await showTabNotice(tab.id, 'Select some text first', settings);
    return;
  }

  await runAction(action, { selectionText: selection.text, editable: selection.editable }, tab, settings);
}

// Shared AI flow — callers guarantee a non-empty selectionText
async function runAction(action, { selectionText: selectedText, editable }, tab, settings) {
  const requestId = ++_requestId;
  const previousController = _abortControllersByTab.get(tab.id);
  if (previousController) previousController.abort();

  const controller = new AbortController();
  _abortControllersByTab.set(tab.id, controller);
  const signal = controller.signal;

  let canReportToTab = false;

  try {
    const contentReady = await ensureContentScript(tab.id);
    if (!contentReady) return;

    // Notify content script: show loading indicator before spending tokens.
    canReportToTab = await sendToTab(tab.id, {
      type: 'AI_PROCESSING_START',
      requestId,
      tooltipSettings: settings.tooltipSettings
    });
    if (!canReportToTab) return;

    const config = resolveModelConfig(settings.modelConfigs, action.modelConfigId);
    if (!config) {
      throw new Error('No model configured. Please add a model in the extension settings.');
    }
    if (!config.apiKey) {
      throw new Error('Missing API key. Please configure the API key in settings.');
    }

    // DeepL takes the raw selection (no prompt template, no system prompt)
    const isDeepL = config.provider === 'deepl';
    if (isDeepL && !action.targetLang) {
      throw new Error('No target language set for this action. Please configure it in settings.');
    }
    const prompt = isDeepL ? selectedText : action.template.replaceAll('{{text}}', selectedText);

    const result = await callAI({
      provider: config.provider,
      apiKey: config.apiKey,
      model: config.model,
      prompt,
      systemPrompt: isDeepL ? undefined : settings.systemPrompt,
      targetLang: action.targetLang,
      signal
    });

    if (signal.aborted) return;

    const displayMode = action.displayMode || 'auto';

    await sendToTab(tab.id, {
      type: 'AI_RESULT',
      requestId,
      text: result,
      editable,
      displayMode,
      tooltipSettings: settings.tooltipSettings,
      // Send-button data: names only for the menu, payload fields for SEND_WEBHOOK
      // (timestamp is stamped by the background at delivery time)
      webhooks: (settings.webhooks || []).map(w => ({ id: w.id, name: w.name })),
      webhookData: {
        result,
        actionName: action.name,
        sourceText: selectedText,
        pageUrl: tab?.url || '',
        pageTitle: tab?.title || '',
        modelUsed: isDeepL ? 'deepl' : (config.model || '')
      }
    });
  } catch (err) {
    if (signal.aborted) return;
    if (!canReportToTab) return;
    await sendToTab(tab.id, {
      type: 'AI_ERROR',
      requestId,
      message: err.message || 'An unknown error occurred',
      tooltipSettings: settings.tooltipSettings
    });
  } finally {
    if (_abortControllersByTab.get(tab.id)?.signal === signal) {
      _abortControllersByTab.delete(tab.id);
    }
  }
}

async function getSelectionFromTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.activeElement;
        const isTextControl = el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
        if (isTextControl && el.selectionStart != null && el.selectionEnd != null
            && el.selectionEnd > el.selectionStart) {
          return {
            text: el.value.slice(el.selectionStart, el.selectionEnd),
            editable: !el.readOnly && !el.disabled
          };
        }
        const text = window.getSelection()?.toString() || '';
        return { text, editable: !!(el && el.isContentEditable) };
      }
    });
    return results?.[0]?.result ?? null;
  } catch {
    // Restricted page (chrome://, about:, etc.)
    return null;
  }
}

async function ensureContentScript(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!window.__contexthelper_loaded
    });
    if (results[0]?.result) return true;
  } catch {
    return false;
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
    return true;
  } catch {
    // Restricted page (chrome://, about:, etc.)
    return false;
  }
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    // Content script not loaded — can happen on restricted pages (chrome://, etc.)
    return false;
  }
}
