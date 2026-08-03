// Classic (non-module) script in <head>, so it blocks the parser before any
// page content exists and applies the saved theme without waiting for the async
// chrome.storage read in options.js. Everything it touches is on <html> — the
// body element does not exist yet, which is why the dark styles in options.css
// key off html[data-theme="dark"] rather than a body class.
//
// It cannot be a module (implicitly deferred → runs after parse → light flash)
// and it cannot be inline (MV3 CSP forbids inline scripts), so the resolution
// logic below duplicates `resolveTheme` from lib/theme.js. Keep them in sync.
(function () {
  var preference;
  try {
    preference = localStorage.getItem('contexthelper.theme');
  } catch {
    preference = null;
  }
  var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  document.documentElement.dataset.theme = preference === 'dark' ? 'dark'
    : preference === 'light' ? 'light'
    : prefersDark ? 'dark' : 'light';
})();
