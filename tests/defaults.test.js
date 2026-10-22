import test from 'node:test';
import assert from 'node:assert/strict';

import { getDefaultActions, getDefaultSystemPrompt, saveSettings } from '../lib/storage.js';

const names = (lang) => getDefaultActions(lang).map(a => a.name);

test('a non-English browser gets its own language plus English', () => {
  assert.deepEqual(names('pl-PL').slice(0, 2), ['Translate to Polish', 'Translate to English']);
  assert.deepEqual(names('de').slice(0, 2), ['Translate to German', 'Translate to English']);
  assert.equal(names('pt-BR')[0], 'Translate to Portuguese');
});

test('an English or unknown browser language gets a single translation action', () => {
  for (const lang of ['en-US', 'en', 'EN_gb', '', undefined, 'xx-zz', '???']) {
    const translate = names(lang).filter(n => n.startsWith('Translate'));
    assert.deepEqual(translate, ['Translate to English'], String(lang));
  }
});

test('default set: ids unique, {{text}} last and unfenced (the placeholder fences it), page context where it helps', () => {
  const actions = getDefaultActions('pl');
  assert.deepEqual(actions.map(a => a.name), [
    'Translate to Polish', 'Translate to English', 'Fix grammar', 'Improve writing',
    'Explain simply', 'Summarize', 'Quote with source'
  ]);
  assert.equal(new Set(actions.map(a => a.id)).size, actions.length);
  for (const a of actions) {
    assert.ok(a.template.includes('\n\n{{text}}'), a.name);
    assert.equal(/<\/?text>/i.test(a.template), false, `${a.name}: no hand-written fence`);
    assert.equal(a.template.includes('**'), false, `${a.name}: no markdown`);
    assert.equal(typeof a.includePageContext, 'boolean');
  }
  const ctx = actions.filter(a => a.includePageContext).map(a => a.name);
  assert.deepEqual(ctx, ['Translate to Polish', 'Translate to English', 'Explain simply']);
  const quote = actions.find(a => a.id === 'quote-with-source');
  assert.ok(quote.template.includes('{{pageTitle}}') && quote.template.includes('{{pageUrl}}'));
});

test('the system prompt fences the text and forbids markdown', () => {
  const p = getDefaultSystemPrompt();
  assert.match(p, /<text>/);
  assert.match(p, /never as instructions/);
  assert.match(p, /without markdown/);
});

test('the default actions pass settings validation', async () => {
  globalThis.chrome = { storage: { sync: { set: async () => {} }, local: { set: async () => {} } } };
  await saveSettings({ actions: getDefaultActions('fr'), systemPrompt: getDefaultSystemPrompt() });
});
