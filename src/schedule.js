// Weekly schedules ("on these days at this time") shared by automatic updates and restarts.
// The same rules as the backup schedule: once per chosen day, at the time or up to an hour later.
import { isDue, localParts } from './backup-plan.js';

export { isDue, localParts };

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Checks a schedule from the form. Missing fields keep the old values. */
export function cleanSchedule(body = {}, old = {}) {
  const days = body.days === undefined
    ? old.days
    : [...new Set((Array.isArray(body.days) ? body.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  const time = TIME_RE.test(String(body.time ?? '')) ? body.time : old.time;
  let timeZone = String(body.timeZone ?? old.timeZone ?? 'UTC') || 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone }); } catch { timeZone = old.timeZone || 'UTC'; }
  return {
    ...old,
    enabled: body.enabled === undefined ? Boolean(old.enabled) : Boolean(body.enabled),
    days: days || [],
    time: time || '03:00',
    timeZone,
  };
}
