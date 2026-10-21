# ContextHelper 1.1.0 core upgrades: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** five upgrades to the selection → AI → result loop:
- streaming responses;
- refining a result inside the tooltip;
- page-context placeholders;
- an ad-hoc "Ask about selection" command;
- a custom OpenAI-compatible provider (Ollama, LM Studio, vLLM).

**Architecture:**
- `lib/api-client.js` gains:
  - multi-turn `messages`;
  - an `onDelta` streaming callback;
  - a `custom` provider with a user-supplied `baseUrl`.
- `background.js` routes every AI run through one runner, `runChat`. The runner owns:
  - the request id;
  - aborting the previous run;
  - streaming `AI_CHUNK` messages;
  - the final `AI_RESULT`, which now carries the conversation.
- Refine and Ask are thin message handlers on top of `runChat`.
- New pure modules hold the logic that unit tests cover:
  - `lib/chat.js`: run, refine and ask helpers;
  - `lib/prompt.js`: template rendering and page context.

**Tech stack:** Chrome MV3, vanilla JS (ES modules in background/options, IIFE content script), `node --test`, no dependencies.

**Spec:** this plan is the spec. The product decisions behind it are in the conversation summary below.

**Decisions:**
- Stream only when the result goes to a tooltip.
- Insert mode stays atomic and keeps the spinner.
- Refine is tooltip-only.
- Ask uses the first non-DeepL model config.
- `custom` allows plain `http` only for loopback and private-network hosts.

## Execution layout (orchestrator)

**Integration branch:** `release/1.1.0` (from `main` `d47d7aa`). Each task runs in its own git worktree, branched from the current tip of `release/1.1.0`.

**Waves:**

| Wave | Tasks (in parallel) | Merge order into `release/1.1.0` |
|---|---|---|
| A | Task 1 (Custom provider), Task 2 (Streaming + runner) | 1 then 2 (Task 2 rebases on 1) |
| B | Task 3 (Page context), Task 4 (Refine), Task 5 (Ask) | 3, 4, 5 (each rebases on the previous) |
| C | Task 6 (docs, privacy, version), done by the orchestrator | n/a |

**Per-task review:**
1. The implementer finishes with green `npm test`.
2. Codex (`codex exec -s read-only`) and GLM-5.3 (`opencode run -m ollama-cloud/glm-5.3 --agent plan`) review the branch diff in parallel. The orchestrator reviews it too.
3. Fixes go back to the same implementer.
4. Rebase, re-run `npm test`, then `git merge --no-ff`.
5. After Wave C, merge `release/1.1.0` into `main`.

## Global constraints

- No new dependencies and no bundler. `content.js` stays an IIFE with no imports.
- Pure logic lives in `lib/*.js` and is unit tested. `background.js`, `content.js` and `options.js` are not importable by tests (they use chrome APIs at top level).
- Listeners are registered synchronously at the top level of `background.js`. This includes the new `onMessage` cases.
- Every user-visible string in the extension UI is English, matching the existing UI.
- `chrome.permissions.request` is called before any `await` inside the click handler.
- Never call `chrome.permissions.remove` on a pattern that covers manifest `host_permissions` (see the "Permission-subtraction pitfall" in CLAUDE.md).
- DeepL behaviour does not change:
  - no streaming;
  - no refine;
  - no placeholders beyond the raw selection.
- Each task commits separately with a Conventional-Commit-style message ending in:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Tasks 1–5 do **not** edit `CLAUDE.md`, `PRIVACY.md`, `README.md` or the manifest `version`. Task 6 handles those, to avoid merge conflicts.

## Review focus

