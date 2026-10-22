# Live model lists + API requests aligned with current docs (1.2.0)

## Context

The user reported two problems:
- Options shows old models.
- Typing a new valid model shows a false "not on this provider's model list" warning.

They also suspect the Anthropic and Gemini requests are out of date.

Code investigation (`lib/api-client.js`, `options.js`, `lib/storage.js`) and the current docs (verified 2026-10-22) confirm both. They also turned up a likely outage.

**Requests**
- **Anthropic is probably broken now for 5.x.** We send `temperature: 0.3` with `anthropic-version: 2023-06-01`. Claude 4.7+ and 5.x return 400 for any value other than 1.0. The new version `2026-10-21` rejects `temperature`/`top_p`/`top_k` on every model.
- **Max-token budgets are too small.** Thinking is on by default on Claude 5.x and Gemini 3.x. With `max_tokens` / `maxOutputTokens` at 4096, which counts the thinking, the answer can come back empty.
- **Gemini 3.6+ ignores `temperature`.** Google recommends the default for Gemini 3. There is also a new `finishReason` `CONTINUATION`.
- **OpenAI GPT-6 rejects `temperature`** unless `reasoning_effort: none`. Today every call costs an extra 400 and retry. The docs recommend about 25k of `max_completion_tokens` for reasoning.
- **OpenRouter** has a newer title header: `X-OpenRouter-Title`.

**Lists**
- The warning validates against the built-in 3–11 item fallback whenever the live fetch did not run or failed silently.
- The 24 h cache blocks refetch, and it is per provider, not per key.
- There is no pagination: Anthropic is cut at `limit=100`, Gemini at `pageSize=200`.
- The OpenAI filter is loose. It drops new families and lets Responses-only models through (`-pro`, `codex`).
- The Gemini filter lets image, TTS and embedding models through.
- OpenRouter shows `:batch` entries.

**User decisions**
- Add a per-model-config "Reasoning effort" select.
- DeepL target languages come from the API (`/v3/languages`), with the static list as fallback.

## Workflow (the user's standard one)

1. Plan, then consult Codex on the plan.
2. Run Opus subagents, each in its own worktree.
3. Review with Codex and GLM-5.3 (`opencode run -m ollama-cloud/glm-5.3 --agent plan`).
4. Merge into local `main`. **No push.**
5. Bump the version to 1.2.0 at the end.

Use TDD (`node --test`), with a separate commit per logical change.

Waves:
- **Wave 1**, in parallel: Task A (requests + effort) and Task C (DeepL languages). They touch different functions.
- **Wave 2**: Task B (live lists + warning). It goes on top of A because both edit the model-card code in `options.js`.

## Task A — requests per provider + reasoning effort

`lib/api-client.js`:

**Anthropic (`callAnthropic`)**
- Header `anthropic-version: 2026-10-21`.
- Remove `temperature`.
- Raise `max_tokens` from 4096 to 16000 (new const `ANTHROPIC_MAX_TOKENS`). Thinking counts toward it, and the models allow up to 128k.
- Keep `x-api-key` and `anthropic-dangerous-direct-browser-access`. Both are still supported; switching to `Authorization: Bearer` would risk CORS/compat for no gain.
- Do not send `thinking`. The 5.x models default to adaptive, and `disabled`/`enabled` returns 400 on them.

**Gemini (`callGemini`)**
- Remove `temperature` from `generationConfig`.
- Raise `maxOutputTokens` from 4096 to 16000.
- Treat `finishReason: CONTINUATION` like the other terminal reasons, keeping the partial text.

**OpenAI**
- `callChatCompletions` gets a `temperature` option. OpenAI does not send it at all; OpenRouter and custom keep 0.3 plus the existing 400 fallback.
- Raise `OPENAI_MAX_COMPLETION_TOKENS` from 16000 to 25000.

**OpenRouter**
- Replace `X-Title` with `X-OpenRouter-Title`.
- A test checks that `: OPENROUTER PROCESSING` comment lines are skipped in `readStream`, and that the usage chunk with a repeated `finish_reason` ends the stream once.

