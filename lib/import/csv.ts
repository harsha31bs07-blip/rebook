/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF, optional BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const input = text.replace(/^﻿/, "");
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (char === "\"" && input[index + 1] === "\"") { field += "\""; index++; }
      else if (char === "\"") quoted = false;
      else field += char;
    } else if (char === "\"" && field === "") quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.map((cells) => cells.map((cell) => cell.trim())).filter((cells) => cells.some((cell) => cell !== ""));
}