1. **A stream dies mid-way** (Anthropic `event: error`, network drop, idle stall). Expected: an error tooltip, never a frozen partial tooltip. Covered by Task 2 parser/stream tests (`error event throws`, `idle timeout`).
2. **SSE framing split across network reads** (a line cut in half, `\r\n`, comment lines such as OpenRouter's `: OPENROUTER PROCESSING`, the `[DONE]` sentinel). Covered by Task 2 parser tests.
3. **The selection contains template syntax or `$` sequences** (`{{context}}`, `$&`, `$1`). Expected: inserted literally, with no second expansion. This also fixes the existing `replaceAll` `$`-pattern bug. Covered by Task 3 renderer tests.
4. **`custom` base URL variants:**
   - a trailing `/` and an already-appended `/chat/completions` are normalised;
   - `http://` to a public host is rejected;
   - an empty API key is allowed.

   Covered by Task 1 `normalizeBaseUrl` tests.
5. **The user closes the tooltip mid-stream, then runs another action.** Expected: late `AI_CHUNK`/`AI_RESULT` messages from the cancelled run never re-open a tooltip. Covered by Task 2 (request-id gating plus `CANCEL_ACTION`) and the manual check M3.

---

### Task 1: Custom OpenAI-compatible provider

**Files:**
- Modify: `lib/api-client.js`. Add a `custom` branch in `callAI` and `fetchAvailableModels`. Add `normalizeBaseUrl`. Extract a shared chat-completions caller.
- Modify: `lib/storage.js`:
  - add `custom` to `VALID_PROVIDERS`, `PROVIDER_DISPLAY_NAMES` and `PROVIDER_DEFAULT_MODELS` (default model `''`);
  - validate in `saveSettings`;
  - add a `baseUrl` field to model configs.
- Modify: `options.html`:
  - add the provider option `<option value="custom">Custom (OpenAI-compatible)</option>`;
  - add a `.model-config-baseurl` field in `modelConfigTemplate`, hidden unless provider is `custom`;
  - add a hint: "e.g. http://localhost:11434/v1 (Ollama). Ollama may need OLLAMA_ORIGINS=chrome-extension://*".
- Modify: `options.js`:
  - `addModelConfigCard` shows/hides the base URL field via `syncProviderFields`;
  - `collectModelConfigs` emits `baseUrl`;
  - Test button and Save request the origin permission;
  - the model list cache key is `custom:<baseUrl>`.
- Modify: `background.js`. In `runAction`, the "Missing API key" check is skipped for `provider === 'custom'`. Pass `baseUrl` to `callAI`.
- Test: `tests/api-client.test.js`, `tests/storage.test.js`

**Interfaces:**
- Produces:
  - `normalizeBaseUrl(url: string): string` (exported from `lib/api-client.js`):
    - trims the input;
    - strips trailing `/` and a trailing `/chat/completions`;
    - throws `Error('Invalid base URL')` on unparsable input or a non-http(s) protocol;
    - throws `Error('Base URL must use HTTPS unless it points to a local or private-network host')` for `http:` with a host outside loopback/private ranges. Loopback/private means: `localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`, `10/8`, `172.16/12`, `192.168/16`, `*.local`.
  - `isPrivateHost(hostname: string): boolean` (exported).
  - `callAI({ ..., baseUrl })`: for `provider: 'custom'` it POSTs to `${normalizeBaseUrl(baseUrl)}/chat/completions`. It sends an `Authorization: Bearer` header only when `apiKey` is non-empty and uses `providerName` `'Custom endpoint'` in errors.
  - Internal shared helper `callChatCompletions({ url, headers, model, messages, maxTokensField, providerName, signal })`. `callOpenAI`, `callOpenRouter` and `callCustom` delegate to it. Task 2 adds streaming **inside this helper**. `maxTokensField` is `'max_completion_tokens'` for OpenAI and `'max_tokens'` for the others.
  - `fetchAvailableModels('custom', apiKey, signal, baseUrl)` → `GET ${base}/models` and maps `data[].id`.
  - Model config shape: `{ id, name, provider, model, apiKey, baseUrl? }`. `baseUrl` is stored only for `custom`.

- [ ] **Step 1: write failing tests** in `tests/api-client.test.js`:

```js
test('normalizeBaseUrl strips trailing slash and /chat/completions', () => {
  assert.equal(normalizeBaseUrl(' http://localhost:11434/v1/ '), 'http://localhost:11434/v1');
  assert.equal(normalizeBaseUrl('https://x.example.com/v1/chat/completions'), 'https://x.example.com/v1');
});
test('normalizeBaseUrl allows http only for local/private hosts', () => {
  for (const ok of ['http://127.0.0.1:1234/v1', 'http://192.168.1.5/v1', 'http://10.0.0.2/v1', 'http://172.20.0.1/v1', 'http://nas.local/v1', 'http://[::1]:8080/v1'])
    assert.doesNotThrow(() => normalizeBaseUrl(ok));
  assert.throws(() => normalizeBaseUrl('http://api.example.com/v1'), /HTTPS/);
  assert.throws(() => normalizeBaseUrl('http://172.32.0.1/v1'), /HTTPS/);
  assert.throws(() => normalizeBaseUrl('ftp://localhost/v1'), /Invalid base URL/);
  assert.throws(() => normalizeBaseUrl('not a url'), /Invalid base URL/);
});
```

  In `tests/storage.test.js` (follow the file's existing `chrome.storage` mock pattern):
  - `saveSettings accepts a custom config without apiKey`;
  - `saveSettings rejects custom without baseUrl`, error matching `/base URL/i`;
  - `saveSettings rejects custom with public http baseUrl`, error matching `/HTTPS/`;
  - `saveSettings still requires apiKey for openai`.
- [ ] **Step 2: run.** `npm test`. Expected: the new tests FAIL (`normalizeBaseUrl is not a function` or the validation does not throw).
- [ ] **Step 3: implement.**
  - Add `normalizeBaseUrl`/`isPrivateHost`.
  - Extract `callChatCompletions`.
  - Add `callCustom`.
  - Add the `custom` branches in `callAI` and `fetchAvailableModels`.
  - In `saveSettings`:
    - `custom` requires `model`;
    - `baseUrl` is validated via `normalizeBaseUrl`, with its error rethrown as `Model configuration "<name>": <message>`;
    - `apiKey` is optional only for `custom`.

  `storage.js` must import `normalizeBaseUrl` from `./api-client.js` (no cycle: api-client imports nothing from storage).
- [ ] **Step 4: wire the options UI.**
  - Show the base URL field only for `custom`.
  - Placeholder `http://localhost:11434/v1`.
  - Model datalist fetch for `custom` uses `fetchAvailableModels('custom', key, signal, baseUrl)`. Refetch on base-URL `input` with the same 600 ms debounce as the API key. Cache key `custom:<normalized baseUrl>` in `modelListCache`.
  - Test button: for `custom`, first call `chrome.permissions.request({ origins: [new URL(base).origin + '/*'] })` before any await. Show "Permission for <origin> denied" if refused.
  - `onSave`: add every custom config's origin to the existing `requestWebhookPermissions(...)` call. Rename it to `requestOriginPermissions`; it stays one combined prompt, before any await. Append the warning `custom endpoint permission not granted` when refused.
- [ ] **Step 5: run.** `npm test`. Expected: all pass.
- [ ] **Step 6: commit.** `feat: add custom OpenAI-compatible provider (Ollama, LM Studio, vLLM)`

---

### Task 2: Streaming responses and the shared chat runner

**Files:**
- Modify: `lib/api-client.js`:
  - `callAI` accepts `messages` and `onDelta`;
  - streaming for anthropic / openai / openrouter / custom (via `callChatCompletions`) / google;
  - an SSE parser;
  - a stream idle timeout.
- Create: `lib/chat.js`, holding pure run helpers.
- Modify: `background.js`:
  - add `runChat`;
  - `runAction` delegates to it;
  - `AI_CHUNK` throttling;
  - `CANCEL_ACTION`;
  - `AI_RESULT` gains `actionId`, `conversation`, `sourceText`.
- Modify: `content.js`:
  - `AI_CHUNK` → streaming tooltip;
  - the final result reuses the streaming tooltip's position;
  - cancel on dismiss;
  - shadow styles for `.cmn-streaming`.
- Test: `tests/api-client.test.js`, create `tests/chat.test.js`

**Interfaces:**
- Consumes: Task 1 `callChatCompletions`, the `custom` provider and `baseUrl`. Rebase onto Task 1 before review if it has merged.
- Produces (later tasks rely on these exact names):
  - `callAI({ provider, apiKey, model, baseUrl, prompt, messages, systemPrompt, targetLang, signal, onDelta }): Promise<string>`:
    - `messages: Array<{ role: 'user' | 'assistant', content: string }>` takes precedence over `prompt`;
    - without `messages`, the conversation is `[{ role: 'user', content: prompt }]`;
    - Gemini maps `assistant` → `model`;
    - DeepL uses the last user message's content as the text;
    - `onDelta(fullTextSoFar: string)` is called on each received text delta; when absent, the request is non-streaming exactly as today.
  - `createSSEParser(onData: (data: string, event: string | null) => void): { push(chunk: string): void, end(): void }` (exported):
    - handles split lines and `\r\n`;
    - ignores `:` comment lines and `[DONE]`;
    - joins multi-line `data:` fields with `\n`.
  - `extractStreamDelta(provider: string, payload: object): string` (exported):
    - anthropic: a `content_block_delta` with `delta.type === 'text_delta'` returns `delta.text`; an `error` payload throws `APIError(0, payload.error.message)`;
    - chat-completions providers: `choices[0].delta.content`;
    - google: the joined `candidates[0].content.parts[].text`;
    - otherwise `''`.
  - `STREAM_IDLE_TIMEOUT_MS = 30_000`: no byte for 30 s → abort and throw `APIError(0, 'API stream stalled')`.
  - `lib/chat.js` exports:
    - `shouldStream({ provider, displayMode, editable }): boolean`: true iff `provider !== 'deepl'` and (`displayMode === 'tooltip'` or (`displayMode === 'auto'` and `!editable`));
    - `pickLLMConfig(configs, configId?)`: the config with `configId` when given and found; otherwise the first config whose `provider !== 'deepl'`; otherwise `null`;
    - `ASK_ACTION_ID = '__ask__'`;
    - `createThrottle(fn, ms)`: trailing-edge throttle returning `{ call(arg), flush(), cancel() }`.
  - `background.js`:
    - `runChat(tab, settings, buildRequest)`, where `buildRequest: () => Promise<{ config, messages, systemPrompt, targetLang, displayMode, editable, meta: { actionId, actionName, sourceText } }>` runs **after** `AI_PROCESSING_START`. Errors it throws become `AI_ERROR`.
    - `runAction` becomes: build the request (existing validation and prompt) → `runChat`.
  - Messages:
    - `AI_CHUNK { requestId, text, tooltipSettings }`: accumulated text, throttled at 100 ms, sent only when `shouldStream(...)`;
    - `AI_RESULT` gains `actionId`, `sourceText`, and `conversation` (`[...messages, { role: 'assistant', content: result }]`, or `null` for DeepL);
    - `CANCEL_ACTION { requestId }` goes content → background and aborts the tab's controller only if its stored request id matches. Store `{ controller, requestId }` per tab in `_abortControllersByTab`.

- [ ] **Step 1: write failing parser tests** (`tests/api-client.test.js`):

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
test('extractStreamDelta per provider', () => {
  assert.equal(extractStreamDelta('anthropic', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }), 'Hi');
  assert.equal(extractStreamDelta('anthropic', { type: 'message_start' }), '');
  assert.equal(extractStreamDelta('openai', { choices: [{ delta: { content: 'a' } }] }), 'a');
  assert.equal(extractStreamDelta('custom', { choices: [{ delta: {} }] }), '');
  assert.equal(extractStreamDelta('google', { candidates: [{ content: { parts: [{ text: 'g' }, { text: 'h' }] } }] }), 'gh');
  assert.throws(() => extractStreamDelta('anthropic', { type: 'error', error: { message: 'Overloaded' } }), /Overloaded/);
});
```

  Stream integration tests: stub `globalThis.fetch` with a `Response` whose body is a `ReadableStream` of encoded chunks (Node 18+ has both):
  - `callAI streams anthropic deltas and resolves full text`: `onDelta` receives `['He', 'Hello']` and the call resolves `'Hello'`;
  - `callAI stream with only an error event rejects`;
  - `callAI stream that ends empty rejects with /empty response/`;
  - `callAI non-streaming without onDelta unchanged`: the body has no `stream: true`;
  - `callAI sends messages multi-turn`: for openai the request body `messages` equals `[system, user, assistant, user]`; for google the `contents[1].role === 'model'`;
  - `idle timeout`: make the timeout injectable for tests by exporting `_setStreamIdleTimeoutForTests(ms)`, set 20 ms, use a body that never enqueues, expect rejection `/stalled/`.
- [ ] **Step 2: write failing `tests/chat.test.js`:**
  - `shouldStream` truth table (deepl → false; tooltip → true; auto + editable → false; auto + !editable → true; insert → false);
  - `pickLLMConfig` (by id; falls back to first non-DeepL; DeepL-only → null);
  - `createThrottle` (call ×3 within window → fn called once with the last arg after `ms`; `flush` calls immediately; `cancel` drops). Use `node:test` mock timers: `t.mock.timers.enable({ apis: ['setTimeout'] })`.
- [ ] **Step 3: run.** `npm test`. Expected: the new tests FAIL.
- [ ] **Step 4: implement the api-client streaming.**
  - Request bodies get `stream: true` only when `onDelta` is given:
    - Anthropic: same URL;
    - chat completions: same URL;
    - Gemini: `${GEMINI_BASE_URL}/${model}:streamGenerateContent?alt=sse`.
  - A non-OK response keeps the existing JSON error path.
  - Read `response.body` with `TextDecoder` in stream mode. Reset the idle timer on each read. Cancel the reader on `signal` abort and rethrow `DOMException('Request cancelled', 'AbortError')`.
  - The final empty text throws the same "returned an empty response" messages as the extractors.
- [ ] **Step 5: implement `lib/chat.js`, `runChat`, the `AI_CHUNK` throttle and `CANCEL_ACTION`.**
  - The throttle is flushed and cancelled before `AI_RESULT`, so no chunk arrives after the result.
  - The menu, shortcut and floating-button paths still go through `runAction`.
- [ ] **Step 6: content.js.**
  - `AI_CHUNK` (gated by `activeRequestId`) → `showStreamingTooltip(text, ts)`. It creates the tooltip once (class `cmn-overlay cmn-tooltip cmn-streaming`, plain `textContent`, a close button, a blinking caret via CSS) and updates its text afterwards. It auto-scrolls only if the user is within 24 px of the bottom.
  - Esc, the close button and outside clicks during streaming:
    - send `CANCEL_ACTION { requestId: activeRequestId }`;
    - set `activeRequestId = -1`;
    - call `hideOverlay()`.
  - `AI_RESULT` in tooltip mode while a streaming tooltip exists: `showResultTooltip(text, ts, sendContext, { position: { top, left } })` reuses its top/left, so there is no jump.
  - Add `.cmn-streaming` styles in `getShadowStyles()`. Any class with `display:` needs a `[hidden]` override (see the CLAUDE.md pitfall).
- [ ] **Step 7: run.** `npm test`. Expected: all pass.
- [ ] **Step 8: commit**, as two commits:
  - `feat: stream AI responses for tooltip results`
  - `refactor: route all AI runs through runChat`

  Or one commit if they are inseparable.

---

### Task 3: Page-context placeholders `{{context}}`, `{{pageTitle}}`, `{{pageUrl}}`

**Files:**
- Create: `lib/prompt.js`
- Modify: `background.js`:
  - `runAction`'s `buildRequest` renders via `renderActionPrompt`;
  - add `getPageContext(tabId)` (`chrome.scripting.executeScript`), called only when the template uses `{{context}}`, `{{pageTitle}}` or `{{pageUrl}}`.
- Modify: `options.html`. The action hint lists the placeholders: "Placeholders: {{text}} (required), {{context}} (surrounding paragraph), {{pageTitle}}, {{pageUrl}}".
- Test: create `tests/prompt.test.js`

**Interfaces:**
- Consumes: Task 2 `runChat`/`buildRequest`.
- Produces (`lib/prompt.js`):
  - `ACTION_PLACEHOLDERS = ['text', 'context', 'pageTitle', 'pageUrl']`;
  - `renderActionPrompt(template: string, vars: Record<string, string>): string`. One pass with `/\{\{(text|context|pageTitle|pageUrl)\}\}/g` and a function replacer. Missing vars → `''`. Unknown `{{x}}` stays untouched. Values are never re-scanned.
  - `templateUsesPageContext(template: string): boolean`: true when the template contains any of the three non-`text` placeholders.
  - `windowAround(text: string, start: number, end: number, max = 2000): string`:
    - returns `text` if `text.length <= max`;
    - otherwise a slice of length ≤ `max` that contains `[start, end)`, centred on it, with `…` prefixed/suffixed where cut;
    - if the selection alone exceeds `max`, returns `text.slice(start, end)`.
- `getPageContext(tabId) → { context, pageTitle, pageUrl }`:
  - the injected func returns `{ blockText, start, end, title: document.title, url: location.href }`;
  - for a text control: `blockText = el.value`, with the selection offsets;
  - otherwise: the nearest ancestor of the range's `commonAncestorContainer` matching `p,li,td,th,blockquote,pre,dd,article,section,div` whose `innerText.length >= selection.length`, with offsets found via `innerText.indexOf(selectionText)` (fallback: start 0);
  - the background applies `windowAround`;
  - on restricted pages it returns empty strings, and `pageUrl`/`pageTitle` fall back to `tab.url`/`tab.title`.

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
});
```

- [ ] **Step 2: run.** `npm test`. Expected: FAIL (module missing).
- [ ] **Step 3: implement `lib/prompt.js` and wire it into the background.** The DeepL path keeps the raw selection.
- [ ] **Step 4: run.** `npm test`. Expected: all pass.
- [ ] **Step 5: commit.** `feat: add {{context}}, {{pageTitle}}, {{pageUrl}} action placeholders`

---

### Task 4: Refine the result in the tooltip

**Files:**
- Modify: `lib/chat.js`. Add `REFINE_PRESETS`, `buildRefineMessages`, `sanitizeConversation`.
- Modify: `background.js`:
  - `REFINE_ACTION` handler → `runChat` with `displayMode: 'tooltip'`;
  - config resolution: `actionId === ASK_ACTION_ID` → `pickLLMConfig(configs)`, else the action's `modelConfigId` via `pickLLMConfig(configs, action.modelConfigId)`.
- Modify: `content.js`:
  - the refine bar in `showResultTooltip`, shown only when `conversation` is non-null;
  - shadow styles.
- Test: `tests/chat.test.js`

**Interfaces:**
- Consumes: Task 2 `AI_RESULT.conversation/actionId/sourceText`, `runChat`, `pickLLMConfig`, `ASK_ACTION_ID`.
- Produces:
  - `REFINE_PRESETS = { shorter: 'Make it shorter. Return only the revised text.', longer: 'Expand it with more detail. Return only the revised text.', simpler: 'Rewrite it in simpler language. Return only the revised text.' }`;
  - `buildRefineMessages(conversation, instruction: string | null)`:
    - `instruction === null` (Retry) → the conversation without its trailing assistant message;
    - otherwise → the conversation plus `{ role: 'user', content: instruction.trim() }`;
  - `sanitizeConversation(value): Array | null`:
    - returns `null` unless it is an array of 1–21 items with `role ∈ {user, assistant}` and string `content` (≤ 100 000 chars each), starting with `user` and alternating;
    - when longer than 21, keep the first message plus the last 20, re-aligned so roles still alternate;
  - message `REFINE_ACTION { actionId, conversation, instruction, sourceText }` goes content → background. The background drops it silently if `sanitizeConversation` returns null or the action/config cannot be resolved, otherwise shows an `AI_ERROR` such as "Action no longer exists".
- UI:
  - a row under the content: buttons `Shorter`, `Longer`, `Simpler`, `↻ Retry`, plus an input with placeholder `Follow up…` (Enter submits; empty input is ignored);
  - while a refine runs, the spinner flow takes over (`AI_PROCESSING_START`), then the streaming tooltip;
  - the tooltip anchor stays at the last selection rect;
  - keyboard events in the input must not bubble to the page: `stopPropagation` on `keydown`/`keyup`/`keypress`. Esc still closes the tooltip.

- [ ] **Step 1: failing tests** (`tests/chat.test.js`):

```js
const conv = [{ role: 'user', content: 'P' }, { role: 'assistant', content: 'R' }];
test('buildRefineMessages appends instruction / drops last answer on retry', () => {
  assert.deepEqual(buildRefineMessages(conv, ' Shorter '), [...conv, { role: 'user', content: 'Shorter' }]);
  assert.deepEqual(buildRefineMessages(conv, null), [{ role: 'user', content: 'P' }]);
});
test('sanitizeConversation rejects malformed input', () => {
  assert.equal(sanitizeConversation(null), null);
  assert.equal(sanitizeConversation([{ role: 'assistant', content: 'x' }]), null);
  assert.equal(sanitizeConversation([{ role: 'user', content: 1 }]), null);
  assert.equal(sanitizeConversation([{ role: 'system', content: 'x' }]), null);
  assert.deepEqual(sanitizeConversation(conv), conv);
});
test('sanitizeConversation trims long history keeping first message and alternation', () => {
  const long = Array.from({ length: 41 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) }));
  const out = sanitizeConversation(long);
  assert.ok(out.length <= 21);
  assert.equal(out[0].content, '0');
  out.forEach((m, i) => i && assert.notEqual(m.role, out[i - 1].role));
});
```

- [ ] **Step 2: run.** `npm test`. Expected: FAIL.
- [ ] **Step 3: implement the helpers, the background handler and the content refine bar.**
- [ ] **Step 4: run.** `npm test`. Expected: all pass.
- [ ] **Step 5: commit.** `feat: refine results in the tooltip (shorter, longer, simpler, retry, follow-up)`

---

### Task 5: "Ask about selection…"

**Files:**
- Modify: `lib/chat.js`. Add `buildAskPrompt`.
- Modify: `background.js`:
  - menu item `contexthelper-ask` "Ask about selection…" (contexts `['selection']`), created after the action items and before the separator;
  - command `ask-selection`;
  - `ASK_PROMPT` → content;
  - `RUN_ASK` handler → `runChat` with `meta.actionId = ASK_ACTION_ID`, `actionName: 'Ask'`, `displayMode: 'tooltip'`.
- Modify: `manifest.json`. Add `"ask-selection": { "description": "Ask a question about the selected text" }` with no `suggested_key`.
- Modify: `content.js`. Add the `ASK_PROMPT` case and `showAskInput(selectionText, ts)`. It is an overlay at the selection rect with a single-line input (placeholder `Ask about the selection…`), an `Ask` button and Esc to close. Submit sends `RUN_ASK { question, selectionText }`. Use the same keyboard `stopPropagation` as Task 4.
- Test: `tests/chat.test.js`

**Interfaces:**
- Consumes: Task 2 `runChat`, `pickLLMConfig`, `ASK_ACTION_ID`, `getSelectionFromTab` (existing) and `showTabNotice` (existing).
- Produces:
  - `buildAskPrompt(question: string, text: string): string` returns `` `${question.trim()}\n\nSelected text:\n"""\n${text}\n"""` ``;
  - messages `ASK_PROMPT { selectionText, tooltipSettings }` (background → content) and `RUN_ASK { question, selectionText }` (content → background). The background ignores an empty or whitespace question or an empty selection.
  - No LLM config: `showTabNotice(tabId, 'Ask needs an LLM model — add one in the extension settings (DeepL cannot answer questions)', settings)`.
  - The command path reuses `getSelectionFromTab`. An empty selection → `showTabNotice(..., 'Select some text first', ...)`.
  - The result is refinable automatically through Task 4 (`conversation` + `ASK_ACTION_ID`). Nothing extra is needed here if Task 4 is merged; if it is not yet, nothing breaks.

- [ ] **Step 1: failing test:**

```js
test('buildAskPrompt', () => {
  assert.equal(buildAskPrompt('  Why? ', 'abc'), 'Why?\n\nSelected text:\n"""\nabc\n"""');
});
```

- [ ] **Step 2: run.** `npm test`. Expected: FAIL.
- [ ] **Step 3: implement** the helper, menu item, command, handlers and content input. The `ask-selection` command must be handled in `handleCommand` before the `COMMAND_SLOT_RE` early return.
- [ ] **Step 4: run.** `npm test`. Expected: all pass.
- [ ] **Step 5: commit.** `feat: add "Ask about selection" ad-hoc prompt`

---

### Task 6 (orchestrator): docs, privacy, version, manual checks

**Files:** `CLAUDE.md`, `PRIVACY.md`, `README.md`, `manifest.json` (`version` → `1.1.0`)

- [ ] **Step 1: update `CLAUDE.md`.**
  - Message protocol: add `AI_CHUNK`, `CANCEL_ACTION`, `REFINE_ACTION`, `ASK_PROMPT`, `RUN_ASK`, and the new `AI_RESULT` fields.
  - The `runChat` runner and streaming rules (tooltip-only, insert stays atomic, idle timeout).
  - The `custom` provider in "Adding a new AI provider" (baseUrl, optional key, per-origin permission, cache key).
  - Action template syntax: the new placeholders and the single-pass renderer.
  - Architecture tree: `lib/chat.js`, `lib/prompt.js`.
- [ ] **Step 2: update `PRIVACY.md`.**
  - `{{context}}`/`{{pageTitle}}`/`{{pageUrl}}` send page data to the chosen provider only when the user's template uses them.
  - The custom endpoint receives the prompts.
- [ ] **Step 3: README feature list. Bump `manifest.json` to `1.1.0`.**
- [ ] **Step 4: `npm test` green. Commit** `docs: document 1.1.0 features and bump version`.
- [ ] **Step 5: manual checks for the user** (no browser in the agent environment):
  - **M1:** streaming in the tooltip for Anthropic, OpenAI, Gemini and OpenRouter.
  - **M2:** an insert-mode action in a textarea still replaces the text atomically.
  - **M3:** Esc mid-stream, then another action. No stale tooltip.
  - **M4:** Shorter / Retry / Follow up in the tooltip.
  - **M5:** `{{context}}` on an article paragraph and inside a textarea.
  - **M6:** Ask via the menu and via the `ask-selection` shortcut (assigned in `chrome://extensions/shortcuts`).
  - **M7:** Ollama `http://localhost:11434/v1`: permission prompt, Test, streaming, and a CORS hint if 403.
  - **M8:** a DeepL action shows no refine bar and no streaming.
- [ ] **Step 6: merge `release/1.1.0` into `main`** (`--no-ff`). Do not push without the user's consent.
