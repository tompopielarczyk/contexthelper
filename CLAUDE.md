# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Loading the extension

There is no build step. Load the extension directly in Chrome:
1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" → select this directory
4. After any code change: click the reload button on the extension card (for content script changes, also refresh the target page)

## Architecture

**Chrome MV3 extension** — vanilla JS, no bundler, no dependencies.

```
background.js          # Service worker: context menu + AI calls
content.js             # IIFE injected into every page: overlay UI
options.html/js/css    # Settings page
lib/
  api-client.js        # Anthropic + OpenAI fetch wrappers, error mapping
  storage.js           # chrome.storage abstraction, default actions/settings
```

Supported providers: Anthropic, OpenAI, Google Gemini, OpenRouter (includes open-source models). Each provider has its own `callXxx()` function in `api-client.js` + an "Other..." option in the model dropdown for arbitrary model IDs.

### Data flow

1. User selects text → right-clicks → picks action from "ContextHelper" submenu
2. `background.js` (`handleMenuClick`) reads settings, sends `AI_PROCESSING_START` to content script, calls `lib/api-client.js`
3. Content script shows loading spinner (Shadow DOM overlay)
4. Background receives AI response → sends `AI_RESULT` or `AI_ERROR` to content script
5. Content script either replaces selected text or shows result tooltip

### Message protocol (background ↔ content script)

Three message types flow via `chrome.tabs.sendMessage`:
- `AI_PROCESSING_START` — carries `tooltipSettings`; content script shows spinner
- `AI_RESULT` — carries `text`, `editable`, `displayMode`, `tooltipSettings`
- `AI_ERROR` — carries `message`, `tooltipSettings`

`sendToTab()` in `background.js` silently catches errors when the content script isn't loaded (restricted pages like `chrome://`).

### Key architectural rules

**Service worker listeners must be registered synchronously** — MV3 service workers can be terminated after ~5 min idle. Listeners registered inside `async` functions or after an `await` will be lost on revival. Always register `chrome.contextMenus.onClicked.addListener` at the top level.

**Content script must remain IIFE** — MV3 content scripts do not support `type: "module"`. Only `background.js` and `options.js` use ES module `import/export`.

**Shadow DOM isolation** — all UI (tooltip, spinner) lives inside a closed Shadow DOM attached to a host `div`. This prevents host page styles from leaking in. `content.css` resets the host element (`all: initial !important`), while internal styles are injected via `getShadowStyles()` into the shadow root. Keep both in sync — `content.css` protects against host-page interference, `getShadowStyles()` defines the actual component styles.

**Storage split** — `chrome.storage.local` holds `modelConfigs` (array of `{ id, name, provider, model, apiKey }`) and `webhooks` (array of `{ id, name, url, method, headers }`) — both contain secrets and are not synced to Google account. `chrome.storage.sync` holds `actions`, `tooltipSettings`, `systemPrompt`, `darkMode`. Actions reference model configs via `modelConfigId` and webhooks via `webhookId`. The 8KB per-item limit of sync storage means large data (e.g., many long action templates) should be moved to local.

**Migration** — `getSettings()` auto-migrates two legacy schemas: (1) old single-provider data (separate `provider`, `model`, `apiKey` fields) into a `modelConfigs` array on first access — idempotent via `modelConfigs === null` check, creates one config from old fields, assigns it to all actions, cleans up old keys. (2) Legacy boolean `darkMode` is mapped to the tri-state form: `true` → `'dark'`, `false` → `'auto'`. New installs default to `'auto'`, which follows `prefers-color-scheme` via `matchMedia` (re-applied on system theme change while in `'auto'`).

**Text replacement** has three strategies in `content.js`:
- `replaceSelectedText()` — for editable inputs/textareas (native setter trick to bypass React synthetic events) and contenteditable (`document.execCommand('insertText')` to preserve undo stack)
- `forceReplaceInDOM()` — modifies read-only DOM via Selection API; only used when `displayMode === 'insert'`
- Tooltip fallback — when neither editable context is available

### Error handling pattern

`lib/api-client.js` uses a layered approach:
- `fetchWithErrorHandling()` — wraps `fetch` with AbortController timeout (90s) and maps network errors (AbortError → timeout, TypeError → no connection)
- `safeParseJSON()` — catches non-JSON error bodies (e.g., 502 HTML pages) that would throw SyntaxError
- `APIError` class — maps HTTP status codes to user-friendly messages (401 → invalid key, 429 → rate limit, 5xx → server unavailable)

### Overlay cleanup pattern

Content script tracks event listeners in `activeCleanups[]`. Every `showLoading/showResultTooltip/showErrorTooltip` call runs `hideOverlay()` first, which iterates and invokes all cleanup functions (removing keydown listeners, clearing timers, etc.) before building new UI. This prevents listener leaks across multiple sequential AI calls.

