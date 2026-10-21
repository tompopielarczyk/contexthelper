# ContextHelper 1.1.0 core upgrades: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** five upgrades to the selection → AI → result loop:
- streaming responses;
- refining a result inside the tooltip;
- page-context placeholders;
- an ad-hoc "Ask about selection" command;
- a custom OpenAI-compatible provider (Ollama, LM Studio, vLLM).

**Architecture:**
- `lib/api-client.js` gains multi-turn `messages`, an `onDelta` streaming callback and a shared chat-completions caller. Task 2 adds the `custom` provider on top.
- `background.js` routes every AI run through one runner, `runChat`. The runner owns:
  - a session-unique request id;
  - aborting the previous run;
  - the service-worker keepalive;
  - throttled `AI_CHUNK` messages;
  - the final `AI_RESULT`, which carries the conversation.
- Refine and Ask are thin message handlers on top of `runChat`.
- Pure logic lives in two new modules covered by unit tests: `lib/chat.js` and `lib/prompt.js`.

**Tech stack:** Chrome MV3, vanilla JS (ES modules in background/options, IIFE content script), `node --test` (Node ≥ 20), no dependencies.

**Spec:** this plan is the spec.

**Product decisions:**
- Stream only when the result goes to a tooltip. Insert mode stays atomic and keeps the spinner.
- Refine is tooltip-only and never available for DeepL.
- Ask uses the first non-DeepL model config.
- `custom` allows plain `http` only for loopback and private-network hosts.

**Revision 2** folds in the Codex plan review:
- streaming is a foundation wave of its own;
- the tooltip options object;
- stream terminal and error semantics;
- the worker keepalive;
- body-stream abort ownership;
- custom-provider guards and permission protection;
- focus and Esc handling;
- the conversation contract.

## Execution layout (orchestrator)

**Integration branch:** `release/1.1.0` (from `main` `d47d7aa`). Each task runs in its own git worktree, branched from the current tip of `release/1.1.0`.

**Waves:**

| Wave | Tasks | Merge order into `release/1.1.0` |
|---|---|---|
| A | Task 1 (Streaming + runner + shared chat caller), alone. It is the foundation every other task builds on. | 1 |
| B | Task 2 (Custom provider), Task 3 (Page context), Task 4 (Refine), Task 5 (Ask), in parallel from the post-A tip | 2, 3, 4, 5. Each implementer rebases onto the new tip, re-runs `npm test` and reports semantic conflicts. |
| C | Task 6 (docs, privacy, version), by the orchestrator | n/a |

**Known Wave B hotspots:** the orchestrator owns integration and reads the merged result of each one.

| Area | Conflicting tasks |
|---|---|
| `lib/chat.js`, `tests/chat.test.js` | Tasks 4 and 5 (append-only, different functions) |
| `background.js` `onMessage` dispatch | Tasks 4 and 5 (one new `case` each) |
| `buildRequest` in `runAction` | Task 3 only; Task 4 and Task 5 build their own requests |
| `content.js` | Task 4 (`showResultTooltip` refine bar) and Task 5 (new `showAskInput` and a new case) |
| options permission helpers | Task 2 only |

**Per-task review:**
1. The implementer finishes with green `npm test`.
2. Codex (`codex exec -s read-only`) and GLM-5.3 (`opencode run -m ollama-cloud/glm-5.3 --agent plan`) review `git diff <base>..HEAD` in the worktree in parallel. The orchestrator reviews it too.
3. Fixes go back to the same implementer.
4. Rebase, `npm test`, then `git merge --no-ff`.
5. After Wave C, merge `release/1.1.0` into `main`. No push without the user's consent.

## Global constraints

- No new dependencies and no bundler. `content.js` stays an IIFE with no imports.
- Pure logic lives in `lib/*.js` and is unit tested. `background.js`, `content.js` and `options.js` are not importable by tests.
- Listeners are registered synchronously at the top level of `background.js`.
- Every user-visible UI string is English.
- `chrome.permissions.request` is called before any `await` inside the click handler.
- Never call `chrome.permissions.remove` on an origin that a manifest `host_permissions` pattern, a webhook or a custom model endpoint still needs (see the "Permission-subtraction pitfall" in CLAUDE.md).
- DeepL behaviour does not change: no streaming, no refine, raw selection only.
- Every CSS class in `getShadowStyles()` or `options.css` that sets `display:` needs a matching `[hidden] { display: none }` override (CLAUDE.md "[hidden] pitfall").
- No test-only exports in production code. Inject timing through parameters.
- Each task commits separately with a Conventional-Commit-style message ending in:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Tasks 1–5 do **not** edit `CLAUDE.md`, `PRIVACY.md`, `README.md` or the manifest `version`. Task 6 handles those.

## Review focus

1. **A stream dies mid-way.** Cases:
   - an Anthropic `event: error`;
   - an OpenRouter HTTP-200 chunk with a top-level `error` or `finish_reason: "error"`;
   - EOF without a terminal event after partial text;
   - malformed JSON;
   - an idle stall.

   Expected: an error tooltip, never a "successful" partial result. Covered by Task 1 stream tests.
