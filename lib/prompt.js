/**
 * Action prompt rendering: placeholders available in text-action templates.
 * Pure module — no chrome.* APIs.
 */

export const ACTION_PLACEHOLDERS = ['text', 'context', 'pageTitle', 'pageUrl'];

const PAGE_VAR_NAMES = ACTION_PLACEHOLDERS.filter(name => name !== 'text');
const PLACEHOLDER_RE = new RegExp(`\\{\\{(${ACTION_PLACEHOLDERS.join('|')})\\}\\}`, 'g');
const PAGE_CONTEXT_RE = new RegExp(`\\{\\{(${PAGE_VAR_NAMES.join('|')})\\}\\}`);

/**
 * Substitutes action placeholders in a single pass. A function replacer keeps
 * values literal (`$&`, `$1` are not expanded) and inserted values are never
 * re-scanned, so a selection containing `{{context}}` stays as typed.
 * Missing vars render as ''; unknown `{{x}}` tokens pass through untouched.
 * @param {string} template
 * @param {{ text?: string, context?: string, pageTitle?: string, pageUrl?: string }} vars
 * @returns {string}
 */
export function renderActionPrompt(template, vars = {}) {
  return String(template ?? '').replace(PLACEHOLDER_RE, (_, name) => {
    const value = vars[name];
    return value == null ? '' : String(value);
  });
}

/**
 * True when the template needs the page (surrounding paragraph, title or URL).
 * @param {string} template
 * @returns {boolean}
 */
export function templateUsesPageContext(template) {
  return PAGE_CONTEXT_RE.test(String(template ?? ''));
}

/**
 * Validates page vars carried in a retry spec (round-tripped through the
 * content script): an object with a string for every page placeholder.
 * Returns a clean copy with only those keys, or null.
 * @param {unknown} vars
 * @returns {{ context: string, pageTitle: string, pageUrl: string } | null}
 */
export function sanitizePageVars(vars) {
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return null;
  const clean = {};
  for (const name of PAGE_VAR_NAMES) {
    if (typeof vars[name] !== 'string') return null;
    clean[name] = vars[name];
  }
  return clean;
}

/**
 * A window of at most `max` chars around the selection `[start, end)`,
 * centred on it, with `…` marking each side that was cut.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {number} [max=2000]
 * @returns {string}
 */
export function windowAround(text, start, end, max = 2000) {
  const str = String(text ?? '');
  if (str.length <= max) return str;
  const s = Math.max(0, Math.min(start, str.length));
  const e = Math.max(s, Math.min(end, str.length));
  if (e - s > max) return str.slice(s, e);

  const budget = max - (e - s);
  let from = s - Math.floor(budget / 2);
  let to = e + (budget - Math.floor(budget / 2));
  if (from < 0) { to -= from; from = 0; }
  if (to > str.length) { from -= to - str.length; to = str.length; }
  from = Math.max(0, from);

  return (from > 0 ? '…' : '') + str.slice(from, to) + (to < str.length ? '…' : '');
}
