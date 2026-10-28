// Materialize today through 45 days ahead; never complete past unfinished tasks.
// Local calendar dates identify occurrences independently of DST offsets.
export function occurrenceKey(localDate: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(localDate) ||
    new Date(`${localDate}T00:00:00Z`).toISOString().slice(0, 10) !== localDate
  )
    throw new Error('Invalid occurrence date');
  return localDate;
}
export function localDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function addDays(date: string, days: number): string {
  const d = new Date(`${occurrenceKey(date)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function occurrenceDates(
  rule: {
    kind: string;
    weekdays?: string[];
    month_day?: number;
    starts_on: string;
    ends_on: string | null;
    timezone: string;
    status: string;
  },
  now: Date,
): string[] {
  if (rule.status !== 'active') return [];
  const today = localDate(now, rule.timezone),
    end = addDays(today, 45),
    dates: string[] = [];
  for (let day = today; day <= end; day = addDays(day, 1)) {
    if (day < rule.starts_on || (rule.ends_on && day > rule.ends_on)) continue;
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (
      rule.kind === 'daily' ||
      (rule.kind === 'weekdays' && dow >= 1 && dow <= 5) ||
      (rule.kind === 'weekly' &&
        rule.weekdays?.includes(
          ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][dow],
        )) ||
      (rule.kind === 'monthly' && Number(day.slice(8)) === rule.month_day)
    )
      dates.push(occurrenceKey(day));
  }
  return dates;
}

// SHA-256 UUIDv8: a stable identity with an unambiguous tuple encoding.
export async function occurrenceId(
  ruleId: string,
  date: string,
): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify([ruleId, occurrenceKey(date)])),
    ),
  ).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  return `tsk_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Ambiguous clocks use the earlier instant; nonexistent clocks advance by the
// DST gap (the same compatible disambiguation used by calendar applications).
export function plannedStartAt(
  date: string,
  startTime: string | undefined,
  timezone: string,
): string | null {
  occurrenceKey(date);
  if (startTime === undefined) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(startTime)) {
    throw new Error('Invalid start time');
  }
  const wall = Date.parse(`${date}T${startTime}:00Z`);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const wallAt = (instant: number): number => {
    const parts = formatter.formatToParts(new Date(instant));
    const get = (type: string) => parts.find((p) => p.type === type)!.value;
    return Date.parse(
      `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`,
    );
  };
  const offsets = new Set(
    [-2, -1, 0, 1, 2].map((days) => {
      const probe = wall + days * 86400000;
      return wallAt(probe) - probe;
    }),
  );
  const candidates = [...offsets].map((offset) => wall - offset);
  const exact = candidates.filter((candidate) => wallAt(candidate) === wall);
  if (exact.length) return new Date(Math.min(...exact)).toISOString();
  const forward = candidates
    .filter((candidate) => wallAt(candidate) > wall)
    .sort((a, b) => wallAt(a) - wallAt(b));
  return new Date(forward[0]).toISOString();
}
