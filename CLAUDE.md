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

Supported providers: Anthropic, OpenAI, Google Gemini, OpenRouter (includes open-source models). Each provider has its own `callXxx()` function in `api-client.js`. The model field is a free-text combobox (`<input>` + `<datalist>`) — any model ID can be typed directly (no "Other..." special case; see Model lists below).

### Data flow

1. User selects text → right-clicks → picks action from "ContextHelper" submenu, **or** presses a keyboard shortcut (see Keyboard shortcuts below)
2. `background.js` (`handleMenuClick` or `handleCommand`, both thin adapters over the shared `runAction`) reads settings, sends `AI_PROCESSING_START` to content script, calls `lib/api-client.js`
3. Content script shows loading spinner (Shadow DOM overlay)
4. Background receives AI response → sends `AI_RESULT` or `AI_ERROR` to content script
5. Content script either replaces selected text or shows result tooltip

### Message protocol (background ↔ content script)

Three message types flow via `chrome.tabs.sendMessage`:
- `AI_PROCESSING_START` — carries `tooltipSettings`; content script shows spinner
- `AI_RESULT` — carries `text`, `editable`, `displayMode`, `tooltipSettings`, plus `webhooks` (`[{id, name}]` — names only, no secrets) and `webhookData` (payload fields for a manual webhook send)
- `AI_ERROR` — carries `message`, `tooltipSettings`

Two message types flow the other way (content script → background, `chrome.runtime.sendMessage`):
- `SEND_WEBHOOK` — carries `webhookId` + `webhookData`; the background resolves the webhook from storage, renders its payload template, delivers it, and answers `{ok}` or `{ok: false, error}` via `sendResponse`
- `RUN_ACTION` — carries `actionId` + `selectionText` + `editable` (sent by the floating selection button); the background resolves the action from settings and calls the shared `runAction`

`sendToTab()` in `background.js` silently catches errors when the content script isn't loaded (restricted pages like `chrome://`).

### Key architectural rules

**Service worker listeners must be registered synchronously** — MV3 service workers can be terminated after ~5 min idle. Listeners registered inside `async` functions or after an `await` will be lost on revival. Always register `chrome.contextMenus.onClicked.addListener` and `chrome.commands.onCommand.addListener` at the top level.

**Content script must remain IIFE** — MV3 content scripts do not support `type: "module"`. Only `background.js` and `options.js` use ES module `import/export`.

**Shadow DOM isolation** — all UI (tooltip, spinner) lives inside a closed Shadow DOM attached to a host `div`. This prevents host page styles from leaking in. `content.css` resets the host element (`all: initial !important`), while internal styles are injected via `getShadowStyles()` into the shadow root. Keep both in sync — `content.css` protects against host-page interference, `getShadowStyles()` defines the actual component styles.

**Storage split** — `chrome.storage.local` holds `modelConfigs` (array of `{ id, name, provider, model, apiKey }`), `webhooks` (array of `{ id, name, url, method, headers, template }`) — both contain secrets and are not synced to Google account — and `modelListCache` (per-provider live model lists, no secrets, just local-only cache). `chrome.storage.sync` holds `actions`, `tooltipSettings`, `floatingButtonSettings`, `systemPrompt`, `darkMode`. Actions reference model configs via `modelConfigId`; webhooks are a global list, not bound to actions (a legacy `webhookId` field on actions is stripped on read and write). The 8KB per-item limit of sync storage means large data (e.g., many long action templates) should be moved to local.

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

**Resizable result tooltip** — the result tooltip (`.cmn-resizable`) has a native CSS `resize: both` handle; a `ResizeObserver` (`observeTooltipResize`) detects the drag, releases the default 400px max-height cap, and debounce-saves the size into `tooltipSettings.width/height` (sync storage, sanitized to 240–1200 × 120–900 in `lib/storage.js`; `null` = auto). Subsequent tooltips open at the stored width with the stored height as `max-height` (short results stay compact). Options save re-reads these two fields from storage so the Appearance form doesn't reset them. Error tooltips and the spinner are not resizable.

### Action `displayMode`

Each action has a `displayMode` field:
- `'auto'` — insert if the focused element is editable, otherwise tooltip
- `'tooltip'` — always show result in floating tooltip
- `'insert'` — always replace selected text (even in read-only DOM via `forceReplaceInDOM`)

### Webhook delivery

Webhook delivery is **manual, from the result tooltip** — there is no automatic delivery. Webhooks are a global list in `chrome.storage.local` (Bearer tokens are secrets) under `webhooks: [{ id, name, url, method, headers: [{key,value}], template }]`; they are not bound to actions.

