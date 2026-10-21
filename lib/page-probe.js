// The one function injected into pages to read the selection
// (chrome.scripting.executeScript). Used by the keyboard paths
// (getSelectionFromTab), the page-context placeholders (getPageContext) and
// the context-menu sensitive-field check in background.js.

/**
 * Data half of the selection rule, passed to probeSelection as `rules`
 * (the injected function cannot import anything).
 * - `textInputTypes`: <input> types whose selection is text;
 * - `sensitiveAutocompleteSource`: RegExp source (case-insensitive) for
 *   `autocomplete` values that mark a password or payment field.
 */
export const SELECTION_RULES = Object.freeze({
  textInputTypes: Object.freeze(['text', 'search', 'url', 'email', 'tel']),
  sensitiveAutocompleteSource: 'password|(?:^|\\s)cc-'
});

/**
 * Read the current selection in the page (or frame) it runs in.
 *
 * MUST stay self-contained: executeScript serializes this function, so it
 * may reference only its parameters and page globals (document, window) —
 * nothing from this module.
 *
 * - The focused element is found through open shadow roots.
 * - A focused <input type=password>, or an input/textarea whose
 *   `autocomplete` matches the sensitive rule, returns `sensitive: true`
 *   with no text. The decision uses attributes only; the value of such a
 *   field is never read.
 * - A text-capable control (textarea, input of a text type) with a
 *   non-empty selection returns that selection; with `withContext` its
 *   whole value is the block.
 * - Anything else (other controls, no control selection) falls through to
 *   window.getSelection(); with `withContext` the block is the selection's
 *   nearest paragraph-like ancestor and start/end are offsets in it.
 *
 * @param {{ textInputTypes: string[], sensitiveAutocompleteSource: string }} rules  SELECTION_RULES
 * @param {boolean} withContext  also compute blockText/start/end
 * @returns {{ text: string, editable: boolean, sensitive: boolean,
 *   blockText: string, start: number, end: number, title: string, url: string }}
 */
export function probeSelection(rules, withContext) {
  const title = String(document.title || '');
  const url = String((window.location && window.location.href) || '');
  const result = { text: '', editable: false, sensitive: false, blockText: '', start: 0, end: 0, title, url };

  // Focus inside an open shadow root is retargeted to its host — walk down
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;

  const tag = el && el.tagName ? String(el.tagName).toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    // Sensitivity from attributes only, before anything touches the value
    const type = tag === 'TEXTAREA' ? 'textarea' : String(el.type || el.getAttribute('type') || 'text').toLowerCase();
    const autocomplete = String(el.getAttribute('autocomplete') || '');
    if (type === 'password' || new RegExp(rules.sensitiveAutocompleteSource, 'i').test(autocomplete)) {
      result.sensitive = true;
      return result;
    }
    if (tag === 'TEXTAREA' || rules.textInputTypes.includes(type)) {
      let start = null;
      let end = null;
      try {
        start = el.selectionStart;
        end = el.selectionEnd;
      } catch { /* no text selection on this control */ }
      if (start != null && end != null && end > start) {
        const value = String(el.value || '');
        result.text = value.slice(start, end);
        result.editable = !el.readOnly && !el.disabled;
        if (withContext) {
          result.blockText = value;
          result.start = start;
          result.end = end;
        }
        return result;
      }
    }
  }

  const sel = window.getSelection ? window.getSelection() : null;
  result.text = sel ? String(sel.toString() || '') : '';
  result.editable = !!(el && el.isContentEditable);
  if (!withContext || !sel || !sel.rangeCount) return result;

  const range = sel.getRangeAt(0);
  if (!range || range.collapsed) return result;
  let node = range.commonAncestorContainer;
  if (node && node.nodeType !== 1) node = node.parentElement; // 1 = ELEMENT_NODE
  const block = (node && node.closest && node.closest('p,li,td,th,blockquote,pre,dd,article,section,div'))
    || document.body;
  if (!block) return result;
  const pre = document.createRange();
  pre.selectNodeContents(block);
  pre.setEnd(range.startContainer, range.startOffset);
  result.blockText = block.textContent || '';
  result.start = pre.toString().length;
  result.end = result.start + range.toString().length;
  return result;
}
