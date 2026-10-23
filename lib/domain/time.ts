import type { Customer, Studio } from "./types";

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const formatMoney = (value: string, currency: string): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, useGrouping: false }).format(Number(value));
export const iso = (value: string | number): string => new Date(value).toISOString();
export const addMinutes = (value: string, minutes: number): string => iso(Date.parse(value) + minutes * MINUTE);
export const addDays = (value: string, days: number): string => iso(Date.parse(value) + days * DAY);
export const dayStart = (value: string): number => {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};
export const weekday = (value: string): number => new Date(value).getUTCDay();
export const clockMinutes = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
export const minutesOfDay = (value: string): number => (Date.parse(value) - dayStart(value)) / MINUTE;
const formatters = new Map<string, Intl.DateTimeFormat>();
const partsCache = new Map<string, { weekday: number; minutesOfDay: number; dateKey: string }>();
const zonedCache = new Map<string, string>();

/** Calendar and clock values in the studio's zone; instants remain UTC ISO strings. */
export function localParts(value: string, tz: string): { weekday: number; minutesOfDay: number; dateKey: string } {
  const key = `${tz}|${value}`;
  const cached = partsCache.get(key);
  if (cached) return { ...cached };
  let formatter = formatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    formatters.set(tz, formatter);
  }
  const date = new Date(value);
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  const result = {
    weekday: new Date(`${dateKey}T00:00:00Z`).getUTCDay(), dateKey,
    minutesOfDay: Number(parts.hour) * 60 + Number(parts.minute) + Number(parts.second) / 60 + date.getUTCMilliseconds() / MINUTE,
  };
  if (partsCache.size >= 10_000) partsCache.clear();
  partsCache.set(key, result);
  return { ...result };
}

export const addLocalDays = (dateKey: string, days: number): string =>
  iso(Date.parse(`${dateKey}T00:00:00Z`) + days * DAY).slice(0, 10);

/** DST-compatible conversion: earlier instant on overlaps; shift forward by the gap on missing clocks. */
export function zonedTimeToUtc(dateKey: string, clock: string, tz: string): string {
  const key = `${tz}|${dateKey}|${clock}`;
  const cached = zonedCache.get(key);
  if (cached) return cached;
  const remember = (instant: number): string => {
    const value = iso(instant);
    if (zonedCache.size >= 10_000) zonedCache.clear();
    zonedCache.set(key, value);
    return value;
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)) {
    throw new RangeError("Invalid local date or clock");
  }
  const wall = Date.parse(`${dateKey}T${clock}:00Z`);
  if (!Number.isFinite(wall) || iso(wall).slice(0, 10) !== dateKey) throw new RangeError("Invalid local date");
  const offsets = new Set<number>();
  for (const delta of [-2 * DAY, 0, 2 * DAY]) {
    const instant = wall + delta;
    const parts = localParts(iso(instant), tz);
    offsets.add(Date.parse(`${parts.dateKey}T00:00:00Z`) + parts.minutesOfDay * MINUTE - instant);
  }
  const candidates = [...offsets].map((offset) => wall - offset).sort((a, b) => a - b);
  for (const candidate of candidates) {
    const parts = localParts(iso(candidate), tz);
    if (parts.dateKey === dateKey && parts.minutesOfDay === clockMinutes(clock)) return remember(candidate);
  }
  // No exact match means a forward DST transition skipped this wall time.
  const shifted = candidates.find((candidate) => {
    const parts = localParts(iso(candidate), tz);
    return Date.parse(`${parts.dateKey}T00:00:00Z`) + parts.minutesOfDay * MINUTE > wall;
  });
  if (shifted === undefined) throw new RangeError("Unable to resolve local time");
  return remember(shifted);
}
export const overlaps = (start: string, end: string, from: string, to: string): boolean =>
  Date.parse(start) < Date.parse(to) && Date.parse(from) < Date.parse(end);

export function insideOpenHours(studio: Studio, start: string, end: string): boolean {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const { dateKey, weekday } = localParts(start, studio.timezone);
  return endMs > startMs && (studio.openHours[weekday] ?? []).some((hours) =>
    startMs >= Date.parse(zonedTimeToUtc(dateKey, hours.open, studio.timezone)) &&
    endMs <= Date.parse(zonedTimeToUtc(dateKey, hours.close, studio.timezone)));
}

export function fitsPreferences(customer: Customer, start: string, end: string, tz: string): boolean {
  const { dateKey, weekday } = localParts(start, tz);
  return Date.parse(end) > Date.parse(start) && customer.prefs.windows.some((window) => window.weekday === weekday &&
    Date.parse(start) >= Date.parse(zonedTimeToUtc(dateKey, window.from, tz)) &&
    Date.parse(end) <= Date.parse(zonedTimeToUtc(dateKey, window.to, tz)));
}

export function toCents(value: string): number {
  if (!/^(0|[1-9]\d*)\.\d{2}$/.test(value)) throw new Error(`Invalid money: ${value}`);
  const [whole, fraction] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(cents)) throw new Error("Money exceeds safe integer cents");
  return cents;
}

export function fromCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("Invalid cents total");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export const byId = <T extends { id: string }>(a: T, b: T): number => compare(a.id, b.id);
export const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
