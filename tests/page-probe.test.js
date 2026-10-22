import test from 'node:test';
import assert from 'node:assert/strict';

import { probeSelection, SELECTION_RULES } from '../lib/page-probe.js';

// chrome.scripting.executeScript serializes the function source, so every
// test runs a copy rebuilt from that source: a reference to module scope
// would throw here exactly as it would in the page
const injected = new Function(`return (${probeSelection.toString()})`)();

const PAGE = { title: 'Doc title', url: 'https://example.com/doc' };

/** Minimal text control. Counts reads of .value so sensitivity can be shown to come first. */
function control({ tag = 'INPUT', type = 'text', autocomplete = null, value = '', start = null, end = null,
  readOnly = false, disabled = false, selectionThrows = false } = {}) {
  const attrs = { type: tag === 'INPUT' ? type : null, autocomplete };
  const el = {
    tagName: tag,
    type: tag === 'INPUT' ? type : 'textarea',
    readOnly,
    disabled,
    isContentEditable: false,
    valueReads: 0,
    getAttribute: (name) => attrs[name] ?? null
  };
  Object.defineProperty(el, 'value', { get() { el.valueReads++; return value; } });
  for (const [key, v] of [['selectionStart', start], ['selectionEnd', end]]) {
    Object.defineProperty(el, key, {
      get() {
        if (selectionThrows) throw new Error('InvalidStateError');
        return v;
      }
    });
  }
  return el;
}

/** A block element holding one text node, with a selected range at [start, end). */
function pageSelection(blockText, start, end) {
  const block = { nodeType: 1, textContent: blockText, closest: () => block };
  const textNode = { nodeType: 3, parentElement: block };
  const range = {
    collapsed: end <= start,
    commonAncestorContainer: textNode,
    startContainer: textNode,
    startOffset: start,
    toString: () => blockText.slice(start, end)
  };
  const selection = {
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => blockText.slice(start, end)
  };
  return { block, selection };
}

function withPage(t, { activeElement = null, selection = null, body = null } = {}) {
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = {
    title: PAGE.title,
    activeElement,
    body,
    // Single-text-node blocks: the prefix is the block text up to the offset
    createRange: () => ({
      selectNodeContents(node) { this.node = node; },
      setEnd(_container, offset) { this.offset = offset; },
      toString() { return this.node.textContent.slice(0, this.offset); }
    })
  };
  globalThis.window = {
    location: { href: PAGE.url },
    getSelection: () => selection
  };
  t.after(() => {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
  });
}

test('SELECTION_RULES pins the text input types and the sensitive autocomplete rule', () => {
  assert.deepEqual(SELECTION_RULES.textInputTypes, ['text', 'search', 'url', 'email', 'tel']);
  const re = new RegExp(SELECTION_RULES.sensitiveAutocompleteSource, 'i');
  for (const value of ['current-password', 'new-password', 'cc-number', 'cc-csc', 'billing cc-exp', 'section-pay CC-NAME'])
    assert.equal(re.test(value), true, value);
  for (const value of ['', 'email', 'username', 'one-time-code', 'occ-number', 'name'])
    assert.equal(re.test(value), false, value);
});

test('the probe is self-contained (runs from its serialized source)', (t) => {
  withPage(t, { selection: { rangeCount: 0, toString: () => '' } });
  assert.doesNotThrow(() => injected(SELECTION_RULES, true));
});

test('a password input is sensitive and its value is never read', (t) => {
  const pw = control({ type: 'password', value: 'hunter2', start: 0, end: 7 });
  withPage(t, { activeElement: pw });
  for (const withContext of [false, true]) {
    const r = injected(SELECTION_RULES, withContext);
    assert.equal(r.sensitive, true);
    assert.equal(r.text, '');
    assert.equal(r.blockText, '');
  }
  assert.equal(pw.valueReads, 0);
});

