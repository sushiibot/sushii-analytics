const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// KST is a fixed +9h offset with no DST, so UTC hour buckets roll up exactly.
const KST_OFFSET_MS = 9 * HOUR_MS;

export { HOUR_MS, DAY_MS };

export function utcHour(t: number): number {
  return Math.floor(t / HOUR_MS);
}

function kstDate(t: number): Date {
  return new Date(t + KST_OFFSET_MS);
}

export function kstYear(t: number): number {
  return kstDate(t).getUTCFullYear();
}

export function kstDay(t: number): string {
  return kstDate(t).toISOString().slice(0, 10);
}

export function kstMonth(t: number): string {
  return kstDate(t).toISOString().slice(0, 7);
}

/** 0-based day of the KST month, used as the bit index in active-day masks. */
export function kstDayOfMonth(t: number): number {
  return kstDate(t).getUTCDate() - 1;
}

/** UTC ms of 00:00 KST on the first day of the month after `month` (YYYY-MM). */
export function kstMonthEnd(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return Date.UTC(y, m, 1) - KST_OFFSET_MS;
}
