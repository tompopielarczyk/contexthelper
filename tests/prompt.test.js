import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTION_PLACEHOLDERS, renderActionPrompt, templateUsesPageContext, windowAround, sanitizePageVars, collapseWhitespace } from '../lib/prompt.js';

test('ACTION_PLACEHOLDERS lists the action placeholders', () => {
  assert.deepEqual(ACTION_PLACEHOLDERS, ['text', 'context', 'pageTitle', 'pageUrl']);
});

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
  assert.equal(templateUsesPageContext('{{context}}'), true);
  assert.equal(templateUsesPageContext('{{pageTitle}}'), true);
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

test('windowAround near the end keeps selection and only marks the cut side', () => {
  const text = 'a'.repeat(500) + 'END';
  const out = windowAround(text, 500, 503, 100);
  assert.ok(out.endsWith('END'));
  assert.ok(out.startsWith('…'));
  assert.ok(out.length <= 101);
});

test('sanitizePageVars accepts an object of strings, rejects anything else', () => {
  const ok = { context: 'c', pageTitle: 'T', pageUrl: 'https://u' };
  assert.deepEqual(sanitizePageVars(ok), ok);
  assert.deepEqual(sanitizePageVars({ ...ok, text: 'smuggled', extra: 1 }), ok);
  assert.equal(sanitizePageVars(null), null);
  assert.equal(sanitizePageVars('x'), null);
  assert.equal(sanitizePageVars([]), null);
  assert.equal(sanitizePageVars({ context: 'c', pageTitle: 5, pageUrl: 'u' }), null);
  assert.equal(sanitizePageVars({ context: 'c', pageTitle: 'T' }), null);
});

test('collapseWhitespace squeezes runs, keeps paragraph breaks and remaps the offsets', () => {
  const text = '  Alpha\t\tbeta\n  gamma\n\n\n   delta   epsilon  ';
  const start = text.indexOf('gamma'), end = text.indexOf('epsilon') + 'epsilon'.length;
  const r = collapseWhitespace(text, start, end);
  assert.equal(r.text, 'Alpha beta gamma\n\ndelta epsilon');
  assert.equal(r.text.slice(r.start, r.end), 'gamma\n\ndelta epsilon');
});

test('collapseWhitespace clamps offsets that fall inside removed whitespace', () => {
  const r = collapseWhitespace('a   b', 2, 3);
  assert.equal(r.text, 'a b');
  assert.ok(r.start <= r.end && r.end <= r.text.length);
});