test('autocomplete cc-number and *-password fields are sensitive, textarea too', (t) => {
  for (const el of [
    control({ type: 'text', autocomplete: 'cc-number', value: '4111111111111111', start: 0, end: 16 }),
    control({ type: 'tel', autocomplete: 'billing cc-csc', value: '123', start: 0, end: 3 }),
    control({ type: 'text', autocomplete: 'current-password', value: 'pw', start: 0, end: 2 }),
    control({ tag: 'TEXTAREA', autocomplete: 'cc-number', value: '4111', start: 0, end: 4 })
  ]) {
    withPage(t, { activeElement: el });
    const r = injected(SELECTION_RULES, true);
    assert.equal(r.sensitive, true, el.getAttribute('autocomplete'));
    assert.equal(r.text, '');
    assert.equal(el.valueReads, 0);
  }
});

test('a text input with a selection returns that selection and its context', (t) => {
  const el = control({ type: 'search', value: 'find the needle here', start: 9, end: 15 });
  withPage(t, { activeElement: el });
  assert.deepEqual(injected(SELECTION_RULES, false), {
    text: 'needle', editable: true, sensitive: false, inspected: true, blockText: '', start: 0, end: 0, ...PAGE
  });
  assert.deepEqual(injected(SELECTION_RULES, true), {
    text: 'needle', editable: true, sensitive: false, inspected: true, blockText: 'find the needle here', start: 9, end: 15, ...PAGE
  });
});

test('a read-only textarea selection is not editable', (t) => {
  const el = control({ tag: 'TEXTAREA', value: 'abc def', start: 4, end: 7, readOnly: true });
  withPage(t, { activeElement: el });
  const r = injected(SELECTION_RULES, false);
  assert.equal(r.text, 'def');
  assert.equal(r.editable, false);
});

test('a focused checkbox falls through to the page selection', (t) => {
  const { block, selection } = pageSelection('Alpha beta gamma', 6, 10);
  withPage(t, { activeElement: control({ type: 'checkbox' }), selection, body: block });
  const r = injected(SELECTION_RULES, true);
  assert.equal(r.text, 'beta');
  assert.equal(r.sensitive, false);
  assert.equal(r.editable, false);
  assert.equal(r.blockText, 'Alpha beta gamma');
  assert.deepEqual([r.start, r.end], [6, 10]);
});

test('a number input (selection API throws) falls through to the page selection', (t) => {
  const { selection } = pageSelection('Total 42 items', 6, 8);
  withPage(t, { activeElement: control({ type: 'number', selectionThrows: true }), selection });
  assert.equal(injected(SELECTION_RULES, false).text, '42');
});

test('a text input without a selection falls through to the page selection', (t) => {
  const { selection } = pageSelection('Some page text', 5, 9);
  withPage(t, { activeElement: control({ type: 'text', value: 'typed', start: 2, end: 2 }), selection });
  assert.equal(injected(SELECTION_RULES, false).text, 'page');
});

test('focus inside open shadow roots is followed to the real element', (t) => {
  const inner = control({ tag: 'TEXTAREA', value: 'shadow text body', start: 7, end: 11 });
  const mid = { tagName: 'MY-FIELD', shadowRoot: { activeElement: inner } };
  const host = { tagName: 'MY-EDITOR', shadowRoot: { activeElement: mid } };
  withPage(t, { activeElement: host });
  const r = injected(SELECTION_RULES, false);
  assert.equal(r.text, 'text');
  assert.equal(r.editable, true);

  const pw = control({ type: 'password', value: 'secret', start: 0, end: 6 });
  withPage(t, { activeElement: { tagName: 'LOGIN-FORM', shadowRoot: { activeElement: pw } } });
  assert.equal(injected(SELECTION_RULES, false).sensitive, true);
  assert.equal(pw.valueReads, 0);
});

test('context offsets point at the selected occurrence of repeated text', (t) => {
  const text = 'Repeated word here, repeated word there.';
  const second = text.indexOf('repeated');
  const { block, selection } = pageSelection(text, second, second + 'repeated'.length);
  withPage(t, { activeElement: { tagName: 'BODY', isContentEditable: false }, selection, body: block });
  const r = injected(SELECTION_RULES, true);
  assert.equal(r.text, 'repeated');
  assert.deepEqual([r.start, r.end], [20, 28]);
  assert.equal(r.blockText.slice(r.start, r.end), 'repeated');
});