2. **SSE framing split across reads.** Cases:
   - a half line;
   - `\r\n`;
   - a multibyte UTF-8 character split across chunks;
   - comment lines (`: OPENROUTER PROCESSING`);
   - the `[DONE]` sentinel.

   Covered by Task 1 parser and stream tests.
3. **The selection contains `{{context}}`, `$&` or `$1`.** Expected: inserted literally, with no second expansion. This also fixes the current `replaceAll` `$`-pattern bug. Covered by Task 3 renderer tests.
4. **`custom` base URL variants.** Cases:
   - trailing `/`;
   - an appended `/chat/completions`;
   - public `http`;
   - an empty API key.

   Covered by Task 2 tests.
5. **The user dismisses the spinner or the tooltip mid-run, then runs another action.** Expected: late chunks or results from the cancelled run never re-open UI. Covered by Task 1 (session-unique ids, `CANCEL_ACTION`, spinner Esc) and manual check M3.

---

### Task 1 (Wave A): streaming, the shared chat caller and the `runChat` runner

**Files:**
- Modify: `lib/api-client.js`:
  - `callAI` accepts `messages`, `onDelta` and `streamTimeouts`;
  - extract `callChatCompletions`;
  - streaming for anthropic, openai, openrouter and google;
  - SSE parser, stream event parser and stream reader;
  - fix `getDefaultModel` for providers whose default is `''`.
- Create: `lib/chat.js`
- Modify: `background.js`:
  - add `runChat`;
  - `runAction` delegates to it;
  - keepalive;
  - `AI_CHUNK` throttle;
  - `CANCEL_ACTION`;
  - richer `AI_RESULT`;
  - session-unique request ids.
- Modify: `content.js`:
  - streaming tooltip;
  - `showResultTooltip` options object;
  - cancel on dismiss, including the spinner;
  - styles.
- Test: `tests/api-client.test.js`, create `tests/chat.test.js`

**Interfaces (produced; later tasks rely on these exact names):**

- **`callAI({ provider, apiKey, model, baseUrl, prompt, messages, systemPrompt, targetLang, signal, onDelta, streamTimeouts }): Promise<string>`**
  - `messages: Array<{ role: 'user' | 'assistant', content: string }>` takes precedence over `prompt`. Without it, the conversation is `[{ role: 'user', content: prompt }]`.
  - Gemini maps `assistant` → `model`.
  - DeepL ignores `messages` history and translates `prompt` (unchanged behaviour).
  - `onDelta(fullTextSoFar: string)`: when given (and provider ≠ deepl) the request streams. Otherwise the request is byte-identical to today's (no `stream` field).
  - `streamTimeouts = { idleMs = 30_000, totalMs = 240_000 }`. Tests pass small values.
  - `baseUrl` is accepted and passed through (used by Task 2).
- **`callChatCompletions({ url, headers, model, messages, systemPrompt, maxTokensField, providerName, signal, onDelta, streamTimeouts }): Promise<string>`** (exported)
  - `callOpenAI` and `callOpenRouter` delegate to it. `maxTokensField` is `'max_completion_tokens'` for OpenAI and `'max_tokens'` otherwise.
  - Task 2's `callCustom` delegates to it too.
- **`createSSEParser(onData: (data: string, event: string | null) => void): { push(text: string): void, end(): void }`** (exported)
  - buffers partial lines;
  - accepts `\n` and `\r\n`;
  - ignores `:` comments and `data: [DONE]`;
  - joins multi-line `data:` with `\n`;
  - dispatches on a blank line;
  - `end()` flushes a pending event.
- **`parseStreamEvent(provider: string, payload: object): { delta: string, done: boolean, error: string | null }`** (exported)
  - anthropic:
    - `content_block_delta` + `text_delta` → `delta`;
    - `message_stop` → `done`;
    - `type: 'error'` → `error = payload.error?.message || 'Stream error'`.
  - openai / openrouter / custom:
    - `delta = choices[0].delta.content || ''`;
    - a top-level `payload.error` → `error = payload.error.message || 'Stream error'`;
    - `finish_reason === 'error'` → `error`;
    - any other non-null `finish_reason` → `done`.
  - google:
    - `delta` = joined `candidates[0].content.parts[].text`;
    - `candidates[0].finishReason` present → `done`;
    - `promptFeedback.blockReason` → `error = 'Blocked (<reason>)'`.
- **Internal `readStream(response, { provider, providerName, signal, onDelta, idleMs, totalMs }): Promise<string>`**
  - attaches its **own** abort listener to the external `signal`, because `fetchWithErrorHandling` removes its listener once headers arrive;
  - decodes with `TextDecoder` (`stream: true`);
  - parses JSON per data event (a parse failure → `APIError(0, '<providerName> sent malformed stream data')`);
  - calls `onDelta` with the accumulated text;
  - on stall → `APIError(0, 'API stream stalled')`;
  - when over `totalMs` → `APIError(0, 'API response took too long')`;
  - external abort → `DOMException('Request cancelled', 'AbortError')`;
  - EOF without `done` → `APIError(0, '<providerName> stream ended unexpectedly')`, even after partial text;
  - `done` with empty text → the existing "returned an empty response" messages;
  - always releases the reader, timers and listener.
