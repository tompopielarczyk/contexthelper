// DeepL target-language loading for the options page's action cards,
// DOM-free so the race rules can be tested: one load per key per page,
// shared across cards, and per-card guards against superseded loads.

// A failed key is not refetched by routine syncs for this long; explicit
// retries (key edit, successful DeepL Test) pass `force`
export const FAILURE_COOLDOWN_MS = 30_000;

const nonEmptyList =(list) => (Array.isArray(list) && list.length > 0 ? list : null);

/**
 * One load per DeepL key: `cached` resolves to the cached list (or null),
 * `live` to the API's list (or null). A failed or empty live load is dropped
 * from the memo (if it is still the key's load), so the next request for that
 * key fetches again; a successful one is reused for the page's lifetime.
 * @param {{
 *   readCached: (apiKey: string) => Promise<Array<{ id: string, name: string }> | null>,
 *   fetchLive: (apiKey: string) => Promise<Array<{ id: string, name: string }>>
 * }} io
 * @returns {(apiKey: string) => { cached: Promise<any[] | null>, live: Promise<any[] | null> }}
 */
export function createDeepLLanguageLoader({ readCached, fetchLive, now = Date.now, cooldownMs = FAILURE_COOLDOWN_MS }) {
  const loads = new Map();
  // apiKey → when its last live load failed (a key that keeps failing, e.g.
  // 403, is not refetched by every routine sync)
  const failedAt = new Map();
  return function load(apiKey, { force = false } = {}) {
    const existing = loads.get(apiKey);
    if (existing) return existing;
    const lastFailure = failedAt.get(apiKey);
    if (!force && lastFailure !== undefined && now() - lastFailure < cooldownMs) {
      // Within the cooldown: the cached list only, no request, nothing memoized
      return { cached: Promise.resolve().then(() => readCached(apiKey)).then(nonEmptyList, () => null), live: Promise.resolve(null) };
    }
    // Both start now (a synchronous throw becomes a rejection)
    const start = (fn) => {
      try {
        return Promise.resolve(fn(apiKey));
      } catch (err) {
        return Promise.reject(err);
      }
    };
    const entry = {};
    entry.cached = start(readCached).then(nonEmptyList, () => null);
    entry.live = start(fetchLive)
      .then(nonEmptyList, () => null)
      .then((list) => {
        if (list) {
          failedAt.delete(apiKey);
        } else {
          failedAt.set(apiKey, now());
          if (loads.get(apiKey) === entry) loads.delete(apiKey);
        }
        return list;
      });
    loads.set(apiKey, entry);
    return entry;
  };
}

/**
 * Per-card state: `saved` is the stored targetLang, `identity` the DeepL key
 * whose list the select shows or is loading (null = none, the next sync
 * loads), `seq` drops superseded loads.
 * @param {string} saved
 */
export function newTargetLangState(saved) {
  return { saved: saved || '', identity: null, seq: 0 };
}

/**
 * Show `apiKey`'s languages in a card: the fallback at once, then the cached
 * list, then the live one. Does nothing when the card already shows (or
 * loads) this key. A cached list never replaces the live one; a superseded
 * load never renders; a failed or empty load resets the identity, so the
 * next sync with the same key tries again.
 * @param {{ identity: string | null, seq: number }} state
 * @param {string} apiKey
 * @param {{ load: Function, render: (list: any[]) => void, fallback: any[] }} deps
 */
export function syncTargetLangState(state, apiKey, { load, render, fallback }, { force = false } = {}) {
  const identity = String(apiKey ?? '').trim();
  if (state.identity === identity) return;
  state.identity = identity;
  const seq = ++state.seq;
  const isCurrent = () => state.seq === seq;
  render(fallback);
  if (!identity) return;
  const { cached, live } = load(identity, { force });
  let liveShown = false;
  cached.then((list) => {
    if (list && isCurrent() && !liveShown) render(list);
  });
  live.then((list) => {
    if (!isCurrent()) return;
    if (!list) {
      state.identity = null;
      return;
    }
    liveShown = true;
    render(list);
  });
}

/**
 * Drop the card's pending loads and forget its key (DeepL key edit, a switch
 * to a non-DeepL config): no in-flight callback renders any more, and the next
 * sync loads again (a finished load of the same key is reused, not refetched).
 * @param {{ identity: string | null, seq: number }} state
 */
export function invalidateTargetLangState(state) {
  state.seq++;
  state.identity = null;
}
