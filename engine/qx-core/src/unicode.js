import {
  UNICODE_VERSION,
  XID_START_RANGES,
  XID_CONTINUE_RANGES,
  LETTER_RANGES,
  LATIN_SCRIPT_RANGES,
  ARABIC_SCRIPT_RANGES,
  DEFAULT_IGNORABLE_RANGES,
  COMBINING_CLASS
} from "./unicode-data.js";

function inRanges(codePoint, ranges) {
  let low = 0;
  let high = ranges.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const start = ranges[middle * 2];
    const end = ranges[middle * 2 + 1];
    if (codePoint < start) high = middle - 1;
    else if (codePoint > end) low = middle + 1;
    else return true;
  }
  return false;
}

export { UNICODE_VERSION };
export const isXIDStart = cp => inRanges(cp, XID_START_RANGES);
export const isXIDContinue = cp => inRanges(cp, XID_CONTINUE_RANGES);
export const isLetter = cp => inRanges(cp, LETTER_RANGES);
export const isLatin = cp => inRanges(cp, LATIN_SCRIPT_RANGES);
export const isArabic = cp => inRanges(cp, ARABIC_SCRIPT_RANGES);
export const isDefaultIgnorable = cp => inRanges(cp, DEFAULT_IGNORABLE_RANGES);
export const combiningClass = cp => COMBINING_CLASS.get(cp) ?? 0;

function canonicalOrder(value) {
  const codePoints = Array.from(value, character => character.codePointAt(0));
  for (let i = 1; i < codePoints.length; i++) {
    const currentClass = combiningClass(codePoints[i]);
    if (currentClass === 0) continue;
    let j = i;
    while (j > 0) {
      const previousClass = combiningClass(codePoints[j - 1]);
      if (previousClass === 0 || previousClass <= currentClass) break;
      [codePoints[j - 1], codePoints[j]] = [codePoints[j], codePoints[j - 1]];
      j--;
    }
  }
  let ordered = "";
  for (let i = 0; i < codePoints.length; i += 8192) {
    ordered += String.fromCodePoint(...codePoints.slice(i, i + 8192));
  }
  return ordered;
}

export function normalizeNFC(value) {
  if (typeof value !== "string") throw new TypeError("NFC input must be a string");
  // Unicode normalization mappings are stable. UCD 18.0.0 adds no canonical
  // decomposition mappings for characters introduced in Unicode 17 or 18;
  // the newer combining classes are applied explicitly from the pinned table.
  return canonicalOrder(value.normalize("NFD")).normalize("NFC");
}