test('a contenteditable selection is editable; no selection gives empty text', (t) => {
  const { selection } = pageSelection('edit me', 0, 4);
  withPage(t, { activeElement: { tagName: 'DIV', isContentEditable: true }, selection });
  const r = injected(SELECTION_RULES, false);
  assert.equal(r.text, 'edit');
  assert.equal(r.editable, true);

  withPage(t, { activeElement: null, selection: null });
  assert.deepEqual(injected(SELECTION_RULES, true), {
    text: '', editable: false, sensitive: false, inspected: false, blockText: '', start: 0, end: 0, ...PAGE
  });
});

// A sensitive field blocks only when it holds the selection
test('a focused password field without a selection falls through to the page selection', (t) => {
  const { block, selection } = pageSelection('Alpha beta gamma', 6, 10);
  const pw = control({ type: 'password', value: 'hunter2', start: 3, end: 3 });
  withPage(t, { activeElement: pw, selection, body: block });
  const r = injected(SELECTION_RULES, true);
  assert.equal(r.sensitive, false);
  assert.equal(r.text, 'beta');
  assert.equal(r.blockText, 'Alpha beta gamma');
  assert.equal(pw.valueReads, 0);
});

test('a focused cc field with a collapsed caret and no page selection is not sensitive', (t) => {
  const cc = control({ type: 'text', autocomplete: 'cc-number', value: '4111', start: 0, end: 0 });
  withPage(t, { activeElement: cc, selection: { rangeCount: 0, toString: () => '' } });
  const r = injected(SELECTION_RULES, false);
  assert.equal(r.sensitive, false);
  assert.equal(r.text, '');
  assert.equal(cc.valueReads, 0);
});

test('unreadable offsets on a sensitive field block only when the page selection is empty', (t) => {
  const pw = control({ type: 'password', value: 'hunter2', selectionThrows: true });
  withPage(t, { activeElement: pw, selection: { rangeCount: 0, toString: () => '' } });
  assert.equal(injected(SELECTION_RULES, false).sensitive, true);

  const nullOffsets = control({ type: 'text', autocomplete: 'new-password', value: 'x' });
  withPage(t, { activeElement: nullOffsets, selection: null });
  assert.equal(injected(SELECTION_RULES, false).sensitive, true);

  const { selection } = pageSelection('Some page text', 5, 9);
  withPage(t, { activeElement: pw, selection });
  const r = injected(SELECTION_RULES, false);
  assert.equal(r.sensitive, false);
  assert.equal(r.text, 'page');
  assert.equal(pw.valueReads + nullOffsets.valueReads, 0);
});

// `inspected`: the probe actually reached the editable element (closed shadow
// roots stop the focus walk at their host)
test('a focused custom-element host without an open shadowRoot is not inspected', (t) => {
  const { selection } = pageSelection('', 0, 0);
  for (const host of [
    { tagName: 'SECURE-INPUT', shadowRoot: null, isContentEditable: false },
    { tagName: 'SECURE-INPUT', isContentEditable: false }
  ]) {
    withPage(t, { activeElement: host, selection });
    const r = injected(SELECTION_RULES, false);
    assert.equal(r.inspected, false);
    assert.equal(r.sensitive, false);
  }
});

test('text controls, contenteditable and fields inside open shadow roots are inspected', (t) => {
  const { selection } = pageSelection('edit me', 0, 4);
  const cases = [
    control({ type: 'text', value: 'abc', start: 0, end: 1 }),
    control({ type: 'checkbox' }),
    control({ type: 'password', value: 'pw', start: 0, end: 2 }),
    control({ tag: 'TEXTAREA', value: 'x', start: 0, end: 0 }),
    { tagName: 'DIV', isContentEditable: true },
    { tagName: 'MY-EDITOR', shadowRoot: { activeElement: control({ type: 'text', value: 'in', start: 0, end: 2 }) } }
  ];
  for (const el of cases) {
    withPage(t, { activeElement: el, selection });
    assert.equal(injected(SELECTION_RULES, false).inspected, true, el.tagName);
  }
  withPage(t, { activeElement: { tagName: 'BODY', isContentEditable: false }, selection });
  assert.equal(injected(SELECTION_RULES, false).inspected, false);
});

