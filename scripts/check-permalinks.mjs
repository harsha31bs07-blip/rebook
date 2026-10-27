// Lists every GitHub permalink in README.md and app/built-with/page.tsx with the first line of its range,
// and fails if a file is missing or a range runs past the end of the file. Run before freezing the code:
//   node scripts/check-permalinks.mjs
import { readFileSync, existsSync } from "node:fs";

const sources = ["README.md", "app/built-with/page.tsx"];
const pattern = /blob\/main\/([^#\s)"'`]+)#L(\d+)-L(\d+)|"([a-z][\w/.[\]-]+\.(?:ts|tsx|mjs))#L(\d+)-L(\d+)"/g;
let failures = 0;
for (const source of sources) {
  const text = readFileSync(source, "utf8");
  for (const match of text.matchAll(pattern)) {
    const [file, from, to] = match[1] ? [match[1], +match[2], +match[3]] : [match[4], +match[5], +match[6]];
    const path = decodeURIComponent(file);
    if (!existsSync(path)) { failures += 1; console.log(`MISSING  ${source} -> ${path}`); continue; }
    const lines = readFileSync(path, "utf8").split("\n");
    if (to > lines.length || from > to) { failures += 1; console.log(`RANGE    ${source} -> ${path}#L${from}-L${to} (file has ${lines.length} lines)`); continue; }
    console.log(`ok       ${path}#L${from}-L${to}  ${lines[from - 1].trim().slice(0, 90)}`);
  }
}
if (failures) { console.error(`${failures} broken permalink(s)`); process.exit(1); }
