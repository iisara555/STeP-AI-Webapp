// Preference only; no account or work contents are persisted here.
try {
  const saved = localStorage.getItem('step-theme');
  document.documentElement.dataset.theme = ['light', 'dark'].includes(saved) ? saved : 'system';
} catch {
  document.documentElement.dataset.theme = 'system';
}
