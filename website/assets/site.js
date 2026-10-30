// Copy the install command.
const btn = document.getElementById('copy');
if (btn) {
  btn.addEventListener('click', async () => {
    const label = btn.textContent;
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = 'COPIED ✓';
    } catch {
      btn.textContent = 'SELECT + COPY';
    }
    setTimeout(() => { btn.textContent = label; }, 1800);
  });
}

// Show the newest release (the text in the HTML is only a fallback).
// "v0.6.0 – Restore a whole server" → badge "v0.6.0", text "Restore a whole server".
(async () => {
  try {
    const r = await fetch('https://api.github.com/repos/gadziunet/stackmoor/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!r.ok) return;
    const rel = await r.json();
    const tag = String(rel.tag_name || '');
    if (!/^v?\d+\.\d+\.\d+$/.test(tag)) return;
    const version = tag.replace(/^v/, '');
    const title = String(rel.name || '').split(/\s+[–—-]\s+/).slice(1).join(' – ').trim();
    const set = (id, text) => { const el = document.getElementById(id); if (el && text) el.textContent = text; };
    set('rel-ver', `v${version}`);
    set('rel-rev', version);
    set('rel-title', title || 'What’s new');
    const link = document.getElementById('rel-link');
    if (link && rel.html_url) link.href = rel.html_url;
  } catch {
    // offline or rate-limited: keep the text from the HTML
  }
})();
