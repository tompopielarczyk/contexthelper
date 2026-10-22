import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDeepLLanguageLoader,
  newTargetLangState,
  syncTargetLangState,
  invalidateTargetLangState
} from '../lib/deepl-languages.js';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const FALLBACK = [{ id: 'PL', name: 'Polish' }];
const LIVE_A = [{ id: 'DE', name: 'German' }];
const LIVE_B = [{ id: 'FR', name: 'French' }];

// A loader whose live fetches are deferred, one per call, keyed by API key
function setup({ cached = {} } = {}) {
  const fetches = [];
  const load = createDeepLLanguageLoader({
    readCached: async (key) => cached[key] || null,
    fetchLive: (key) => {
      const d = deferred();
      fetches.push({ key, ...d });
      return d.promise;
    }
  });
  const renders = [];
  const deps = { load, render: (list) => renders.push(list), fallback: FALLBACK };
  return { fetches, load, renders, deps };
}

// ── Loader ──

test('loader: one live fetch per key, shared by every caller', async () => {
  const { fetches, load } = setup();
  const a1 = load('a');
  const a2 = load('a');
  assert.equal(a1, a2);
  assert.equal(fetches.length, 1);
  fetches[0].resolve(LIVE_A);
  assert.deepEqual(await a1.live, LIVE_A);
  load('a');
  assert.equal(fetches.length, 1);
});

test('loader: a failed fetch resolves null and is dropped, so the key retries', async () => {
  const { fetches, load } = setup();
  const first = load('a');
  fetches[0].reject(new Error('net'));
  assert.equal(await first.live, null);
  load('a');
  assert.equal(fetches.length, 2);
});

test('loader: an empty list counts as a failure (dropped, retried)', async () => {
  const { fetches, load } = setup();
  const first = load('a');
  fetches[0].resolve([]);
  assert.equal(await first.live, null);
  load('a');
  assert.equal(fetches.length, 2);
});

test('loader: the cached list resolves separately, null when absent or empty', async () => {
  const { load } = setup({ cached: { a: LIVE_A, e: [] } });
  assert.deepEqual(await load('a').cached, LIVE_A);
  assert.equal(await load('e').cached, null);
  assert.equal(await load('none').cached, null);
});

// ── Card sync ──

test('sync: fallback at once, then the live list', async () => {
  const { fetches, renders, deps } = setup();
  const state = newTargetLangState('EN-US');
  syncTargetLangState(state, 'a', deps);
  assert.deepEqual(renders, [FALLBACK]);
  fetches[0].resolve(LIVE_A);
  await flush();
  assert.deepEqual(renders, [FALLBACK, LIVE_A]);
});

test('sync: the same key again does nothing (no reload, no re-render)', async () => {
  const { fetches, renders, deps } = setup();
  const state = newTargetLangState('');
  syncTargetLangState(state, 'a', deps);
  fetches[0].resolve(LIVE_A);
  await flush();
  syncTargetLangState(state, ' a ', deps);
  assert.equal(fetches.length, 1);
  assert.equal(renders.length, 2);
});

test('sync: no key renders the fallback only', () => {
  const { fetches, renders, deps } = setup();
  syncTargetLangState(newTargetLangState(''), '', deps);
  assert.deepEqual(renders, [FALLBACK]);
  assert.equal(fetches.length, 0);
});

test('sync: a cached list shows before the live one, never after it', async () => {
  const { fetches, renders, deps } = setup({ cached: { a: LIVE_B } });
  const state = newTargetLangState('');
  syncTargetLangState(state, 'a', deps);
  await flush();
  assert.deepEqual(renders, [FALLBACK, LIVE_B]);
  fetches[0].resolve(LIVE_A);
  await flush();
  assert.deepEqual(renders.at(-1), LIVE_A);
});

test('sync: a failed load resets the identity, so the next sync with the same key retries', async () => {
  const { fetches, renders, deps } = setup();
  const state = newTargetLangState('');
  syncTargetLangState(state, 'a', deps);
  fetches[0].reject(new Error('net'));
  await flush();
  assert.equal(state.identity, null);
  syncTargetLangState(state, 'a', deps);
  assert.equal(fetches.length, 2);
  fetches[1].resolve(LIVE_A);
  await flush();
  assert.deepEqual(renders.at(-1), LIVE_A);
});

test('sync: an empty live list also lets the same key retry', async () => {
  const { fetches, deps } = setup();
  const state = newTargetLangState('');
  syncTargetLangState(state, 'a', deps);
  fetches[0].resolve([]);
  await flush();
  syncTargetLangState(state, 'a', deps);
  assert.equal(fetches.length, 2);
});

test('invalidate: a load in flight for the old key never renders (key edit during the debounce)', async () => {
  const { fetches, renders, deps } = setup();
  const state = newTargetLangState('');
  syncTargetLangState(state, 'a', deps);
  invalidateTargetLangState(state); // user types key B; the refetch is still debounced
  fetches[0].resolve(LIVE_A);
  await flush();
  assert.deepEqual(renders, [FALLBACK]);
  syncTargetLangState(state, 'b', deps); // debounce fired
  fetches[1].resolve(LIVE_B);
  await flush();
  assert.deepEqual(renders.at(-1), LIVE_B);
  assert.ok(!renders.includes(LIVE_A));
});

test('invalidate: a late failure of the old load does not reset the new identity', async () => {
  const { fetches, deps } = setup();
  const state = newTargetLangState('');
  syncTargetLangState(state, 'a', deps);
  invalidateTargetLangState(state);
  syncTargetLangState(state, 'b', deps);
  fetches[0].reject(new Error('net'));
  await flush();
  assert.equal(state.identity, 'b');
});

test('invalidate then the same key: reuses the finished load, no new fetch', async () => {
  const { fetches, renders, deps } = setup();
  const state = newTargetLangState('');
  syncTargetLangState(state, 'a', deps);
  fetches[0].resolve(LIVE_A);
  await flush();
  invalidateTargetLangState(state); // e.g. the action switched to an LLM config and back
  syncTargetLangState(state, 'a', deps);
  await flush();
  assert.equal(fetches.length, 1);
  assert.deepEqual(renders.at(-1), LIVE_A);
});
