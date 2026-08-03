// Shared theme resolution for the options page.
//
// NOTE: theme-boot.js deliberately duplicates `resolveTheme` instead of
// importing it — it must be a classic (non-module) script so that it runs
// during parsing, before the first paint. Keep the two in sync.

/** localStorage key holding the last known theme preference ('auto' | 'light' | 'dark'). */
export const THEME_BOOT_KEY = 'contexthelper.theme';

/**
 * Resolve a stored theme preference to the theme that should actually render.
 * Anything other than 'light' or 'dark' is treated as 'auto'.
 */
export function resolveTheme(preference, prefersDark) {
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return 'light';
  return prefersDark ? 'dark' : 'light';
}
