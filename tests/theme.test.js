import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme, THEME_BOOT_KEY } from '../lib/theme.js';

test('explicit preferences ignore the system setting', () => {
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('light', false), 'light');
});

test('auto follows the system setting', () => {
  assert.equal(resolveTheme('auto', true), 'dark');
  assert.equal(resolveTheme('auto', false), 'light');
});

test('unknown or missing preferences fall back to auto', () => {
  assert.equal(resolveTheme(null, true), 'dark');
  assert.equal(resolveTheme(undefined, false), 'light');
  assert.equal(resolveTheme('', true), 'dark');
  assert.equal(resolveTheme('nonsense', true), 'dark');
});

test('boot key is a stable string', () => {
  assert.equal(typeof THEME_BOOT_KEY, 'string');
  assert.ok(THEME_BOOT_KEY.length > 0);
});