### Action `displayMode`

Each action has a `displayMode` field:
- `'auto'` — insert if the focused element is editable, otherwise tooltip
- `'tooltip'` — always show result in floating tooltip
- `'insert'` — always replace selected text (even in read-only DOM via `forceReplaceInDOM`)

### Webhook delivery

Actions can optionally POST their AI result to a user-configured external endpoint (Notion, Slack, Zapier, n8n, custom). Webhooks live in `chrome.storage.local` (Bearer tokens are secrets) under `webhooks: [{ id, name, url, method, headers: [{key,value}] }]`. Each action references one via `webhookId` (`''` = none).

`background.js` calls `sendWebhook` only when the result will appear in a tooltip — i.e. `displayMode === 'tooltip'`, or `displayMode === 'auto'` with a non-editable selection (`!info.editable`). Insert mode skips webhook delivery. AI errors also skip webhook delivery (no point logging failures to Notion).

Delivery is fire-and-forget: the tooltip renders immediately, the POST runs in the background. On failure, `background.js` sends a `WEBHOOK_FAILED` message to the content script, which attaches a small ⚠ badge in the bottom-left of the active tooltip with the error in its `title`. The badge is gated by `requestId` so a stale failure does not decorate a newer tooltip.

Permissions are granted **per-origin at runtime** via `chrome.permissions.request` (triggered by the Test button in options). The manifest declares `optional_host_permissions: ["http://*/*", "https://*/*"]` so users only grant access to the specific origins they configure (e.g. `https://api.notion.com/*`). Without this prompt, fetch will fail at runtime — the user's first action will surface a "Network error" badge.

The payload schema is fixed for now: `{ result, actionName, sourceText, pageUrl, pageTitle, timestamp, modelUsed }`. Adapter services (Zapier, n8n, custom) reshape this for downstream APIs that need different bodies (Slack `{text}`, Notion `{parent, properties, children}`). Templates are a future enhancement.

### Options page tabs

`options.html` is organized into 4 tabs (`Models | Webhooks | Appearance | Actions`). Each tab is a `<div class="tab-panel" data-tab="...">`; the System prompt sits inside the Actions tab as a separate card. `initTabs()` in `options.js` toggles `.active` and the `hidden` attribute on click. To add another tab: drop a `<button class="tab-btn" data-tab="X">` in the nav and a matching `<div class="tab-panel" data-tab="X" hidden>` in `<main>` — no JS change needed.

### Adding a new AI provider

1. Add provider ID to `VALID_PROVIDERS` in `lib/storage.js`
2. Add URL constant + `callXxx()` function in `lib/api-client.js`
3. Add branch in `callAI()` in `lib/api-client.js`
4. Add model list to `getAvailableModels()` and default model to `DEFAULT_MODELS` in `lib/api-client.js`
5. Add `<option>` to provider `<select>` in `modelConfigTemplate` in `options.html`
6. Add host permission in `manifest.json`

### DeepL (non-LLM provider)

DeepL is a translation API, not a chat LLM, so it deviates from the checklist above:
- **No model** — the Model field is hidden in the config card (`syncProviderFields` in `options.js`), `model` is stored as `''`, and `saveSettings` skips the model requirement for `provider === 'deepl'`.
- **Per-action `targetLang`** instead of a template — when an action's selected config is DeepL, `syncActionCardMode` in `options.js` hides the template textarea (kept in the DOM so its value survives switching configs) and shows a target-language `<select>` populated from `DEEPL_TARGET_LANGUAGES` in `lib/api-client.js`. Plain `EN`/`PT` are deprecated by DeepL — use regional variants (`EN-US`, `PT-BR`).
- **Endpoint auto-detection** — `getDeepLBaseUrl(apiKey)` picks `api-free.deepl.com` when the key ends with `:fx`, otherwise `api.deepl.com`. Both origins are in `host_permissions`.
- **No system prompt, no template substitution** — `background.js` sends the raw selection; `callAI` routes to `callDeepL` before any model resolution.
- **Test button** calls `GET /v2/usage` (via `getDeepLUsage`) instead of a chat call, and shows the character quota.
- **Error mapping** — DeepL returns 403 for bad keys (remapped to 401 for the shared message) and 456 when the character quota is exhausted (mapped in `APIError`).

### Action template syntax

Templates must contain `{{text}}` as the placeholder for selected text. `replaceAll('{{text}}', selectedText)` is used (not `replace`) — this matters if a template uses the placeholder more than once. Exception: actions backed by a DeepL config bypass the template entirely (validation requires `targetLang` instead).
