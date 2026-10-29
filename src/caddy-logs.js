/**
 * Certificate errors worth showing: only those after the last successful certificate,
 * and never "context canceled" (Caddy cancels a running attempt when it reloads or stops).
 */
export function certErrors(logText, limit = 3) {
  const lines = String(logText || '').split('\n')
    .map((l) => { try { return JSON.parse(l.slice(l.indexOf('{'))); } catch { return null; } })
    .filter(Boolean);
  let start = 0;
  lines.forEach((l, i) => { if (/certificate obtained successfully/i.test(l.msg || '')) start = i + 1; });
  return lines.slice(start)
    .filter((l) => l.level === 'error' && !/context canceled/i.test(`${l.msg} ${l.error}`))
    .slice(-limit)
    .map((l) => [l.msg, l.error].filter(Boolean).join(': ').slice(0, 500));
}