- **`getDefaultModel(provider)`** returns `DEFAULT_MODELS[provider]` when the key exists (including `''`). Only unknown providers fall back to anthropic.
- **`lib/chat.js` exports:**
  - `shouldStream({ provider, displayMode, editable }): boolean`: `provider !== 'deepl'` and (`displayMode === 'tooltip'` or (`displayMode === 'auto'` and `!editable`));
  - `pickLLMConfig(configs, configId?)`: the config with `configId` if found; otherwise the first config whose `provider !== 'deepl'`; otherwise `null`;
  - `ASK_ACTION_ID = '__ask__'`;
  - `createThrottle(fn, ms)`: trailing-edge, `{ call(arg), flush(), cancel() }`.
- **`background.js`:**
  - **Request ids** come from `crypto.randomUUID()`, so content-side comparisons survive a worker restart. `_abortControllersByTab: Map<tabId, { controller, requestId }>`.
  - **`runChat(tab, settings, buildRequest)`**, where `buildRequest: () => Promise<ChatRequest>` and `ChatRequest = { config, messages, prompt, systemPrompt, targetLang, displayMode, editable, meta: { actionId, actionName, sourceText } }`. The runner:
    1. aborts the previous run for the tab;
    2. `ensureContentScript`, then `AI_PROCESSING_START`;
    3. awaits `buildRequest()` (its throws → `AI_ERROR`);
    4. checks `signal.aborted` after **every** await;
    5. starts the keepalive (`setInterval(() => chrome.runtime.getPlatformInfo(), 20_000)`, cleared in `finally`);
    6. calls `callAI` with `onDelta` only when `shouldStream(...)`;
    7. on completion → flushes and cancels the throttle, then sends `AI_RESULT`;
    8. on error → cancels the throttle; if aborted, returns silently; otherwise sends `AI_ERROR`.
  - **`runAction`** builds its `ChatRequest` (existing validation and `replaceAll` prompt for now; Task 3 swaps the renderer) and calls `runChat`.
- **Messages:**
  - `AI_CHUNK { requestId, text, tooltipSettings }`: accumulated text, throttle 100 ms.
  - `AI_RESULT` adds:
    - `actionId`;
    - `sourceText`;
    - `conversation`: `[...messages, { role: 'assistant', content: result }]`, or `null` when the provider is DeepL.
  - `CANCEL_ACTION { requestId }` (content → background) aborts only if the tab's stored `requestId` matches.
- **`content.js`:**
  - **`showResultTooltip(text, ts, opts = {})`** with `opts = { sendContext?, position?: { top, left }, refine?: { actionId, conversation, sourceText } }`. Task 1 passes `refine` through but does not render it; Task 4 renders it.
  - In the `AI_RESULT` case, **read the streaming tooltip's top/left before the unconditional `hideOverlay()`**. Then pass `position` for both the `tooltip` and the `auto` → tooltip paths.
  - **`showStreamingTooltip(text, ts)`** creates the tooltip once and updates its text afterwards:
    - class `cmn-overlay cmn-tooltip cmn-streaming`;
    - `textContent` rendering;
    - a close button;
    - a CSS caret;
    - auto-scroll only within 24 px of the bottom.
  - **Dismissal** (Esc, close or outside click) of the streaming tooltip **and of the spinner**:
    1. sends `CANCEL_ACTION { requestId: activeRequestId }`;
    2. sets `activeRequestId = null`;
    3. `hideOverlay()`.

    The spinner (`showLoading`) gains an Esc handler.

- [ ] **Step 1: failing parser and event tests** (`tests/api-client.test.js`):

```js
test('SSE parser buffers split lines, CRLF, comments, DONE', () => {
  const got = [];
  const p = createSSEParser((d, e) => got.push([e, d]));
  p.push(': OPENROUTER PROCESSING\r\n\r\nevent: content_block_delta\r\ndata: {"a"');
  p.push(':1}\r\n\r\ndata: [DONE]\n\n');
  p.end();
  assert.deepEqual(got, [['content_block_delta', '{"a":1}']]);
});
test('SSE parser joins multi-line data', () => {
  const got = [];
  const p = createSSEParser(d => got.push(d));
  p.push('data: x\ndata: y\n\n'); p.end();
  assert.deepEqual(got, ['x\ny']);
});
test('parseStreamEvent per provider', () => {
  assert.deepEqual(parseStreamEvent('anthropic', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }), { delta: 'Hi', done: false, error: null });
  assert.equal(parseStreamEvent('anthropic', { type: 'message_stop' }).done, true);
  assert.equal(parseStreamEvent('anthropic', { type: 'error', error: { message: 'Overloaded' } }).error, 'Overloaded');
  assert.equal(parseStreamEvent('openai', { choices: [{ delta: { content: 'a' } }] }).delta, 'a');
  assert.equal(parseStreamEvent('openrouter', { choices: [{ delta: {}, finish_reason: 'stop' }] }).done, true);
  assert.equal(parseStreamEvent('openrouter', { error: { message: 'upstream died' }, choices: [{ delta: {}, finish_reason: 'error' }] }).error, 'upstream died');
  assert.equal(parseStreamEvent('google', { candidates: [{ content: { parts: [{ text: 'g' }, { text: 'h' }] } }] }).delta, 'gh');
  assert.equal(parseStreamEvent('google', { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }).done, true);
});
test('getDefaultModel keeps empty defaults', () => {
  assert.equal(getDefaultModel('deepl'), '');
  assert.equal(getDefaultModel('nope'), getDefaultModel('anthropic'));
});
```

