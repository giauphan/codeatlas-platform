const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const WEEKDAY_NAMES: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

interface CronField {
  values: Set<number>;
  wildcard: boolean;
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseValue(value: string, names: Record<string, number> | undefined): number | null {
  const upper = value.toUpperCase();
  if (names && Object.hasOwn(names, upper)) return names[upper];
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function parseRange(base: string, min: number, max: number, names: Record<string, number> | undefined, hasStep: boolean): [number, number] | null {
  if (base === "*") return [min, max];
  if (base.includes("-")) {
    const range = base.split("-");
    if (range.length !== 2) return null;
    const start = parseValue(range[0], names);
    const end = parseValue(range[1], names);
    return start === null || end === null ? null : [start, end];
  }
  const start = parseValue(base, names);
  // A step after a single value means that value through the field maximum.
  return start === null ? null : [start, hasStep ? max : start];
}

function parseComponent(component: string, min: number, max: number, names: Record<string, number> | undefined, allowSevenAsSunday: boolean, values: Set<number>): boolean {
  if (!component) return false;
  const segments = component.split("/");
  if (segments.length > 2) return false;
  const stepText = segments[1];
  if (stepText !== undefined && !/^\d+$/.test(stepText)) return false;
  const step = stepText === undefined ? 1 : Number(stepText);
  if (!Number.isSafeInteger(step) || step < 1) return false;
  const range = parseRange(segments[0], min, max, names, segments.length === 2);
  if (!range) return false;
  const [start, end] = range;
  const sourceMax = allowSevenAsSunday ? 7 : max;
  if (start < min || start > sourceMax || end < min || end > sourceMax || start > end) return false;
  for (let value = start; value <= end; value += step) {
    values.add(allowSevenAsSunday && value === 7 ? 0 : value);
  }
  return true;
}

function parseField(
  expression: string,
  min: number,
  max: number,
  names?: Record<string, number>,
  allowSevenAsSunday = false,
): CronField | null {
  if (!expression) return null;
  const values = new Set<number>();
  const wildcard = expression.startsWith("*");

  for (const component of expression.split(",")) {
    if (!parseComponent(component, min, max, names, allowSevenAsSunday, values)) return null;
  }

  return values.size ? { values, wildcard } : null;
}

function parseCron(expression: string): ParsedCron | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dayOfMonth = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12, MONTH_NAMES);
  const dayOfWeek = parseField(parts[4], 0, 6, WEEKDAY_NAMES, true);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

export function validateCronExpression(expression: string): { valid: boolean; error?: string } {
  if (typeof expression !== "string" || expression.trim().split(/\s+/).length !== 5) {
    return { valid: false, error: "Cron expression must contain exactly five fields" };
  }
  if (!parseCron(expression)) return { valid: false, error: "Cron expression contains an invalid field, range, name, or step" };
  return { valid: true };
}

export function validateTimeZone(timeZone: string): { valid: boolean; error?: string } {
  if (typeof timeZone !== "string" || !timeZone.trim()) return { valid: false, error: "Timezone is required" };
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return { valid: true };
  } catch {
    return { valid: false, error: "Timezone must be a valid IANA timezone" };
  }
}

function localCronParts(date: Date, timeZone: string): { minute: number; hour: number; day: number; month: number; weekday: number } | null {
  if (!Number.isFinite(date.getTime()) || !validateTimeZone(timeZone).valid) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  const weekdayName = get("weekday")?.toUpperCase().slice(0, 3) || "";
  const weekday = WEEKDAY_NAMES[weekdayName];
  const minute = Number(get("minute"));
  const hour = Number(get("hour"));
  const day = Number(get("day"));
  const month = Number(get("month"));
  if (![minute, hour, day, month, weekday].every(Number.isFinite)) return null;
  return { minute, hour, day, month, weekday };
}

/** Match a standard five-field cron expression in an explicit IANA timezone. */
export function matchesCron(cron: string, date: Date, timeZone = "UTC"): boolean {
  const parsed = parseCron(cron);
  const local = localCronParts(date, timeZone);
  if (!parsed || !local) return false;

  const dayOfMonthMatches = parsed.dayOfMonth.values.has(local.day);
  const dayOfWeekMatches = parsed.dayOfWeek.values.has(local.weekday);
  // Cronie treats either day field containing a leading '*' (including */step)
  // as a conjunctive day restriction; otherwise the two restricted fields OR.
  const dayMatches = parsed.dayOfMonth.wildcard || parsed.dayOfWeek.wildcard
    ? dayOfMonthMatches && dayOfWeekMatches
    : dayOfMonthMatches || dayOfWeekMatches;

  return parsed.minute.values.has(local.minute)
    && parsed.hour.values.has(local.hour)
    && parsed.month.values.has(local.month)
    && dayMatches;
}
