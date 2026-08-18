/*
 * Applies the persisted or system colour theme BEFORE first paint, so the page
 * never flashes light before switching to dark.
 *
 * This lives as a static file (rather than an inline dangerouslySetInnerHTML
 * string) so the project's "never use dangerouslySetInnerHTML" rule holds with
 * no exceptions, and so it is covered by a strict CSP without needing a nonce
 * or 'unsafe-inline'. It must stay synchronous and blocking in <head>.
 */
(function () {
  try {
    var stored = localStorage.getItem('arc-theme');
    var dark = stored
      ? stored === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {
    /* Storage unavailable (private mode, blocked cookies): fall back to light. */
  }
})();