**Empty answers**
- If the answer is empty and the stop reason is `max_tokens`/`length`/`MAX_TOKENS`, throw `APIError`: "The model used its whole token budget on reasoning — lower Reasoning effort".
- `refusal` / `SAFETY` / `content_filter` with an empty answer gives "The model declined to answer".
- Applies to both stream and non-stream. `readStream` and the parsers must surface the stop reason.

**Reasoning effort**
- New field on model configs: `effort: '' | 'low' | 'medium' | 'high'`. `''` means don't send it, so the provider default applies.
- Mapping:

  | Provider | Parameter |
  |---|---|
  | anthropic | `output_config: { effort }` |
  | openai, custom | `reasoning_effort` |
  | openrouter | `reasoning: { effort }` |
  | google | `generationConfig.thinkingConfig.thinkingLevel` (`LOW`/`MEDIUM`/`HIGH`) |
  | deepl | none |

- Generalize the temperature fallback. A 400 whose message mentions an optional parameter (`/temperature|effort|reasoning|thinking/i`) gets one retry without the tuning params (temperature + effort). Remember `${url}|${model}` in the cache (rename `_noTemperatureModels` to `_noTuningModels`).
- Add the same fallback to `callAnthropic` and `callGemini`. Older models, e.g. Gemini 2.5 or Haiku 4.5, can reject effort or thinkingLevel.
- `callAI` passes `config.effort`. Check `background.js` `runChat`/`pickLLMConfig` so the config passes through whole.

**Storage, options and docs**
- `lib/storage.js`: validate `effort` in `modelConfigs`. Unknown values become `''`. Migration needs no new code, because a missing field equals `''`.
- `options.html`/`options.js`: add a "Reasoning effort" select to the model card (Default / Low / Medium / High). Hide it for DeepL in `syncProviderFields`, and save it in `collectSettings`.
- Docs: update the "Reasoning models" paragraph in CLAUDE.md, and the README.

**Tests (`tests/api-client.test.js`, `tests/storage.test.js`)**
- Exact Anthropic headers and body (no temperature, version 2026-10-21, 16000).
- Exact Gemini body (no temperature, 16000).
- OpenAI without temperature, with 25000.
- The effort mapping for every provider.
- A 400 on effort retries once and caches.
- `CONTINUATION` ends the stream.
- Empty `max_tokens` gives the reasoning error.
- Effort storage sanitizing.

## Task B — live model lists + correct warning

**`fetchAvailableModels` in `lib/api-client.js`**
- **Anthropic**
  - `limit=1000` plus an `after_id`/`has_more` loop, capped at 5 pages.
  - Exclude `lifecycle` `deprecated`/`retired` if the field is present.
- **Google**
  - `pageSize=1000` plus a `pageToken` loop, capped at 5 pages.
  - Keep the `supportedGenerationMethods` filter, and add a name-exclude regex: `/embedding|imagen|veo|tts|live|aqa|image|nano-banana|transcribe|translate|robotics|computer-use|lyria|omni/`.
  - Use `displayName` as the label.
- **OpenAI**
  - Allowlist `^(gpt-\d|o\d|chatgpt-|chat-latest)`.
  - Denylist `embedding|tts|whisper|transcribe|realtime|live|audio|image|dall-e|moderation|search|computer-use|codex|deep-research|-pro\b|cyber|daybreak|oss|instruct|babbage|davinci`. These are not chat models, or are Responses-only.
- **OpenRouter**
  - Exclude `:batch`.
  - Require `architecture.output_modalities` to include `text` when the field exists.
- **custom**: no change.
- Export the filter functions (`filterOpenAIModels`, `filterGeminiModels`, `filterOpenRouterModels`) for tests.
- Refresh the static fallbacks in `getAvailableModels`:
  - anthropic: add `claude-fable-5-1`.
  - google: add `gemini-4-argon`.
  - openrouter: add `anthropic/claude-opus-5.5` and `google/gemini-4-argon`, and check the rest against the live list.
  - Keep `DEFAULT_MODELS`.

