import fs from "node:fs";
import { normalizeNFC, UNICODE_VERSION } from "../src/unicode.js";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node scripts/verify-unicode-normalization.mjs /path/to/NormalizationTest.txt");
  process.exit(2);
}

const parse = value => String.fromCodePoint(...value.trim().split(/\s+/).filter(Boolean).map(part => Number.parseInt(part, 16)));
let tested = 0;
let failures = 0;
const examples = [];

for (const raw of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
  const line = raw.split("#", 1)[0].trim();
  if (!line || line.startsWith("@")) continue;
  const columns = line.split(";");
  if (columns.length < 5) continue;
  const [c1, c2, c3, c4, c5] = columns.slice(0, 5).map(parse);
  for (const [input, expected] of [[c1, c2], [c2, c2], [c3, c2], [c4, c4], [c5, c4]]) {
    tested++;
    if (normalizeNFC(input) !== expected) {
      failures++;
      if (examples.length < 10) examples.push({ line: raw, input, expected, actual: normalizeNFC(input) });
    }
  }
}

console.log(JSON.stringify({ unicodeVersion: UNICODE_VERSION, tested, failures, examples }, null, 2));
if (failures) process.exit(1);
