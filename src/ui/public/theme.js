// Run before the application to restore the browser's palette without a bright flash.
(() => {
  const choices = ['glacier', 'pearl', 'mint', 'lilac', 'graphite', 'midnight', 'forest', 'plum'];
  let choice;
  try {
    choice = localStorage.getItem('daddyloop.theme');
  } catch {}
  document.documentElement.dataset.theme = choices.includes(choice)
    ? choice
    : matchMedia('(prefers-color-scheme: dark)').matches
      ? 'graphite'
      : 'glacier';
})();