**Cache (`lib/storage.js` + `options.js`)**
- Key: `${provider}:${fingerprint}`. The fingerprint is the first 12 hex characters of `SHA-256(apiKey)` from `crypto.subtle`, so the key itself is never stored. OpenRouter uses the bare `openrouter`; custom keeps `custom:<baseUrl>`.
- Old keys are pruned on write. Also prune entries older than 7 days on write, which fixes the parked "custom:* never pruned" issue.
- **Stale-while-revalidate.** Show the cache instantly, and always refetch in the background when the options page opens, once per card, with a sequence guard. TTL then only controls the badge text. This drops the "24 h without refetch" behaviour.

**Warning (`options.js` `validateModel`)**
- Validate only against a **live** list: one fetched in this session, or a cache for the same key fingerprint. Never against `Built-in list`. Keep a `listSource: 'builtin' | 'cache' | 'live'` flag per card.
- While the list is `builtin`, show no warning. The hint says "Built-in list — couldn't load the live list" when the fetch failed (instead of a silent `catch {}`). Show the error message in the hint's `title`.
- A successful Test hides the warning and forces `refreshModels(true)` for every provider, not only custom.
- New wording: "⚠ "X" is not on the list returned by <Provider> — check the ID".
- Add a small `↻` button next to the model field for a manual refresh (forceFetch).

**Tests**
- New `tests/model-lists.test.js`:
  - pagination for Anthropic and Gemini with `stubFetch`;
  - the filters (gpt-6-luna kept; gpt-6.1-sol-pro, codex, tts, embedding dropped; Gemini image/embedding dropped; OpenRouter `:batch` dropped);
  - the fingerprint cache key;
  - pruning.
- Move `validateModel`'s decision logic into a pure function `shouldWarnUnknownModel(value, ids, listSource)` in `lib/model-list.js`, so it can be tested.

## Task C — DeepL target languages from the API

- `lib/api-client.js`: add `fetchDeepLTargetLanguages(apiKey)`.
  - Calls `GET {base}/v3/languages?resource=translate_text` with `Authorization: DeepL-Auth-Key`.
  - Filters on `usable_as_target`.
  - Maps to `{ code: lang.toUpperCase(), name }`, because v3 returns BCP-47 casing (`en-US`) while `target_lang` and the current data use `EN-US`.
  - Falls back to `/v2/languages?type=target` when v3 returns 404.
- The cache reuses `modelListCache` with key `deepl-langs:${fingerprint}`.
- `options.js` `syncActionCardMode`: the target-language select fills from the cache or API. `DEEPL_TARGET_LANGUAGES` stays as the instant fallback. A saved value missing from the list is still shown as an option, with no data loss.
- `lib/storage.js`: check whether `targetLang` validation is tied to the static list. If so, relax it to the format `^[A-Z]{2,3}(-[A-Z0-9]{2,4})?$`.
- Tests:
  - mapping and case normalization;
  - the v2 fallback;
  - a saved code outside the list stays.

## Critical files

- `lib/api-client.js`: `callAnthropic`, `callGemini`, `callChatCompletions`, `parseStreamEvent`, `readStream`, `fetchAvailableModels`, `getAvailableModels`, plus new filter, fingerprint and DeepL helpers.
- `lib/storage.js`: `effort` sanitizing, the cache key and pruning, `targetLang` validation.
- `lib/model-list.js` (new, pure): `shouldWarnUnknownModel`, `modelCacheKey`.
- `options.js` / `options.html`: the effort select, `listSource`, `↻`, hint and warning, DeepL languages.
- `background.js`: only if `config.effort` does not pass through already.
- Docs: `CLAUDE.md` (the "Model lists", "Reasoning models" and DeepL sections), `README.md`, `PRIVACY.md` if it changes (`/v3/languages` sends only the key).

## Verification

1. `npm test`: everything green, with the new tests in Tasks A, B and C.
2. Headless Chromium (`~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome --load-extension`):
   - the options page loads;
   - no exceptions;
   - the effort select is present, and hidden for DeepL;
   - `↻` and the hint behave correctly with a stubbed-out fetch (no key, so the builtin list shows and there is no warning).
3. Manual checks for the user, with real keys:
   - **Lists**: each provider shows a fresh list, and typing a new model ID gives no warning.
   - **Anthropic**: a Test on `claude-sonnet-5-5` passes (today a 400 is expected).
   - **Gemini**: a Test on `gemini-3.8-flash` passes.
   - **OpenAI**: a Test on `gpt-6-luna` makes no temperature retry, which shows in DevTools Network.
   - **Effort**: Low gives faster replies.
   - **DeepL**: the language list loads.
