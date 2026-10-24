export const titleCase = (value: string) => value.toLowerCase().replace(/(^|[ _-])\w/g, (word) => word.toUpperCase()).replaceAll("_", " ");

/** Keep the sortable HH:mm value in the data; format only at the display boundary. */
export function localTimeLabel(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}
