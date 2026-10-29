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