- [ ] **Step 2: failing stream tests.** Stub `globalThis.fetch` per test (restore in `t.after`) with `new Response(new ReadableStream({...}), { status: 200 })` built from encoded string chunks:
  - `anthropic stream resolves full text`. `onDelta` calls equal `['He', 'Hello']` and it resolves `'Hello'`. Events: `content_block_delta` ×2, then `message_stop`.
  - `split UTF-8 across chunks`. Bytes of `'zażółć'` split mid-character across two chunks; it resolves `'zażółć'`.
  - `openrouter error after deltas rejects`. A delta, then `{"error":{"message":"upstream died"},"choices":[{"delta":{},"finish_reason":"error"}]}`; it rejects matching `/upstream died/`.
  - `EOF after partial text rejects`. A delta with no terminal event; it rejects matching `/ended unexpectedly/`.
  - `malformed JSON rejects`. `data: {oops`; it rejects matching `/malformed/`.
  - `idle stall rejects`. A body that never enqueues, `streamTimeouts: { idleMs: 20, totalMs: 1000 }`; it rejects matching `/stalled/`.
  - `external abort rejects with AbortError`. Abort the controller after the first delta; the rejection has `name === 'AbortError'`.
  - `non-streaming request unchanged`. Without `onDelta` the parsed request body has no `stream` key.
  - `multi-turn messages`:
    - openai body `messages` equals `[{role:'system',...}, user, assistant, user]`;
    - google body `contents.map(c => c.role)` equals `['user', 'model', 'user']`;
    - anthropic body `messages` length 3 and `system` set.
- [ ] **Step 3: failing `tests/chat.test.js`:**
  - `shouldStream` truth table:
    - deepl/tooltip → false;
    - anthropic/tooltip → true;
    - auto + editable → false;
    - auto + !editable → true;
    - insert → false.
  - `pickLLMConfig`:
    - by id;
    - an unknown id falls back to the first non-DeepL;
    - DeepL-only → `null`;
    - empty → `null`.
  - `createThrottle` with `t.mock.timers.enable({ apis: ['setTimeout'] })`:
    - 3 calls within 100 ms → fn called once with the last arg after a tick of 100;
    - `flush()` calls immediately with the pending arg;
    - `cancel()` drops it.
- [ ] **Step 4: run.** `npm test`. Expected: the new tests FAIL.
- [ ] **Step 5: implement the api-client parts.** Gemini streaming URL: `${GEMINI_BASE_URL}/${model}:streamGenerateContent?alt=sse`. A non-OK HTTP response keeps the existing JSON error path.
- [ ] **Step 6: run.** `npm test`. Expected: the api-client tests pass.
- [ ] **Step 7: implement `lib/chat.js`, `runChat`, keepalive, throttle, `CANCEL_ACTION` and the content-side streaming/cancel/options object.** The menu, shortcut and floating-button paths still go through `runAction`.
- [ ] **Step 8: run.** `npm test`. Expected: all pass. Then `node --check background.js content.js options.js`, which must print nothing.
- [ ] **Step 9: commit**, in two commits:
  - `feat(api): stream provider responses and accept multi-turn messages`
  - `feat: stream tooltip results through a shared runChat runner`

---

### Task 2 (Wave B): custom OpenAI-compatible provider

**Files:**
- Modify: `lib/api-client.js`:
  - `normalizeBaseUrl`, `isPrivateHost`;
  - `callCustom` (via `callChatCompletions`);
  - `custom` branches in `callAI`, `fetchAvailableModels` and `getAvailableModels` (→ `[]`);
  - `DEFAULT_MODELS.custom = ''`;
  - 403 hint.
- Modify: `lib/storage.js`:
  - `custom` in `VALID_PROVIDERS`, `PROVIDER_DISPLAY_NAMES` (`'Custom (OpenAI-compatible)'`) and `PROVIDER_DEFAULT_MODELS` (`''`);
  - validation in `saveSettings`;
  - model configs gain `baseUrl`.
- Modify: `options.html`:
  - the provider option;
  - a `.model-config-baseurl` field plus a hint in `modelConfigTemplate`.
- Modify: `options.js`:
  - field visibility;
  - collect `baseUrl`;
  - model list;
  - Test button;
  - Save permissions;
  - permission-removal protection.
- Modify: `background.js`:
  - pass `baseUrl`;
  - skip the "Missing API key" check for `custom`;
  - protect custom origins in `handleFloatingToggle`.
- Test: `tests/api-client.test.js`, `tests/storage.test.js`

