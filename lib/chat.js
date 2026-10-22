// Pure helpers shared by the chat runner in background.js (no chrome.* here —
// unit tested under node).

import { fenceText } from './prompt.js';

/** Pseudo action id for the free-form Ask flow. */
export const ASK_ACTION_ID = '__ask__';

/**
 * Stream only when the result will be shown in a tooltip. Insert paths keep
 * the spinner and replace the text atomically; DeepL never streams.
 */
export function shouldStream({ provider, displayMode, editable }) {
  if (provider === 'deepl') return false;
  return displayMode === 'tooltip' || (displayMode === 'auto' && !editable);
}

/**
 * The config with `configId` when it exists, otherwise the first config that
 * is an LLM (not DeepL), otherwise null.
 */
export function pickLLMConfig(configs, configId) {
  if (!Array.isArray(configs) || !configs.length) return null;
  if (configId) {
    const match = configs.find(c => c?.id === configId);
    if (match) return match;
  }
  return configs.find(c => c && c.provider !== 'deepl') || null;
}

/**
 * The model config an action runs on: the one with its `modelConfigId`, or
 * the first config when the id is empty (DeepL included — an action may be
 * a translation). A set id whose config no longer exists gives null instead
 * of silently running on another model; no configs gives null too.
 * @returns {object | null}
 */
export function resolveActionConfig(configs, action) {
  if (!Array.isArray(configs) || !configs.length || !action) return null;
  if (action.modelConfigId) return configs.find(c => c?.id === action.modelConfigId) || null;
  return configs[0];
}

/**
 * Trailing-edge throttle: the first call arms a timer of `ms`; when it fires,
 * fn receives the latest argument. flush() fires now, cancel() drops it.
 * @returns {{ call(arg: any): void, flush(): void, cancel(): void }}
 */
export function createThrottle(fn, ms) {
  let timer = null;
  let hasPending = false;
  let pending;

  function fire() {
    timer = null;
    if (!hasPending) return;
    const arg = pending;
    hasPending = false;
    pending = undefined;
    fn(arg);
  }

  return {
    call(arg) {
      pending = arg;
      hasPending = true;
      if (timer === null) timer = setTimeout(fire, ms);
    },
    flush() {
      if (timer !== null) clearTimeout(timer);
      fire();
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      hasPending = false;
      pending = undefined;
    }
  };
}

/**
 * The next AI_CHUNK of a stream: the text the tab has not been sent yet
 * (`delta`) and where it starts (`offset`, equal to `sentLength`). Null
 * when there is nothing new, so empty chunks are never sent.
 * @param {number} sentLength  chars of `text` already sent to the tab
 * @param {string} text  accumulated answer so far
 * @returns {{ offset: number, delta: string } | null}
 */
export function nextChunk(sentLength, text) {
  if (typeof text !== 'string' || text.length <= sentLength) return null;
  return { offset: sentLength, delta: text.slice(sentLength) };
}

/**
 * Whether a failed AI call is worth retrying as-is: network/timeout/stream
 * failures (APIError status 0), rate limits (429) and server errors (5xx).
 * Auth/quota/other 4xx, config errors (plain Error), cancellations and
 * deterministic answers (`retryable: false` — budget spent on reasoning,
 * refusal) are not. Checks the shape instead of importing APIError.
 */
export function isRetryableError(err) {
  if (err?.name !== 'APIError' || typeof err.status !== 'number') return false;
  if (err.retryable === false) return false;
  return err.status === 0 || err.status === 429 || err.status >= 500;
}

/** Instructions behind the Shorter / Longer / Simpler buttons of the refine bar. */
export const REFINE_PRESETS = {
  shorter: 'Make it shorter. Return only the revised text.',
  longer: 'Expand it with more detail. Return only the revised text.',
  simpler: 'Rewrite it in simpler language. Return only the revised text.'
};

/**
 * Longest conversation history kept by a refine turn. The request sent to
 * the model is one longer (21 messages): the refine instruction is
 * appended as a final user turn.
 */
export const MAX_CONVERSATION_MESSAGES = 20;

const MAX_MESSAGE_CHARS = 100_000;

/**
 * Validate a conversation that came back from the content script: a
 * non-empty array of { role, content } starting with `user`, strictly
 * alternating and ending with `assistant`, each content a string of at most
 * 100 000 chars. Returns a copy with only role/content, trimmed to the first
 * pair plus the last 18 messages, or null when anything is off.
 * @returns {Array<{ role: 'user' | 'assistant', content: string }> | null}
 */
export function sanitizeConversation(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const out = [];
  for (let i = 0; i < value.length; i++) {
    const m = value[i];
    const expected = i % 2 ? 'assistant' : 'user';
    if (!m || typeof m !== 'object' || m.role !== expected) return null;
    if (typeof m.content !== 'string' || m.content.length > MAX_MESSAGE_CHARS) return null;
    out.push({ role: m.role, content: m.content });
  }
  if (out[out.length - 1].role !== 'assistant') return null;
  if (out.length <= MAX_CONVERSATION_MESSAGES) return out;
  // Even length on both sides keeps the user/assistant alternation
  return [...out.slice(0, 2), ...out.slice(-(MAX_CONVERSATION_MESSAGES - 2))];
}

/**
 * Messages for a refine turn. `instruction === null` is a Retry: the same
 * conversation without its last answer. Otherwise the instruction becomes
 * the next user turn.
 */
export function buildRefineMessages(conversation, instruction) {
  if (instruction === null) return conversation.slice(0, -1);
  return [...conversation, { role: 'user', content: instruction.trim() }];
}

/**
 * The instruction of a refine request: a preset key (`shorter` | `longer` |
 * `simpler`) wins, then a non-blank free-text follow-up (trimmed); neither
 * means Retry (null). Anything else throws 'Unknown refine option'.
 * @returns {string | null}
 */
export function resolveRefineInstruction({ preset, instruction } = {}) {
  if (preset !== undefined && preset !== null) {
    if (typeof preset === 'string' && Object.hasOwn(REFINE_PRESETS, preset)) return REFINE_PRESETS[preset];
    throw new Error('Unknown refine option');
  }
  if (instruction === undefined || instruction === null) return null;
  if (typeof instruction === 'string' && instruction.trim()) return instruction.trim();
  throw new Error('Unknown refine option');
}

/** A page-chosen run id echoed in AI_PROCESSING_START: a string of 1–64 chars, else null. */
export function sanitizeClientId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null;
}

/** User message for the free-form Ask flow: the question, then the quoted selection. */
export function buildAskPrompt(question, text) {
  // Same <text> fence as the default actions (the system prompt explains it)
  return `${question.trim()}\n\n${fenceText(text)}`;
}

/**
 * The "missing API key" message for a config without a key, or null. A
 * `custom` endpoint may run without a key (e.g. a local server).
 * @returns {string | null}
 */
export function missingApiKeyError(config) {
  if (config?.provider === 'custom' || config?.apiKey?.trim()) return null;
  return 'Missing API key. Please configure the API key in settings.';
}