// ── Short blocks grow with their sibling text blocks ──────────────────

/** Sibling element stub: `visible` false = no client rects (display:none). */
function sib(tagName, textContent, visible = true) {
  return { nodeType: 1, tagName, textContent, getClientRects: () => (visible ? [{}] : []) };
}

/** Gives `core` the siblings `before` (nearest last) and `after` (nearest first). */
function chain(core, before, after) {
  const all = [...before, core, ...after];
  all.forEach((el, i) => {
    el.previousElementSibling = all[i - 1] || null;
    el.nextElementSibling = all[i + 1] || null;
  });
}

function shortParagraph(t, text, start, end, before, after) {
  const { block, selection } = pageSelection(text, start, end);
  Object.assign(block, { tagName: 'P', getClientRects: () => [{}] });
  chain(block, before, after);
  withPage(t, { activeElement: { tagName: 'BODY', isContentEditable: false }, selection, body: block });
  return injected(SELECTION_RULES, true);
}

test('a short paragraph takes in neighbouring text blocks, nearest first', (t) => {
  const core = 'It is possible to fine-tune quantized models.';
  const r = shortParagraph(t, core, 6, 14,
    [sib('P', '  Earlier paragraph about quantization.  '), sib('FIGURE', 'Figure caption noise')],
    [sib('UL', 'nav'), sib('LI', 'A list item that follows.'), sib('P', 'Hidden text', false), sib('BLOCKQUOTE', 'A quote.')]);
  assert.equal(r.blockText, [
    'Earlier paragraph about quantization.', core, 'A list item that follows.', 'A quote.'
  ].join('\n\n'));
  assert.equal(r.blockText.slice(r.start, r.end), 'possible');
  assert.equal(r.text, 'possible');
});

test('a heading ends the walk in its direction', (t) => {
  const core = 'Short core text.';
  const r = shortParagraph(t, core, 0, 5,
    [sib('P', 'Previous section text.'), sib('H2', 'Section title')],
    [sib('P', 'Next paragraph.'), sib('H3', 'Next section'), sib('P', 'Beyond the heading.')]);
  assert.equal(r.blockText, `${core}\n\nNext paragraph.`);
  assert.deepEqual([r.start, r.end], [0, 5]);
});

test('a block of 600+ characters is not expanded', (t) => {
  const core = 'x'.repeat(650);
  const r = shortParagraph(t, core, 10, 20, [sib('P', 'before')], [sib('P', 'after')]);
  assert.equal(r.blockText, core);
  assert.deepEqual([r.start, r.end], [10, 20]);
});

test('expansion stops once about 1500 characters are gathered', (t) => {
  const para = n => sib('P', String(n).repeat(400));
  const r = shortParagraph(t, 'core text', 0, 4, [para(1), para(2), para(3)], [para(4), para(5), para(6)]);
  const parts = r.blockText.split('\n\n');
  // core + next + previous + next + previous would pass 1500 at the fourth block
  assert.equal(parts.length, 5);
  assert.ok(r.blockText.length >= 1500 && r.blockText.length < 2000);
  assert.equal(r.blockText.slice(r.start, r.end), 'core');
});

test('only paragraph-like blocks grow (a div or table cell stays as is)', (t) => {
  const { block, selection } = pageSelection('cell text', 0, 4);
  Object.assign(block, { tagName: 'TD', getClientRects: () => [{}] });
  chain(block, [sib('TD', 'left')], [sib('TD', 'right')]);
  withPage(t, { activeElement: { tagName: 'BODY', isContentEditable: false }, selection, body: block });
  assert.equal(injected(SELECTION_RULES, true).blockText, 'cell text');
});
