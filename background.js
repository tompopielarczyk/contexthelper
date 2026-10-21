import { getSettings, saveSettings, onSettingsChanged, isFirstRun, markInitialized, customOrigins } from './lib/storage.js';
import { callAI } from './lib/api-client.js';
import { sendWebhook, renderTemplate } from './lib/webhook.js';
import {
  shouldStream, createThrottle, isRetryableError,
  ASK_ACTION_ID, pickLLMConfig, resolveActionConfig, sanitizeConversation, buildRefineMessages,
  resolveRefineInstruction, sanitizeClientId, buildAskPrompt, missingApiKeyError, nextChunk
} from './lib/chat.js';
import { renderActionPrompt, templateUsesPageContext, windowAround, sanitizePageVars } from './lib/prompt.js';
import { probeSelection, SELECTION_RULES } from './lib/page-probe.js';

const MENU_PARENT_ID = 'contexthelper-parent';
const FLOATING_MENU_ID = 'contexthelper-floating-toggle';
const ASK_MENU_ID = 'contexthelper-ask';
const ASK_COMMAND = 'ask-selection';
const FLOATING_SCRIPT_ID = 'contexthelper-floating';

let _menuRebuildQueue = Promise.resolve();
// tabId → { controller, requestId } of the run currently owning that tab
const _abortControllersByTab = new Map();

