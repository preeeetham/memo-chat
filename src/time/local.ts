/** Local-calendar helpers. Local dates are plain "YYYY-MM-DD" strings; day math is done in UTC to avoid DST drift. */

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function safeTz(tz: string | undefined | null): string {
  return tz && isValidTz(tz) ? tz : "UTC";
}

/** The calendar date of `instant` as seen in `tz`. */
export function localDate(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The hour (0-23) of `instant` on the clock in `tz`. */
export function localHour(instant: Date, tz: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(instant);
  return Number(h) % 24;
}

const toUTC = (d: string) => new Date(`${d}T00:00:00Z`);
const fromUTC = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(d: string, n: number): string {
  const x = toUTC(d);
  x.setUTCDate(x.getUTCDate() + n);
  return fromUTC(x);
}

/** 0 = Sunday ... 6 = Saturday */
export function weekday(d: string): number {
  return toUTC(d).getUTCDay();
}

export function daysBetween(a: string, b: string): number {
  return Math.round((toUTC(b).getTime() - toUTC(a).getTime()) / 86_400_000);
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mon 9 Nov" */
export function shortLabel(d: string): string {
  const x = toUTC(d);
  return `${WD[x.getUTCDay()]} ${x.getUTCDate()} ${MON[x.getUTCMonth()]}`;
}

/** "Wed 11 Nov 2026, 14:05 (Asia/Kolkata)" */
export function describeNow(instant: Date, tz: string): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(instant);
  const d = localDate(instant, tz);
  return `${shortLabel(d)} ${d.slice(0, 4)}, ${time} (${tz})`;
}
