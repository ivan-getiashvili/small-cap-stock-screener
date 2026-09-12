/**
 * Fast conversion from epoch ms to "minutes since ET midnight".
 *
 * The obvious implementation calls toLocaleString per bar. At ~900 bars a
 * session across thousands of sessions that is millions of Intl allocations
 * and dominates the backtest's runtime, so the UTC offset is resolved once per
 * UTC day and cached. Offsets only change on DST boundaries, which fall on a
 * day boundary, so a per-day cache is exact rather than approximate.
 */
const offsetCache = new Map<string, number>();

function offsetMinutes(ts: number): number {
  const dayKey = new Date(ts).toISOString().slice(0, 10);
  const hit = offsetCache.get(dayKey);
  if (hit !== undefined) return hit;

  // Compare the same instant rendered in UTC and in New York.
  const d = new Date(ts);
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  const off = Math.round((et.getTime() - utc.getTime()) / 60000);
  offsetCache.set(dayKey, off);
  return off;
}

/** Minutes since midnight America/New_York. 09:30 -> 570. */
export function etMinutes(ts: number): number {
  const utcMins = Math.floor(ts / 60000) % 1440;
  return ((utcMins + offsetMinutes(ts)) % 1440 + 1440) % 1440;
}

/** ISO date (YYYY-MM-DD) in ET, not UTC — a 19:00 ET bar is still that day. */
export function etDate(ts: number): string {
  return new Date(ts + offsetMinutes(ts) * 60000).toISOString().slice(0, 10);
}