4. Codex + GLM review the diff of each task before merge.

## Revision 1 (after Codex review)

Waves change to: **Wave 1 = Task A ∥ Task B**, then **Wave 2 = Task C**. C builds on B's cache and fingerprint infrastructure. The orchestrator resolves the `options.js` conflict between A and B at merge.

**Task A**

**A1. Fallback on 400.**
- Retry only when the error names a tuning field we **actually sent**. Use per-field matching:
  - `temperature`: `/temperature/i`
  - effort: `/effort|reasoning_effort|reasoning|thinking_?level|thinkingConfig|output_config/i`
- Apply it only when that field is present in the body.
- The retry drops only the rejected field.
- Cache the rejection (`${url}|${model}|${field}`) **only after the retry succeeds**.
- Tests:
  - an unrelated 400 that mentions "reasoning" while effort was not sent does not retry;
  - a custom endpoint rejecting `reasoning_effort` succeeds on retry and is then cached.

**A2. Retry boundary.**
- Retry only on HTTP 400 that arrives before `readStream` starts, at most once per field.
- The retry keeps the same `signal` and `onDelta`.
- Never retry SSE errors.
- Tests: abort between attempts, abort during the retry.

**A3. Stop reasons.**
- Anthropic: collect `message_delta.delta.stop_reason` without ending the stream; the stream still ends at `message_stop`.
- Normalize stop reasons into `{ text, stopReason: 'length' | 'refusal' | 'stop' | other }` for stream and non-stream.
- Classify an empty answer only after the stream has ended. Partial text plus EOF keeps the current behaviour.
- Add a regression test for `CONTINUATION`.

**A4. Plumbing (required):**
- `background.js` `runChat` (around :747–763) passes `effort`.
- `options.js` Test passes `effort`.
- `collectModelConfigs` saves `effort`.
- Test the path saved config → request body.

**A5. Error classes.**
- Budget exhausted (`length`) and `refusal` raise `APIError` with a new status code `422`-like marker (not 0), so they are **not retryable**: no `↻ Retry`.
- A genuine empty stream or transport failure stays status 0 and retryable.
- Test `isRetryableError`.

**Task B**

**B1. Race guards.**
- Bump the sequence counter **synchronously** on provider, key or base-URL edits, and on a switch to DeepL. This invalidates in-flight work.
- Capture request identity before hashing the fingerprint.
- Guard every `await` and every hint or `listSource` update.
- Render the built-in list before hashing.

**B2. Successful Test.**
- Remember `verifiedModel` for the exact tuple `provider|key|baseUrl|model`.
- `validateModel` skips the warning for that tuple.
- Invalidate it on any edit.
- Ignore Test completions that are stale against the current card identity.

**B3. Cache writes.**
- A single serialized writer: `updateModelListCache(mutator)` with a module-level promise chain in `lib/storage.js`. It covers set and prune.
- Retained keys: `openrouter`, `custom:*`, `<provider>:<fp>`, `deepl-langs:<fp>`. Prune only by age (> 7 days).
- Cross-window serialization is not required: one options window is the norm.
- Test interleaved writes.

**B4. Filters.** Do not export the filters. Test them through `fetchAvailableModels` with `stubFetch`.

**B5. Verification wording.** A model missing from the live list still warns. That is correct. Only an ID that is on the live list, or one confirmed by Test, must not warn.

**Task C**

**C1. Shape.**
- Map v3 and v2 to `{ id: CODE_UPPER, name }`, the same shape as `DEEPL_TARGET_LANGUAGES`.
- Preserve the saved value and the currently selected value on every render, including the first render from the fallback list.
- Normalize a saved lowercase value to uppercase on render. Test it.

**C2. Loading.**
- Load once per key identity, with in-flight dedup and a sequence guard. Do not reload on every `syncActionCardMode` call.
- A DeepL key edit (600 ms debounce) triggers a reload.
- Reuse B's `updateModelListCache` and fingerprint.

**C3.** Drop the `targetLang` format regex. Storage only checks for a non-empty value.
