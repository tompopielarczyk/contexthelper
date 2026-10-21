// Pure helpers shared by the chat runner in background.js (no chrome.* here —
// unit tested under node).

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
 * Whether a failed AI call is worth retrying as-is: network/timeout/stream
 * failures (APIError status 0), rate limits (429) and server errors (5xx).
 * Auth/quota/other 4xx, config errors (plain Error) and cancellations are not.
 * Checks the shape instead of importing APIError.
 */
export function isRetryableError(err) {
  if (err?.name !== 'APIError' || typeof err.status !== 'number') return false;
  return err.status === 0 || err.status === 429 || err.status >= 500;
}
