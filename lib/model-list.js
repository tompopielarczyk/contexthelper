// Pure helpers for the model lists on the options page

/**
 * Should the model field warn that `value` is not a known model?
 * Only a list the provider returned for this key (`'live'` this session, or
 * `'cache'` from an earlier fetch) can tell — the built-in fallback is short
 * and dated, so it never warns. A model the Test button just confirmed
 * (`verified`) never warns either.
 * @param {string} value
 * @param {string[]} ids
 * @param {'builtin' | 'cache' | 'live'} listSource
 * @param {boolean} verified
 * @returns {boolean}
 */
export function shouldWarnUnknownModel(value, ids, listSource, verified) {
  const id = String(value ?? '').trim();
  if (!id || verified) return false;
  if (listSource !== 'live' && listSource !== 'cache') return false;
  if (!Array.isArray(ids) || ids.length === 0) return false;
  return !ids.includes(id);
}

/**
 * Key of a model list in the `modelListCache`: `<provider>:<fingerprint>`
 * (each API key may see different models), the bare `openrouter` (public
 * list) and `custom:<baseUrl>` for a keyless endpoint or
 * `custom:<baseUrl>:<fingerprint>` with a key (`baseUrl` already normalized).
 * Returns null when there is nothing to cache (DeepL, missing fingerprint or base URL).
 * @param {string} provider
 * @param {string} fingerprint
 * @param {string} [baseUrl]
 * @returns {string | null}
 */
export function modelCacheKey(provider, fingerprint, baseUrl) {
  if (provider === 'deepl') return null;
  if (provider === 'openrouter') return 'openrouter';
  if (provider === 'custom') {
    if (!baseUrl) return null;
    return fingerprint ? `custom:${baseUrl}:${fingerprint}` : `custom:${baseUrl}`;
  }
  return fingerprint ? `${provider}:${fingerprint}` : null;
}

/**
 * Short, non-reversible tag of an API key: the first 12 hex characters of
 * its SHA-256 — the cache never stores the key itself.
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
export async function keyFingerprint(apiKey) {
  const bytes = new TextEncoder().encode(String(apiKey ?? ''));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest).slice(0, 6), b => b.toString(16).padStart(2, '0')).join('');
}