**Interfaces:**
- Consumes: Task 1 `callChatCompletions`, `callAI({ baseUrl })`.
- Produces:
  - **`normalizeBaseUrl(url: string): string`:**
    - trims;
    - strips trailing `/` and a trailing `/chat/completions`;
    - throws `Error('Invalid base URL')` for unparsable input or a non-http(s) protocol;
    - for `http:` to a non-private host, throws `Error('Base URL must use HTTPS unless it points to a local or private-network host')`.
  - **`isPrivateHost(hostname): boolean`:** `localhost`, `*.localhost`, `*.local`, `127.0.0.0/8`, `::1` (URL hostname `[::1]`), `10/8`, `172.16/12`, `192.168/16`.
  - **`callAI` for `provider: 'custom'`:**
    - POSTs to `${normalizeBaseUrl(baseUrl)}/chat/completions`;
    - sends `Authorization: Bearer` only when `apiKey` is non-empty;
    - `providerName: 'Custom endpoint'`;
    - an HTTP 403 → `APIError(403, 'Endpoint refused the request (403). For Ollama, set OLLAMA_ORIGINS=chrome-extension://* and restart it.')`. `APIError.getUserMessage` default passes the message through.
  - **`fetchAvailableModels('custom', apiKey, signal, baseUrl)`** → `GET ${base}/models` → `data[].id`.
  - **Model config shape:** `{ id, name, provider, model, apiKey, baseUrl? }`. `baseUrl` is stored only for `custom`.
  - **Exported pure helper `customOrigins(configs): string[]`** in `lib/storage.js`. Returns the `new URL(normalizeBaseUrl(c.baseUrl)).origin + '/*'` of each valid custom config, deduped. Used by options and background.

- [ ] **Step 1: failing tests** (`tests/api-client.test.js`):

```js
test('normalizeBaseUrl strips trailing slash and /chat/completions', () => {
  assert.equal(normalizeBaseUrl(' http://localhost:11434/v1/ '), 'http://localhost:11434/v1');
  assert.equal(normalizeBaseUrl('https://x.example.com/v1/chat/completions'), 'https://x.example.com/v1');
});
test('normalizeBaseUrl allows http only for local/private hosts', () => {
  for (const ok of ['http://127.0.0.1:1234/v1', 'http://192.168.1.5/v1', 'http://10.0.0.2/v1', 'http://172.20.0.1/v1', 'http://nas.local/v1', 'http://[::1]:8080/v1', 'http://app.localhost/v1'])
    assert.doesNotThrow(() => normalizeBaseUrl(ok), ok);
  assert.throws(() => normalizeBaseUrl('http://api.example.com/v1'), /HTTPS/);
  assert.throws(() => normalizeBaseUrl('http://172.32.0.1/v1'), /HTTPS/);
  assert.throws(() => normalizeBaseUrl('ftp://localhost/v1'), /Invalid base URL/);
  assert.throws(() => normalizeBaseUrl('not a url'), /Invalid base URL/);
});
test('custom provider: no auth header without key, defaults', async (t) => { /* stub fetch, assert URL === 'http://localhost:11434/v1/chat/completions' and no Authorization header; getAvailableModels('custom') deepEquals []; getDefaultModel('custom') === '' */ });
```

  `tests/storage.test.js` (existing mock pattern):
  - `custom without apiKey saves`;
  - `custom without baseUrl` rejects, matching `/base URL/i`;
  - `custom with public http` rejects, matching `/HTTPS/`;
  - `custom without model` rejects, matching `/must have a model/`;
  - `openai still requires apiKey`;
  - `customOrigins dedupes and skips invalid`.
- [ ] **Step 2: run.** `npm test`. Expected: FAIL.
- [ ] **Step 3: implement the api-client and storage parts.**
  - The `saveSettings` custom error format is `Model configuration "<name>": <normalizeBaseUrl message>`.
  - `storage.js` imports from `./api-client.js`. There is no cycle.
- [ ] **Step 4: run.** `npm test`. Expected: pass.
- [ ] **Step 5: options UI.**
  - `syncProviderFields` shows `.model-config-baseurl` only for `custom`. Placeholder `http://localhost:11434/v1`. Hint: `Ollama: http://localhost:11434/v1, LM Studio: http://localhost:1234/v1. Ollama may need OLLAMA_ORIGINS=chrome-extension://*`.
  - Model datalist for custom:
    - fetch via `fetchAvailableModels('custom', key, signal, baseUrl)`;
    - cache key `custom:<normalized baseUrl>`;
    - refetch on base-URL `input` (600 ms debounce);
    - skip while the base URL is invalid.
  - Test button for custom:
    - no empty-key guard;
    - `chrome.permissions.request({ origins: [origin + '/*'] })` before any await (on refusal show `Permission for <origin> denied`);
    - pass `baseUrl`.
  - `onSave`:
    - rename `requestWebhookPermissions` → `requestOriginPermissions(urls)`, called with webhook URLs **plus** the custom origins (one prompt, before any await);
    - add the custom origins to the post-all-sites re-request list;
    - warning `custom endpoint permission not granted`.
  - `removeFloatingDomain` (options) and `handleFloatingToggle` (background) skip `permissions.remove` when a custom config's origin host equals the domain.
- [ ] **Step 6: run.** `npm test` and `node --check options.js background.js`. Expected: pass.
- [ ] **Step 7: commit.** `feat: add custom OpenAI-compatible provider (Ollama, LM Studio, vLLM)`

---

