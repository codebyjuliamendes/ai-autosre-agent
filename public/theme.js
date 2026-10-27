// Applied before first paint to avoid a theme flash. Defaults to the dark (Matrix) theme.
(function () {
  let theme = 'dark';
  try {
    theme = localStorage.getItem('autosre-theme') || 'dark';
  } catch {
    /* storage unavailable */
  }
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
})();
