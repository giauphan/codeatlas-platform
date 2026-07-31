/**
 * Minimal cron matcher for 5-field expressions (m h dom mon dow).
 * Only supports '*' and literal numbers for simplicity.
 */
export function matchesCron(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [min, hour, dom, mon, dow] = parts;

  const match = (p: string, val: number) => p === '*' || parseInt(p, 10) === val;

  return (
    match(min, date.getMinutes()) &&
    match(hour, date.getHours()) &&
    match(dom, date.getDate()) &&
    match(mon, date.getMonth() + 1) &&
    match(dow, date.getDay())
  );
}