### Task 3 (Wave B): page-context placeholders `{{context}}`, `{{pageTitle}}`, `{{pageUrl}}`

**Files:**
- Create: `lib/prompt.js`
- Modify: `background.js`:
  - `runAction`'s `buildRequest` renders via `renderActionPrompt`;
  - add `getPageContext(tabId)`, called only when `templateUsesPageContext`.
- Modify: `options.html`. Action hint: `Placeholders: {{text}} (required), {{context}} (surrounding paragraph), {{pageTitle}}, {{pageUrl}}`.
- Test: create `tests/prompt.test.js`

**Interfaces:**
- Consumes: Task 1 `runChat` / `ChatRequest`.
- Produces (`lib/prompt.js`):
  - `ACTION_PLACEHOLDERS = ['text', 'context', 'pageTitle', 'pageUrl']`;
  - `renderActionPrompt(template, vars): string`. One pass with `/\{\{(text|context|pageTitle|pageUrl)\}\}/g` and a function replacer. Missing vars → `''`. Unknown `{{x}}` stays. Values are never re-scanned.
  - `templateUsesPageContext(template): boolean`;
  - `windowAround(text, start, end, max = 2000): string`:
    - `text` unchanged if `length <= max`;
    - if the selection alone exceeds `max`, `text.slice(start, end)`;
    - otherwise a window of ≤ `max` chars containing `[start, end)`, centred, with `…` on each cut side.
- `getPageContext(tabId) → { context, pageTitle, pageUrl }`. The injected func is self-contained and returns `{ blockText, start, end, title, url }`:
  - **Text control** (`document.activeElement` is a textarea or input with a non-empty selection): `blockText = el.value`, with `selectionStart`/`selectionEnd`.
  - **Otherwise:**
    - `range = getSelection().getRangeAt(0)`;
    - collapsed or no range → `blockText = ''`;
    - block = the closest element ancestor of `range.commonAncestorContainer` matching `p,li,td,th,blockquote,pre,dd,article,section,div`, else `document.body`;
    - offsets come from a prefix range: `pre.selectNodeContents(block); pre.setEnd(range.startContainer, range.startOffset); start = pre.toString().length; end = start + range.toString().length`;
    - `blockText = block.textContent`. This is exact for repeated text.
  - The background applies `windowAround`.
  - On restricted pages or a throw, `context = ''` and title/url fall back to `tab.title`/`tab.url`.
- DeepL actions keep the raw selection and skip rendering.

- [ ] **Step 1: failing tests** (`tests/prompt.test.js`):

```js
test('renders all placeholders in one pass, literal values', () => {
  const out = renderActionPrompt('A {{text}} B {{context}} C {{pageTitle}} {{pageUrl}} {{n8n}}',
    { text: '$& {{context}}', context: 'ctx $1', pageTitle: 'T', pageUrl: 'https://u' });
  assert.equal(out, 'A $& {{context}} B ctx $1 C T https://u {{n8n}}');
});
test('repeated {{text}} replaced everywhere; missing vars empty', () => {
  assert.equal(renderActionPrompt('{{text}}/{{text}}/{{context}}', { text: 'x' }), 'x/x/');
});
test('templateUsesPageContext', () => {
  assert.equal(templateUsesPageContext('{{text}}'), false);
  assert.equal(templateUsesPageContext('{{text}} {{pageUrl}}'), true);
});
test('windowAround keeps selection, marks cuts, respects max', () => {
  const text = 'a'.repeat(5000) + 'SEL' + 'b'.repeat(5000);
  const out = windowAround(text, 5000, 5003, 100);
  assert.ok(out.includes('SEL'));
  assert.ok(out.startsWith('…') && out.endsWith('…'));
  assert.ok(out.length <= 102);
  assert.equal(windowAround('short', 0, 5, 100), 'short');
  assert.equal(windowAround('x'.repeat(300), 0, 300, 100), 'x'.repeat(300));
  assert.ok(windowAround('S' + 'b'.repeat(500), 0, 1, 100).startsWith('S'));
});
```

- [ ] **Step 2: run.** `npm test`. Expected: FAIL (module missing).
- [ ] **Step 3: implement `lib/prompt.js`, `getPageContext` and the `buildRequest` change.**
- [ ] **Step 4: run.** `npm test` and `node --check background.js`. Expected: pass.
- [ ] **Step 5: commit.** `feat: add {{context}}, {{pageTitle}}, {{pageUrl}} action placeholders`

---

### Task 4 (Wave B): refine the result in the tooltip

**Files:**
- Modify: `lib/chat.js`. Add `REFINE_PRESETS`, `MAX_CONVERSATION_MESSAGES`, `buildRefineMessages`, `sanitizeConversation`.
- Modify: `background.js`. Add a `REFINE_ACTION` case and `handleRefine`.
- Modify: `content.js`:
  - render `opts.refine` in `showResultTooltip`;
  - styles.
  - The `AI_RESULT` case passes `refine: { actionId, conversation, sourceText }` when `message.conversation` is non-null.
- Test: `tests/chat.test.js`

