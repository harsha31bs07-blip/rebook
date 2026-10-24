/** Aggregate sessions, never booking joins: capacity is counted once per class. */
export function heatmapCells(rows: Record<string, unknown>[]) {
  const cells = new Map<string, { instructor: string; day: string; dayValue: unknown; booked: number; capacity: number; disrupted: boolean }>();
  for (const row of rows) {
    const instructor = String(row.instructor ?? ""), day = heatmapDayKey(row.local_day);
    if (!instructor || !day) continue;
    const key = JSON.stringify([instructor, day]);
    const cell = cells.get(key) ?? { instructor, day, dayValue: row.local_day, booked: 0, capacity: 0, disrupted: false };
    cell.booked += Number(row.booked) || 0;
    cell.capacity += Number(row.capacity) || 0;
    cell.disrupted ||= row.disrupted === true;
    cells.set(key, cell);
  }
  return [...cells.values()].map((cell) => ({ ...cell, utilisation: cell.capacity > 0 ? cell.booked / cell.capacity : 0 }));
}

export const heatmapDayKey = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "").slice(0, 10);

export const heatmapDayLabel = (day: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${day}T00:00:00Z`)).replaceAll(",", "");