Every result tooltip offers a send control (built by `createWebhookSendControl` in `content.js`): one webhook renders a direct "Send to <name>" button, several render a "Send ▾" drop-up menu. Clicking sends `SEND_WEBHOOK` to the background, which renders the webhook's payload template and delivers it; the button reflects the response (`Sending… / ✓ Sent / ⚠ Failed` with the error in its `title`, retry enabled on failure). Insert mode shows no tooltip, hence no send — that is by design. AI errors show no send control either.

**Payload templates** — each webhook has a `template`: a JSON document with placeholders (`{{result}}`, `{{sourceText}}`, `{{actionName}}`, `{{pageUrl}}`, `{{pageTitle}}`, `{{timestamp}}`, `{{modelUsed}}`) inside string values. `renderTemplate` in `lib/webhook.js` parses the template as JSON first and substitutes placeholders in the parsed tree, so quotes/newlines in AI output can never break the payload; unknown `{{...}}` tokens (e.g. n8n expressions) pass through untouched. `DEFAULT_WEBHOOK_TEMPLATE` reproduces the classic flat schema. `saveSettings` rejects templates that don't parse as JSON. The Test button sends the real template rendered with sample data, so a passing test validates the actual payload shape.

Permissions are granted **per-origin at runtime** via `chrome.permissions.request` — a single combined prompt on Save (`requestWebhookPermissions`, called before any `await` to preserve the user gesture) and per-webhook on Test. The manifest declares `optional_host_permissions: ["http://*/*", "https://*/*"]` so users only grant access to the specific origins they configure (e.g. `https://api.notion.com/*`).

### Keyboard shortcuts

`chrome.commands` are static (declared in `manifest.json`) — Chrome does not allow per-action dynamic commands. The extension declares 4 fixed slots `run-action-1..4` (suggested defaults Ctrl+Shift+1..4; on macOS only slots 1–2 get suggestions since Cmd+Shift+3/4 are system screenshots). Each action has a `shortcutSlot: '' | '1'..'4'` field (sync storage); the options action card has a `.action-shortcut` select whose labels show the live key combos from `chrome.commands.getAll()`. Slot uniqueness: auto-steal in the options DOM (radio-like) + duplicate rejection in `saveSettings`.