**Interfaces:**
- Consumes: Task 1 `runChat`, `pickLLMConfig`, `ASK_ACTION_ID`, the `showResultTooltip` `opts.refine` slot, and the `AI_RESULT.conversation/actionId/sourceText` fields.
- Produces:
  - `REFINE_PRESETS = { shorter: 'Make it shorter. Return only the revised text.', longer: 'Expand it with more detail. Return only the revised text.', simpler: 'Rewrite it in simpler language. Return only the revised text.' }`.
  - `MAX_CONVERSATION_MESSAGES = 20`.
  - `sanitizeConversation(value): Array | null`. Valid means:
    - a non-empty array of `{ role, content }`;
    - `role ∈ {user, assistant}`;
    - `content` a string of ≤ 100 000 chars;
    - starts with `user`, strictly alternates, ends with `assistant` (so the length is even).

    Anything else → `null`. If the length exceeds `MAX_CONVERSATION_MESSAGES`, keep the first 2 messages plus the last 18. Pairs keep the alternation.
  - `buildRefineMessages(conversation, instruction: string | null)`:
    - `null` (Retry) → the conversation without its trailing assistant message;
    - otherwise → the conversation plus `{ role: 'user', content: instruction.trim() }`.
  - Message `REFINE_ACTION { actionId, conversation, instruction, sourceText }` goes content → background → `runChat(tab, settings, buildRequest)`. `buildRequest` throws (so `AI_ERROR` goes through the START gating) in these cases:

    | Condition | Error |
    |---|---|
    | `sanitizeConversation` → null | `'This result can no longer be refined'` |
    | the action is missing (unless `ASK_ACTION_ID`) | `'Action no longer exists'` |
    | no LLM config | `'No LLM model configured'` |
    | the resolved config is DeepL | `'Refine is not available for DeepL'` |

    Config resolution: `ASK_ACTION_ID` → `pickLLMConfig(configs)`, otherwise `pickLLMConfig(configs, action.modelConfigId)`.

    The request uses `displayMode: 'tooltip'`, `messages: buildRefineMessages(...)` and the settings' `systemPrompt`, plus `meta: { actionId, actionName: action?.name || 'Ask', sourceText }`.
- **UI:** a row under the content holds buttons `Shorter`, `Longer`, `Simpler`, `↻ Retry` and an input with placeholder `Follow up…`.
  - Enter submits, except when `e.isComposing`. An empty input is ignored.
  - The input's `keydown`/`keyup`/`keypress` call `stopPropagation()`. The input handles Esc itself (`hideOverlay()`), because the document-level Esc handler no longer sees it.
  - The refine bar is not rendered when `opts.refine` is absent (DeepL and insert paths).

- [ ] **Step 1: failing tests:**

```js
const conv = [{ role: 'user', content: 'P' }, { role: 'assistant', content: 'R' }];
test('buildRefineMessages appends instruction / drops last answer on retry', () => {
  assert.deepEqual(buildRefineMessages(conv, ' Shorter '), [...conv, { role: 'user', content: 'Shorter' }]);
  assert.deepEqual(buildRefineMessages(conv, null), [{ role: 'user', content: 'P' }]);
});
test('sanitizeConversation rejects malformed input', () => {
  assert.equal(sanitizeConversation(null), null);
  assert.equal(sanitizeConversation([]), null);
  assert.equal(sanitizeConversation([{ role: 'assistant', content: 'x' }]), null);
  assert.equal(sanitizeConversation([{ role: 'user', content: 'x' }]), null); // must end with assistant
  assert.equal(sanitizeConversation([{ role: 'user', content: 1 }, { role: 'assistant', content: 'r' }]), null);
  assert.equal(sanitizeConversation([{ role: 'system', content: 'x' }, { role: 'assistant', content: 'r' }]), null);
  assert.deepEqual(sanitizeConversation(conv), conv);
});
test('sanitizeConversation trims to first pair + last 18', () => {
  const long = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) }));
  const out = sanitizeConversation(long);
  assert.equal(out.length, 20);
  assert.deepEqual(out.slice(0, 3).map(m => m.content), ['0', '1', '22']);
  out.forEach((m, i) => i && assert.notEqual(m.role, out[i - 1].role));
});
```

- [ ] **Step 2: run.** `npm test`. Expected: FAIL.
- [ ] **Step 3: implement the helpers, `handleRefine` and the refine bar.**
- [ ] **Step 4: run.** `npm test` and `node --check background.js content.js`. Expected: pass.
- [ ] **Step 5: commit.** `feat: refine results in the tooltip (shorter, longer, simpler, retry, follow-up)`

---

### Task 5 (Wave B): "Ask about selection…"

**Files:**
- Modify: `lib/chat.js`. Add `buildAskPrompt`.
- Modify: `background.js`:
  - the context menu always has the parent and the Ask item (`contexthelper-ask`, "Ask about selection…", contexts `['selection']`), even with zero actions; restructure the early return in `rebuildContextMenuNow`;
  - an `ask-selection` command branch in `handleCommand` before `COMMAND_SLOT_RE`;
  - `ASK_PROMPT` → content;
  - a `RUN_ASK` handler.
- Modify: `manifest.json`. Add `"ask-selection": { "description": "Ask a question about the selected text" }` with no `suggested_key`.
- Modify: `content.js`:
  - an `ASK_PROMPT` case;
  - `showAskInput(selectionText, ts)`;
  - styles.