const CHUNK_THROTTLE_MS = 100;
// Every 20 s while a run is in flight: an extension API call resets the
// worker's idle timer, and AI_HEARTBEAT tells the page the run is alive
// (content.js gives up after LIVENESS_TIMEOUT_MS without one)
const KEEPALIVE_INTERVAL_MS = 20_000;
const SENSITIVE_FIELD_MESSAGE = 'ContextHelper does not send password or payment fields';
const ACTION_MODEL_REMOVED_MESSAGE = "This action's model was removed — pick another in settings";
const NO_MODEL_MESSAGE = 'No model configured. Please add a model in the extension settings.';

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
  if (message?.type === 'CANCEL_ACTION') {
    handleCancelAction(message, sender);
  }
  if (message?.type === 'RETRY_RUN') {
    handleRetryRun(message.retry, sender, sanitizeClientId(message.clientId));
  }
  if (message?.type === 'REFINE_ACTION') {
    handleRefine(message, sender, sanitizeClientId(message.clientId));
  }
  if (message?.type === 'RUN_ASK') {
    handleRunAsk(message, sender, sanitizeClientId(message.clientId));
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

onSettingsChanged((changes) => {
  // Only the action list feeds the menu — rebuilding on every sync write
  // (tooltip resize, dark mode, …) would multiply the rebuild races
  if (changes.actions) rebuildContextMenu();
  syncFloatingButtonRegistration();
});

// Registration filters matches through permissions.contains, so it must also
// follow grant changes (e.g. the options page re-requesting subtracted
// origins after an all-sites untoggle, or a revoke via chrome://extensions)
chrome.permissions.onAdded.addListener(() => syncFloatingButtonRegistration());
chrome.permissions.onRemoved.addListener(() => syncFloatingButtonRegistration());

async function rebuildContextMenu() {
  _menuRebuildQueue = _menuRebuildQueue.catch(() => {}).then(rebuildContextMenuNow);
  return _menuRebuildQueue;
}

// contextMenus.create is the one call in the namespace that is not promisified:
// it returns the id synchronously and reports failure only through
// runtime.lastError inside the callback. Without this wrapper a rebuild
// resolves while its items are still in flight, so the queue below would not
// actually serialize anything and the next removeAll could be ordered against
// half-committed items ("Cannot create item with duplicate id").
function createMenuItem(props) {
  return new Promise((resolve) => {
    chrome.contextMenus.create(props, () => {
      void chrome.runtime.lastError; // a later rebuild is authoritative
      resolve();
    });
  });
}

async function rebuildContextMenuNow() {
  await chrome.contextMenus.removeAll();

  // getSettings may write during migration, which fires onSettingsChanged and
  // queues another rebuild — read before creating anything
  // The parent and the Ask item exist even with zero actions
  const actions = (await getSettings()).actions || [];

  const shortcutBySlot = await getShortcutsBySlot();

  // Parent also matches 'page' so the floating-button toggle is reachable
  // without a selection; action items stay selection-only.
  await createMenuItem({
    id: MENU_PARENT_ID,
    title: 'ContextHelper',
    contexts: ['selection', 'page']
  });

  for (const [index, action] of actions.entries()) {
    const combo = action.shortcutSlot && shortcutBySlot.get(action.shortcutSlot);
    await createMenuItem({
      id: getMenuId(action, index),
      parentId: MENU_PARENT_ID,
      title: combo ? `${action.name} (${combo})` : action.name,
      contexts: ['selection']
    });
  }

  await createMenuItem({
    id: ASK_MENU_ID,
    parentId: MENU_PARENT_ID,
    title: 'Ask about selection…',
    contexts: ['selection']
  });

  await createMenuItem({
    id: `${FLOATING_MENU_ID}-separator`,
    parentId: MENU_PARENT_ID,
    type: 'separator',
    contexts: ['selection', 'page']
  });
  await createMenuItem({
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

  if (info.menuItemId === ASK_MENU_ID) {
    if (!info.selectionText?.trim()) return;
    const settings = await getSettings();
    if (await blockSensitiveMenuSelection(info, tab, settings)) return;
    await showAskPrompt(tab, info.selectionText, settings);
    return;
  }

  const settings = await getSettings();
  const action = resolveActionByMenuId(settings.actions, info.menuItemId);
  if (!action) return;

  if (!info.selectionText?.trim()) return;
  if (await blockSensitiveMenuSelection(info, tab, settings)) return;

  await runAction(action, { selectionText: info.selectionText, editable: info.editable }, tab, settings);
}

// info.selectionText of an editable selection may come from a password or
// payment field. Probe the focused field in the frame that was clicked and
// stop with a notice when it is sensitive — or when we can't tell (fail
// closed): the frame can't be probed, or the probe didn't reach an editable
// element (e.g. focus on the host of a closed shadow root).
async function blockSensitiveMenuSelection(info, tab, settings) {
  if (!info.editable) return false;
  const probe = await runSelectionProbe(tab.id, { frameId: info.frameId ?? 0 });
  if (probe && probe.inspected && !probe.sensitive) return false;
  await showTabNotice(tab.id, SENSITIVE_FIELD_MESSAGE, settings);
  return true;
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
    // Removing a host covered by a required manifest pattern would subtract
    // it from the active set and break API fetches (Chromium pattern-set
    // subtraction — same pitfall as the all-sites untoggle in options.js)
    const isApiHost = chrome.runtime.getManifest().host_permissions
      .some(pattern => pattern.includes(`//${host}/`));
    // A custom model endpoint on this host still needs its grant
    const usedByCustom = customOrigins(settings.modelConfigs).some(pattern => new URL(pattern).hostname === host);
    if (!usedByWebhook && !isApiHost && !usedByCustom) {
      try { await chrome.permissions.remove({ origins: floatingOriginsForHost(host) }); } catch { /* keep the grant */ }
    }
    return;
  }

  if (!await grantedPromise) return;
  await saveSettings({ floatingButtonSettings: { ...fb, domains: [...fb.domains, host] } });

  // The registered content script only covers future navigations — inject
  // into the current tab directly so the button works without a refresh
  // (idempotent guard; the watcher picks the new domain up via storage.onChanged)
  await ensureContentScript(tab.id);

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

// Abort the run that owns the tab, if any. A run's own `finally` only
// clears the map entry while it still holds its controller (identity check),
// so a newer run's entry is never removed by an older run.
function abortTabRun(tabId) {
  const running = _abortControllersByTab.get(tabId);
  if (!running) return;
  running.controller.abort();
  _abortControllersByTab.delete(tabId);
}

// Error tooltip outside the AI flow — content.js gates AI_ERROR on the
// requestId set by AI_PROCESSING_START, so the notice needs the full pair.
async function showTabNotice(tabId, message, settings, clientId = null) {
  // The notice replaces whatever the tab shows — stop a run still in flight
  // there, or it keeps spending tokens for a result nobody will see
  abortTabRun(tabId);
  if (!await ensureContentScript(tabId)) return;
  const requestId = crypto.randomUUID();
  const ok = await sendToTab(tabId, {
    type: 'AI_PROCESSING_START',
    requestId,
    clientId,
    tooltipSettings: settings.tooltipSettings
  });
  if (!ok) return;
  await sendToTab(tabId, {
    type: 'AI_ERROR',
    requestId,
    message,
    retry: null,
    partialText: '',
    tooltipSettings: settings.tooltipSettings
  });
}

// Dismissal of the spinner or the streaming tooltip. Only the run the
// content script was showing is aborted — a newer run on the tab is not.
function handleCancelAction({ requestId }, sender) {
  const entry = _abortControllersByTab.get(sender?.tab?.id);
  if (entry && requestId && entry.requestId === requestId) entry.controller.abort();
}

// "↻ Retry" in the error tooltip — re-dispatch by the spec runChat attached
// to AI_ERROR. Unknown kinds get a notice. `clientId` is the page's id for
// the spinner it already shows (see runChat).
async function handleRetryRun(retry, sender, clientId = null) {
  const tab = sender?.tab;
  if (!tab?.id) return;
  // The page already shows a spinner for this request (clientId) — every
  // early exit must answer with a notice, or that spinner never clears
  if (!retry || typeof retry !== 'object') {
    await showTabNotice(tab.id, 'This request can no longer be retried', await getSettings(), clientId);
    return;
  }

  switch (retry.kind) {
    case 'action': {
      const settings = await getSettings();
      if (typeof retry.selectionText !== 'string' || !retry.selectionText.trim()) {
        await showTabNotice(tab.id, 'Select some text first', settings, clientId);
        return;
      }
      const action = (settings.actions || []).find(a => a.id === retry.actionId);
      if (!action) {
        await showTabNotice(tab.id, 'Action no longer exists', settings, clientId);
        return;
      }
      await runAction(action, {
        selectionText: retry.selectionText,
        editable: !!retry.editable,
        pageVars: sanitizePageVars(retry.pageVars) // invalid → null → refetched
      }, tab, settings, clientId);
      return;
    }
    case 'refine':
      await handleRefine(retry, sender, clientId);
      return;
    case 'ask':
      await handleRunAsk(retry, sender, clientId);
      return;
    default:
      await showTabNotice(tab.id, 'This request can no longer be retried', await getSettings(), clientId);
      return;
  }
}

// Refine bar in the result tooltip: a preset (Shorter / Longer / Simpler),
// a free-text follow-up (`instruction`) or ↻ Retry (neither) on the
// conversation the result came with. The conversation comes back from the
// page, so it is re-validated here.
async function handleRefine({ actionId, conversation, preset, instruction, sourceText }, sender, clientId = null) {
  const tab = sender?.tab;
  if (!tab?.id) return;

  const settings = await getSettings();
  const cleanConversation = sanitizeConversation(conversation);
  const source = typeof sourceText === 'string' ? sourceText : '';
  // Resolved up front so a retry of a failed refine sends the same text;
  // a bad option still surfaces as AI_ERROR through buildRequest
  let resolvedInstruction = null;
  let optionError = null;
  try {
    resolvedInstruction = resolveRefineInstruction({ preset, instruction });
  } catch (err) {
    optionError = err;
  }

  await runChat(tab, settings, async () => {
    if (optionError) throw optionError;
    if (!cleanConversation) throw new Error('This result can no longer be refined');
    const isAsk = actionId === ASK_ACTION_ID;
    const action = isAsk ? null : (settings.actions || []).find(a => a.id === actionId);
    if (!isAsk && !action) throw new Error('Action no longer exists');
    const config = isAsk
      ? pickLLMConfig(settings.modelConfigs)
      : resolveActionConfig(settings.modelConfigs, action);
    if (!config) {
      if (isAsk) throw new Error('No LLM model configured');
      throw new Error(action.modelConfigId ? ACTION_MODEL_REMOVED_MESSAGE : NO_MODEL_MESSAGE);
    }
    if (config.provider === 'deepl') throw new Error('Refine is not available for DeepL');
    const keyError = missingApiKeyError(config);
    if (keyError) throw new Error(keyError);

    return {
      config,
      messages: buildRefineMessages(cleanConversation, resolvedInstruction),
      systemPrompt: settings.systemPrompt,
      displayMode: 'tooltip',
      editable: false,
      meta: { actionId, actionName: action?.name || 'Ask', sourceText: source }
    };
  }, {
    kind: 'refine', actionId, conversation: cleanConversation, instruction: resolvedInstruction, sourceText: source
  }, clientId);
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
  if (command === ASK_COMMAND) {
    await handleAskCommand(tab);
    return;
  }

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

  // Before the empty check: a sensitive field reports no text
  if (selection.sensitive) {
    await showTabNotice(tab.id, SENSITIVE_FIELD_MESSAGE, settings);
    return;
  }
  if (!selection.text.trim()) {
    await showTabNotice(tab.id, 'Select some text first', settings);
    return;
  }

  await runAction(action, { selectionText: selection.text, editable: selection.editable }, tab, settings);
}

async function handleAskCommand(tab) {
  if (!tab?.id) {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab?.id) return;

  const settings = await getSettings();
  const selection = await getSelectionFromTab(tab.id);
  if (!selection) return; // restricted page

  if (selection.sensitive) {
    await showTabNotice(tab.id, SENSITIVE_FIELD_MESSAGE, settings);
    return;
  }
  if (!selection.text.trim()) {
    await showTabNotice(tab.id, 'Select some text first', settings);
    return;
  }

  await showAskPrompt(tab, selection.text, settings);
}

const ASK_NEEDS_LLM_MESSAGE = 'Ask needs an LLM model — add one in the extension settings (DeepL cannot answer questions)';

// Open the question input next to the selection (content.js answers with RUN_ASK)
async function showAskPrompt(tab, selectionText, settings) {
  if (!pickLLMConfig(settings.modelConfigs)) {
    await showTabNotice(tab.id, ASK_NEEDS_LLM_MESSAGE, settings);
    return;
  }
  // A run still starting up (before its AI_PROCESSING_START) is unknown to
  // the content script's cancel — abort it here, or its START would replace
  // the input. runChat re-checks signal.aborted after every await.
  abortTabRun(tab.id);
  if (!await ensureContentScript(tab.id)) return;
  await sendToTab(tab.id, {
    type: 'ASK_PROMPT',
    selectionText,
    tooltipSettings: settings.tooltipSettings
  });
}

// Question submitted from the Ask input (or its retry). The page already
// shows a spinner for `clientId` — every early exit answers with a notice,
// or that spinner never clears.
async function handleRunAsk({ question, selectionText }, sender, clientId = null) {
  const tab = sender?.tab;
  if (!tab?.id) return;

  const settings = await getSettings();
  if (typeof selectionText !== 'string' || !selectionText.trim()) {
    await showTabNotice(tab.id, 'Select some text first', settings, clientId);
    return;
  }
  if (typeof question !== 'string' || !question.trim()) {
    await showTabNotice(tab.id, 'Type a question first', settings, clientId);
    return;
  }
  if (!pickLLMConfig(settings.modelConfigs)) {
    await showTabNotice(tab.id, ASK_NEEDS_LLM_MESSAGE, settings, clientId);
    return;
  }
  await runAsk(question, selectionText, tab, settings, clientId);
}

// Free-form question about the selection — always a tooltip answer, first LLM config
function runAsk(question, selectionText, tab, settings, clientId = null) {
  return runChat(tab, settings, async () => {
    const config = pickLLMConfig(settings.modelConfigs);
    if (!config) throw new Error(ASK_NEEDS_LLM_MESSAGE);
    const keyError = missingApiKeyError(config);
    if (keyError) throw new Error(keyError);
    const prompt = buildAskPrompt(question, selectionText);
    return {
      config,
      messages: [{ role: 'user', content: prompt }],
      prompt,
      systemPrompt: settings.systemPrompt,
      displayMode: 'tooltip',
      editable: false,
      meta: { actionId: ASK_ACTION_ID, actionName: 'Ask', sourceText: selectionText }
    };
  }, { kind: 'ask', question, selectionText }, clientId);
}

// Shared AI flow for text actions — callers guarantee a non-empty selectionText
function runAction(action, { selectionText, editable, pageVars = null }, tab, settings, clientId = null) {
  const displayMode = action.displayMode || 'auto';
  // Filled with the page vars inside buildRequest, so a retry reuses the
  // context captured with the original selection instead of re-reading the page
  const retrySpec = { kind: 'action', actionId: action.id, selectionText, editable: !!editable };
  return runChat(tab, settings, async () => {
    const config = resolveActionConfig(settings.modelConfigs, action);
    if (!config) {
      throw new Error(action.modelConfigId ? ACTION_MODEL_REMOVED_MESSAGE : NO_MODEL_MESSAGE);
    }
    // Custom endpoints (Ollama, LM Studio) may run without a key
    const keyError = missingApiKeyError(config);
    if (keyError) throw new Error(keyError);

    // DeepL takes the raw selection (no prompt template, no system prompt)
    const isDeepL = config.provider === 'deepl';
    if (isDeepL && !action.targetLang) {
      throw new Error('No target language set for this action. Please configure it in settings.');
    }
    const pageContext = !isDeepL && templateUsesPageContext(action.template)
      ? (pageVars || await getPageContext(tab))
      : null;
    if (pageContext) retrySpec.pageVars = pageContext;
    const prompt = isDeepL
      ? selectionText
      : renderActionPrompt(action.template, { text: selectionText, ...pageContext });

    return {
      config,
      messages: isDeepL ? null : [{ role: 'user', content: prompt }],
      prompt,
      systemPrompt: isDeepL ? undefined : settings.systemPrompt,
      targetLang: action.targetLang,
      displayMode,
      editable,
      meta: { actionId: action.id, actionName: action.name, sourceText: selectionText }
    };
  }, retrySpec, clientId);
}

/**
 * Shared runner for every AI request shown in a tab: spinner, optional
 * streaming into the tooltip, result or error. One run per tab — a new run
 * aborts the previous one.
 * @param {chrome.tabs.Tab} tab
 * @param {object} settings  result of getSettings()
 * @param {() => Promise<{ config, messages, prompt, systemPrompt, targetLang,
 *   displayMode, editable, meta: { actionId, actionName, sourceText } }>} buildRequest
 *   throws → AI_ERROR without retry (config problems a retry cannot fix)
 * @param {object | null} retrySpec  attached to AI_ERROR when the AI call
 *   itself failed with a retryable error
 * @param {string | null} clientId  id the page chose for a run it requested
 *   (refine, retry); echoed in AI_PROCESSING_START so the page can drop a
 *   run it dismissed before the START arrived
 */
async function runChat(tab, settings, buildRequest, retrySpec = null, clientId = null) {
  abortTabRun(tab.id); // one run per tab

  // UUIDs, not a counter: the content script outlives a worker restart and
  // must never match a stale id from the previous worker
  const requestId = crypto.randomUUID();
  const controller = new AbortController();
  _abortControllersByTab.set(tab.id, { controller, requestId });
  const signal = controller.signal;
  const tooltipSettings = settings.tooltipSettings;

  let canReportToTab = false;
  let aiCallStarted = false;
  let partialText = '';
  let throttle = null;
  let keepalive = null;
  let sentLength = 0; // chars of the streamed answer already sent as AI_CHUNK

  // Every message of this run goes through one promise chain, so the tab
  // receives them in issue order: no chunk can overtake AI_RESULT/AI_ERROR
  let sendChain = Promise.resolve();
  const send = (message) => (sendChain = sendChain.then(() => sendToTab(tab.id, message)));

  // Heartbeats stop before the terminal message is enqueued, and one that
  // was already queued becomes a no-op once the run ended (or was aborted),
  // so AI_HEARTBEAT can never follow AI_RESULT / AI_ERROR
  let ended = false;
  const stopHeartbeat = () => {
    ended = true;
    clearInterval(keepalive);
  };
  const sendHeartbeat = () => (sendChain = sendChain.then(() =>
    ended || signal.aborted ? false : sendToTab(tab.id, { type: 'AI_HEARTBEAT', requestId })));

  try {
    const contentReady = await ensureContentScript(tab.id);
    if (!contentReady || signal.aborted) return;

    // Notify content script: show loading indicator before spending tokens.
    canReportToTab = await send({
      type: 'AI_PROCESSING_START',
      requestId,
      clientId,
      tooltipSettings
    });
    if (!canReportToTab || signal.aborted) return;

    // From START on: keep the worker alive (extension API calls reset its
    // idle timer) and tell the page the run is still going — reasoning
    // models can think for minutes without a single chunk. Heartbeats go
    // through the same ordered chain as every other message of the run.
    keepalive = setInterval(() => {
      chrome.runtime.getPlatformInfo().catch(() => {});
      if (!ended && !signal.aborted) sendHeartbeat();
    }, KEEPALIVE_INTERVAL_MS);

    const request = await buildRequest();
    if (signal.aborted) return;

    const { config, messages, prompt, systemPrompt, targetLang, displayMode, editable, meta } = request;
    const isDeepL = config.provider === 'deepl';
    const streaming = shouldStream({ provider: config.provider, displayMode, editable });
    if (streaming) {
      // Chunks carry only the new text and its offset (the page appends);
      // resending the accumulated text would make the traffic quadratic
      throttle = createThrottle(text => {
        const chunk = nextChunk(sentLength, text);
        if (!chunk) return;
        sentLength += chunk.delta.length;
        send({ type: 'AI_CHUNK', requestId, offset: chunk.offset, delta: chunk.delta, tooltipSettings });
      }, CHUNK_THROTTLE_MS);
    }

    aiCallStarted = true;
    const result = await callAI({
      provider: config.provider,
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      prompt,
      messages,
      systemPrompt,
      targetLang,
      signal,
      onDelta: streaming
        ? (text) => {
            partialText = text;
            throttle.call(text);
          }
        : undefined
    });

    if (signal.aborted) return;
    // Cancel, never flush: AI_RESULT carries the full text, and a last chunk
    // would flash the streaming tooltip for an answer that finished fast
    throttle?.cancel();
    stopHeartbeat();

    const conversationBase = messages?.length ? messages : [{ role: 'user', content: prompt }];

    // Queued behind any chunk still in flight (see send)
    await send({
      type: 'AI_RESULT',
      requestId,
      text: result,
      editable,
      displayMode,
      tooltipSettings,
      actionId: meta.actionId,
      sourceText: meta.sourceText,
      // DeepL has no conversation to continue
      conversation: isDeepL ? null : [...conversationBase, { role: 'assistant', content: result }],
      // Send-button data: names only for the menu, payload fields for SEND_WEBHOOK
      // (timestamp is stamped by the background at delivery time)
      webhooks: (settings.webhooks || []).map(w => ({ id: w.id, name: w.name })),
      webhookData: {
        result,
        actionName: meta.actionName,
        sourceText: meta.sourceText,
        pageUrl: tab?.url || '',
        pageTitle: tab?.title || '',
        modelUsed: isDeepL ? 'deepl' : (config.model || '')
      }
    });
  } catch (err) {
    // Never flush here: a late chunk after AI_ERROR would re-open the stream view
    throttle?.cancel();
    stopHeartbeat();
    if (signal.aborted) return;
    if (!canReportToTab) return;
    await send({
      type: 'AI_ERROR',
      requestId,
      message: err?.message || 'An unknown error occurred',
      partialText,
      retry: aiCallStarted && isRetryableError(err) ? retrySpec : null,
      tooltipSettings
    });
  } finally {
    stopHeartbeat(); // safety net (early returns, aborts)
    if (_abortControllersByTab.get(tab.id)?.controller === controller) {
      _abortControllersByTab.delete(tab.id);
    }
  }
}

/**
 * Run probeSelection (lib/page-probe.js) in the tab's top frame, or in
 * `frameId`. Null when the page or frame can't be scripted (chrome://,
 * Web Store, a frame without access).
 * @returns {Promise<{ text, editable, sensitive, blockText, start, end, title, url } | null>}
 */
async function runSelectionProbe(tabId, { frameId = null, withContext = false } = {}) {
  try {
    const results = await chrome.scripting.executeScript({
      target: frameId === null ? { tabId } : { tabId, frameIds: [frameId] },
      func: probeSelection,
      args: [SELECTION_RULES, withContext]
    });
    return results?.[0]?.result ?? null;
  } catch {
    return null;
  }
}

/**
 * The selection for the keyboard paths: `{ text, editable, sensitive }`, or
 * null on a restricted page. `sensitive` = a password or payment field has
 * focus (its text is never read).
 */
async function getSelectionFromTab(tabId) {
  const probe = await runSelectionProbe(tabId);
  if (!probe) return null;
  return { text: probe.text || '', editable: !!probe.editable, sensitive: !!probe.sensitive };
}

/**
 * Page context for {{context}} / {{pageTitle}} / {{pageUrl}}: the selection's
 * surrounding block (windowed around the selection), plus title and URL.
 * Restricted pages fall back to '' context and the tab's title/url; a
 * sensitive field gives '' context.
 */
async function getPageContext(tab) {
  const fallback = { context: '', pageTitle: tab.title || '', pageUrl: tab.url || '' };
  const r = await runSelectionProbe(tab.id, { withContext: true });
  if (!r) return fallback;
  return {
    context: r.blockText ? windowAround(r.blockText, r.start, r.end) : '',
    pageTitle: r.title || fallback.pageTitle,
    pageUrl: r.url || fallback.pageUrl
  };
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