Trigger path: `chrome.commands.onCommand → handleCommand` in `background.js` — maps the command to the action via `shortcutSlot`, reads the selection from the page with `getSelectionFromTab` (`chrome.scripting.executeScript`), then calls the shared `runAction`. Empty selection shows a "Select some text first" tooltip (requires the `AI_PROCESSING_START` + `AI_ERROR` pair — content.js gates `AI_ERROR` on the requestId set by START). Restricted pages are a silent no-op. Context-menu titles append the current combo (e.g. "Translate to English (Ctrl+Shift+1)"), refreshed on every menu rebuild. Key combos themselves live in Chrome (`chrome://extensions/shortcuts`), not in extension storage — the options footer links there via `chrome.tabs.create` (plain anchors to chrome:// are blocked).

### Floating selection button

A third trigger path besides the context menu and keyboard shortcuts: select text → after `delayMs` an emoji pill fades in near the end of the selection → hover expands the pinned action's name → click sends `RUN_ACTION` to the background, which runs the standard `runAction` flow.

**Per-domain opt-in** — the feature requires a content script present *before* any action runs, but the extension must not demand all-sites access. The page context menu ("Floating button: enable/disable on this domain", shown on `page` + `selection` contexts) requests the host permission for that single domain (`chrome.permissions.request` inside the click gesture) and toggles the hostname in `floatingButtonSettings.domains`. On toggle-on the background also injects `content.js` into the current tab directly (`ensureContentScript`) — the registered script only covers future navigations, and this makes the button work without a refresh. `syncFloatingButtonRegistration()` in `background.js` keeps a dynamically registered content script (`chrome.scripting.registerContentScripts`, id `contexthelper-floating`, `persistAcrossSessions`) in step with that list — called from `storage.onChanged`, `onInstalled` and `onStartup` (self-healing; skips origins whose grant was revoked). Empty list + `allSites: false` = script unregistered, zero footprint.

**All-sites toggle** — the options card also offers `allSites`: enabling requests the broad `http://*/*` + `https://*/*` grant within the Save click gesture (denied → toggle reverts); disabling removes the broad grant and re-registers for the domain list only. Already-loaded tabs stop showing the button immediately via `storage.onChanged` in the content script, though the injected script itself lives until reload.

**Permission-subtraction pitfall** — `chrome.permissions.remove` subtracts everything the removed pattern *contains* from the active permission set. Removing `https://*/*` therefore also strips the **required** API `host_permissions` from the manifest (all https), and every AI fetch starts failing CORS ("No internet connection" in the tooltip). The subtraction also strips the per-domain opt-in grants. Defenses in the code: (1) `onSave` in `options.js` re-requests the manifest `host_permissions` **plus** every listed domain (read from the rendered chips — a storage read would forfeit the gesture) inside the same click gesture on **every** save — one combined prompt at most, silent when everything is still granted — which both pairs with the untoggle removal and self-heals already-affected profiles; (2) per-domain removals (`removeFloatingDomain` in options, the context-menu toggle in background) skip `permissions.remove` when the host is covered by a manifest pattern; (3) `background.js` re-runs `syncFloatingButtonRegistration` on `chrome.permissions.onAdded/onRemoved`, because the re-grant can land after the `storage.onChanged` resync already filtered the domain out. Never remove a broad origin pattern without re-requesting the manifest hosts in the same gesture.

**Appearance rules** (content.js) — button shows only for selections of ≥3 chars outside editable contexts (input/textarea/contenteditable); `selectionchange` + `mouseup` re-arm a `delayMs` timer, so it appears once the selection is stable. Hides on: deselect, outside mousedown, Esc, scroll, and `AI_PROCESSING_START`. The button element (`.cmn-float-btn`) deliberately lacks the `.cmn-overlay` class and has its own cleanup list (`floatingCleanups`) — `hideOverlay()` must not remove it, and vice versa. `floatingButtonSettings` (`{ delayMs, actionId, emoji, bgColor, domains, allSites }`, sync storage, sanitized in `lib/storage.js`) is read at injection and refreshed live via `storage.onChanged`. A non-default `bgColor` is applied inline (which also disables the CSS hover lightening); dark backgrounds get an auto-contrast light label/border.

### Options page tabs

`options.html` is organized into 4 tabs (`Models | Webhooks | Appearance | Actions`). Each tab is a `<div class="tab-panel" data-tab="...">`; the System prompt sits inside the Actions tab as a separate card. `initTabs()` in `options.js` toggles `.active` and the `hidden` attribute on click. To add another tab: drop a `<button class="tab-btn" data-tab="X">` in the nav and a matching `<div class="tab-panel" data-tab="X" hidden>` in `<main>` — no JS change needed.

### Adding a new AI provider

1. Add provider ID to `VALID_PROVIDERS` in `lib/storage.js`
2. Add URL constant + `callXxx()` function in `lib/api-client.js`
3. Add branch in `callAI()` in `lib/api-client.js`
4. Add fallback model list to `getAvailableModels()` and default model to `DEFAULT_MODELS` in `lib/api-client.js`
5. Add a live-list branch in `fetchAvailableModels()` in `lib/api-client.js` (skip if the provider has no models endpoint — the static list then stays)
6. Add `<option>` to provider `<select>` in `modelConfigTemplate` in `options.html`
7. Add host permission in `manifest.json`

### Model lists (live + fallback)

The model combobox in options is fed from three layers, in order: the static fallback in `getAvailableModels()` (instant), the cached live list from `modelListCache` in `chrome.storage.local` (`getCachedModelList`/`setCachedModelList` in `lib/storage.js`, 24h TTL), and a background `fetchAvailableModels(provider, apiKey)` refetch when the cache is stale/missing — also re-triggered with a 600ms debounce after the API key changes (a new key may unlock the list). Fetch failures are silently swallowed; whatever list is showing stays. Per-provider notes: OpenAI's `/v1/models` is filtered to chat models (`OPENAI_CHAT_MODEL_RE`/`OPENAI_NON_CHAT_RE`); Gemini is filtered to `supportedGenerationMethods` containing `generateContent` and the `models/` prefix is stripped; OpenRouter's list is public (no key needed, ~300+ entries, hence the autocomplete combobox instead of a `<select>`); DeepL has none. `populateModelDatalist()` in `options.js` guards against out-of-order async updates with a per-datalist sequence counter. The model input re-validates against the datalist on every change, showing a non-blocking orange warning when the value is absent (retired model or typo). Static `DEFAULT_MODELS` rot over time — a prefill that is still auto-filled (never touched by the user, tracked via `modelAutoFilled`) and missing from a freshly loaded list is auto-replaced with the closest live ID (`closestModelId`: longest common prefix, ties broken by shared name tokens); saved/user-typed values are never rewritten, since retired models often keep working for existing keys.

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