- Test: `tests/chat.test.js`

**Interfaces:**
- Consumes: Task 1 `runChat`, `pickLLMConfig`, `ASK_ACTION_ID`; existing `getSelectionFromTab`, `showTabNotice`, `ensureContentScript`.
- Produces:
  - **`buildAskPrompt(question, text)`** returns `` `${question.trim()}\n\nSelected text:\n"""\n${text}\n"""` ``.
  - **`ASK_PROMPT { selectionText, tooltipSettings }`** (background → content). Flow:
    - **Menu path:** the selection comes from `info.selectionText`.
    - **Command path:** `getSelectionFromTab`. An empty selection → `showTabNotice('Select some text first')`.
    - **No LLM config:** `showTabNotice(tabId, 'Ask needs an LLM model — add one in the extension settings (DeepL cannot answer questions)', settings)`.
  - **`RUN_ASK { question, selectionText }`** (content → background). It is ignored when the question or selection is blank. Otherwise it calls `runChat` with this request:
    - `messages: [{ role: 'user', content: buildAskPrompt(...) }]`;
    - `displayMode: 'tooltip'`;
    - `editable: false`;
    - `meta: { actionId: ASK_ACTION_ID, actionName: 'Ask', sourceText }`;
    - `systemPrompt` from settings.
  - **`showAskInput`:**
    - stores `selectionText` and the anchor rect **before** focusing anything;
    - is an overlay at `lastSelectionRect`;
    - holds a single-line input (placeholder `Ask about the selection…`, `autofocus` via `input.focus()` after append) and an `Ask` button;
    - Enter submits (not while `isComposing`);
    - Esc is handled on the input (`hideOverlay()`);
    - the input's key events call `stopPropagation()`;
    - an outside mousedown closes it (same delayed pattern as the result tooltip);
    - on submit: `hideOverlay()`, then `sendMessage RUN_ASK`.
  - The result is refinable through Task 4 automatically (`conversation` + `ASK_ACTION_ID`).

- [ ] **Step 1: failing test:**

```js
test('buildAskPrompt', () => {
  assert.equal(buildAskPrompt('  Why? ', 'abc'), 'Why?\n\nSelected text:\n"""\nabc\n"""');
});
```

- [ ] **Step 2: run.** `npm test`. Expected: FAIL.
- [ ] **Step 3: implement** the helper, menu, command, handlers and input.
- [ ] **Step 4: run.** `npm test`, `node --check background.js content.js`, and `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"`. Expected: pass.
- [ ] **Step 5: commit.** `feat: add "Ask about selection" ad-hoc prompt`

---

### Task 6 (Wave C, orchestrator): docs, privacy, version, manual checks

**Files:** `CLAUDE.md`, `PRIVACY.md`, `README.md`, `manifest.json` (`version` → `1.1.0`)

- [ ] **Step 1: update `CLAUDE.md`.**
  - Message protocol: add `AI_CHUNK`, `CANCEL_ACTION`, `REFINE_ACTION`, `ASK_PROMPT`, `RUN_ASK`, and the new `AI_RESULT` fields.
  - `runChat`:
    - streaming rules (tooltip-only, insert atomic, idle/total timeouts, terminal-event requirement);
    - keepalive;
    - session-unique ids.
  - The `custom` provider:
    - in "Adding a new AI provider" and "Model lists";
    - in the permission-subtraction protections.
  - Template syntax: the new placeholders and the single-pass renderer.
  - Architecture tree: `lib/chat.js`, `lib/prompt.js`.
- [ ] **Step 2: update `PRIVACY.md`.**
  - Page data is sent only when the template uses it.
  - The custom endpoint receives the prompts.
- [ ] **Step 3: README feature list. Bump `manifest.json` to `1.1.0`.**
- [ ] **Step 4: `npm test` green. Commit** `docs: document 1.1.0 features and bump version`.
- [ ] **Step 5: manual checks for the user** (no browser in the agent environment; run with DevTools **closed**, since an open inspector keeps the worker alive):
  - **M1:** streaming for Anthropic, OpenAI, Gemini and OpenRouter, plus a slow reasoning model (>30 s to first token).
  - **M2:** an insert-mode action in a textarea still replaces the text atomically.
  - **M3:** Esc on the spinner, and Esc mid-stream, then another action. No stale tooltip.
  - **M4:** Shorter / Retry / Follow up. Typing in the follow-up input on a page with global hotkeys (e.g. GitHub, Gmail) does not trigger them.
  - **M5:** `{{context}}` on an article paragraph, inside a textarea, and with the same word repeated in a paragraph.
  - **M6:** Ask via the menu, via the `ask-selection` shortcut (assigned in `chrome://extensions/shortcuts`), and with zero actions configured.
  - **M7:** Ollama `http://localhost:11434/v1`: permission prompt, Test, streaming, and the 403 hint without `OLLAMA_ORIGINS`.
  - **M8:** a DeepL action shows no refine bar and no streaming.
- [ ] **Step 6: merge `release/1.1.0` into `main`** (`--no-ff`). Do not push without the user's consent.
