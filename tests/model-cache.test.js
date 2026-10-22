import test from 'node:test';
import assert from 'node:assert/strict';

import { getCachedModelList, setCachedModelList, updateModelListCache } from '../lib/storage.js';

const DAY = 24 * 60 * 60 * 1000;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// Stateful chrome.storage.local whose get/set yield to the event loop, so
// unserialized read-modify-write cycles would interleave and lose writes
function installLocalStorage(initial = {}) {
  const store = structuredClone(initial);
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => { await tick(); return key in store ? { [key]: structuredClone(store[key]) } : {}; },
        set: async (payload) => { await tick(); Object.assign(store, structuredClone(payload)); }
      }
    }
  };
  return store;
}

const models = (...ids) => ids.map(id => ({ id, name: id }));

test('set then get returns the list, fresh', async () => {
  installLocalStorage();
  await setCachedModelList('anthropic:abc', models('a', 'b'));
  const cached = await getCachedModelList('anthropic:abc');
  assert.deepEqual(cached.models, models('a', 'b'));
  assert.equal(cached.stale, false);
  assert.equal(await getCachedModelList('anthropic:other'), null);
});

test('a list older than 24 h reads as stale', async () => {
  installLocalStorage({ modelListCache: { openrouter: { models: models('x'), fetchedAt: Date.now() - 2 * DAY } } });
  assert.equal((await getCachedModelList('openrouter')).stale, true);
});

test('interleaved writes all land (serialized writer)', async () => {
  const store = installLocalStorage();
  await Promise.all([
    setCachedModelList('anthropic:k1', models('a')),
    setCachedModelList('openai:k2', models('b')),
    setCachedModelList('openrouter', models('c')),
    updateModelListCache(cache => { cache['custom:http://localhost:1234/v1'] = { models: models('d'), fetchedAt: Date.now() }; })
  ]);
  assert.deepEqual(Object.keys(store.modelListCache).sort(),
    ['anthropic:k1', 'custom:http://localhost:1234/v1', 'openai:k2', 'openrouter']);
});

test('a failing mutator rejects its own call but does not block later writes', async () => {
  const store = installLocalStorage();
  const failing = updateModelListCache(() => { throw new Error('boom'); });
  const next = setCachedModelList('openrouter', models('a'));
  await assert.rejects(failing, /boom/);
  await next;
  assert.deepEqual(store.modelListCache.openrouter.models, models('a'));
});

test('writes prune entries older than 7 days and malformed ones, keep the rest', async () => {
  const now = Date.now();
  const store = installLocalStorage({
    modelListCache: {
      'custom:http://old:1/v1': { models: models('o'), fetchedAt: now - 8 * DAY },
      anthropic: { models: models('legacy'), fetchedAt: now - 8 * DAY },
      'google:abc': { models: models('g'), fetchedAt: now - 6 * DAY },
      'deepl-langs:abc': { models: models('PL'), fetchedAt: now - DAY },
      broken: 'nope'
    }
  });
  await setCachedModelList('openrouter', models('r'));
  assert.deepEqual(Object.keys(store.modelListCache).sort(), ['deepl-langs:abc', 'google:abc', 'openrouter']);
});

test('a non-object cache is replaced', async () => {
  const store = installLocalStorage({ modelListCache: 'garbage' });
  await setCachedModelList('openrouter', models('r'));
  assert.deepEqual(Object.keys(store.modelListCache), ['openrouter']);
});

test('an older fetch finishing last does not overwrite a newer list', async () => {
  const store = installLocalStorage();
  const newer = await setCachedModelList('openrouter', models('new'), { startedAt: 200, sessionId: 's1' });
  const older = await setCachedModelList('openrouter', models('old'), { startedAt: 100, sessionId: 's1' });
  assert.equal(newer, true);
  assert.equal(older, false);
  assert.deepEqual(store.modelListCache.openrouter.models, models('new'));
  assert.deepEqual((await getCachedModelList('openrouter')).models, models('new'));
});

test('overlapping fetches written concurrently keep the later-started list', async () => {
  const store = installLocalStorage();
  const results = await Promise.all([
    setCachedModelList('anthropic:k', models('b'), { startedAt: 2, sessionId: 's1' }),
    setCachedModelList('anthropic:k', models('a'), { startedAt: 1, sessionId: 's1' })
  ]);
  assert.deepEqual(results, [true, false]);
  assert.deepEqual(store.modelListCache['anthropic:k'].models, models('b'));
});

test('a later-started fetch replaces the list', async () => {
  const store = installLocalStorage();
  await setCachedModelList('openrouter', models('a'), { startedAt: 1, sessionId: 's1' });
  assert.equal(await setCachedModelList('openrouter', models('b'), { startedAt: 2, sessionId: 's1' }), true);
  assert.deepEqual(store.modelListCache.openrouter.models, models('b'));
});

test('a fetch from another page session wins even with an older stamp', async () => {
  const store = installLocalStorage();
  await setCachedModelList('openrouter', models('earlier-session'), { startedAt: 5000, sessionId: 'old-page' });
  // Clock rolled back, or the counter restarted in a new options page
  assert.equal(await setCachedModelList('openrouter', models('this-session'), { startedAt: 10, sessionId: 'new-page' }), true);
  assert.deepEqual(store.modelListCache.openrouter.models, models('this-session'));
});

test('a write without a session id never rejects and is never rejected by stamp alone', async () => {
  const store = installLocalStorage();
  await setCachedModelList('openrouter', models('a'), { startedAt: 5000, sessionId: 's1' });
  assert.equal(await setCachedModelList('openrouter', models('b')), true);
  assert.deepEqual(store.modelListCache.openrouter.models, models('b'));
});

test('an entry fetched "in the future" is pruned and reads as stale', async () => {
  const future = Date.now() + 365 * DAY;
  const store = installLocalStorage({ modelListCache: { 'google:abc': { models: models('g'), fetchedAt: future } } });
  assert.equal((await getCachedModelList('google:abc')).stale, true);
  await setCachedModelList('openrouter', models('r'));
  assert.deepEqual(Object.keys(store.modelListCache), ['openrouter']);
});
