#!/usr/bin/env python3
"""Generate QX's pinned Unicode 18.0.0 tables from an extracted official UCD."""
from pathlib import Path
import argparse, base64, gzip, hashlib, json


def merge(ranges):
    result = []
    for start, end in sorted(ranges):
        if result and start <= result[-1][1] + 1:
            result[-1] = (result[-1][0], max(result[-1][1], end))
        else:
            result.append((start, end))
    return result


def properties(path, wanted):
    result = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        fields = [part.strip() for part in line.split(";")]
        if len(fields) < 2 or fields[1] not in wanted:
            continue
        bounds = fields[0].split("..")
        result.append((int(bounds[0], 16), int(bounds[-1], 16)))
    return merge(result)


def contains(cp, ranges):
    low, high = 0, len(ranges) - 1
    while low <= high:
        mid = (low + high) // 2
        start, end = ranges[mid]
        if cp < start:
            high = mid - 1
        elif cp > end:
            low = mid + 1
        else:
            return True
    return False


def unicode_data(path):
    letters, classes, canonical = [], [], {}
    pending = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        f = raw.split(";")
        cp, name, category, ccc, decomposition = int(f[0], 16), f[1], f[2], int(f[3]), f[5]
        if name.endswith(", First>"):
            pending = (cp, category, ccc)
            continue
        if name.endswith(", Last>") and pending:
            start, first_category, first_ccc = pending
            if first_category.startswith("L"):
                letters.append((start, cp))
            if first_ccc:
                classes.extend((point, first_ccc) for point in range(start, cp + 1))
            pending = None
            continue
        if category.startswith("L"):
            letters.append((cp, cp))
        if ccc:
            classes.append((cp, ccc))
        if decomposition and not decomposition.startswith("<"):
            canonical[cp] = decomposition
    return merge(letters), classes, canonical


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("ucd_dir", type=Path)
    parser.add_argument("--out-dir", type=Path, default=Path("src"))
    args = parser.parse_args()
    root, out = args.ucd_dir, args.out_dir
    if "version 18.0.0" not in (root / "ReadMe.txt").read_text(encoding="utf-8"):
        raise SystemExit("Expected the official Unicode 18.0.0 UCD")

    dcp = root / "DerivedCoreProperties.txt"
    xid_start = properties(dcp, {"XID_Start"})
    xid_continue = properties(dcp, {"XID_Continue"})
    ignorables = properties(dcp, {"Default_Ignorable_Code_Point"})
    latin = properties(root / "Scripts.txt", {"Latin"})
    arabic = properties(root / "Scripts.txt", {"Arabic"})
    age_17_18 = properties(root / "DerivedAge.txt", {"17.0", "18.0"})
    letters, classes, canonical = unicode_data(root / "UnicodeData.txt")
    if any(contains(cp, age_17_18) for cp in canonical):
        raise SystemExit("Unicode 17/18 canonical decompositions require a revised NFC implementation")

    packed = bytearray()
    def write(value):
        while value >= 128:
            packed.append((value & 127) | 128)
            value >>= 7
        packed.append(value)

    for ranges in (xid_start, xid_continue, letters, latin, arabic, ignorables):
        write(len(ranges))
        previous = -1
        for start, end in ranges:
            write(start - previous - 1)
            write(end - start)
            previous = end
    write(len(classes))
    previous = 0
    for cp, ccc in sorted(classes):
        write(cp - previous)
        write(ccc)
        previous = cp

    encoded = base64.b64encode(gzip.compress(bytes(packed), compresslevel=9, mtime=0)).decode()
    module = (
        "// Generated from Unicode Character Database 18.0.0. Do not edit by hand.\n"
        'import { gunzipSync } from "node:zlib";\nconst encoded = "' + encoded + '";\n'
        + 'const bytes = gunzipSync(Buffer.from(encoded, "base64"));\nlet offset = 0;\n'
        + 'function readVarint() { let value = 0, shift = 0; while (true) { const byte = bytes[offset++]; value += (byte & 0x7F) * (2 ** shift); if ((byte & 0x80) === 0) return value; shift += 7; } }\n'
        + 'function readRanges() { const count = readVarint(), ranges = []; let previousEnd = -1; for (let i = 0; i < count; i++) { const start = previousEnd + 1 + readVarint(); const end = start + readVarint(); ranges.push(start, end); previousEnd = end; } return Object.freeze(ranges); }\n'
        + 'export const UNICODE_VERSION = "18.0.0";\n'
        + 'export const XID_START_RANGES = readRanges();\nexport const XID_CONTINUE_RANGES = readRanges();\nexport const LETTER_RANGES = readRanges();\nexport const LATIN_SCRIPT_RANGES = readRanges();\nexport const ARABIC_SCRIPT_RANGES = readRanges();\nexport const DEFAULT_IGNORABLE_RANGES = readRanges();\n'
        + 'const count = readVarint(), classes = new Map(); let previous = 0; for (let i = 0; i < count; i++) { previous += readVarint(); classes.set(previous, readVarint()); } export const COMBINING_CLASS = classes;\n'
    )
    out.mkdir(parents=True, exist_ok=True)
    (out / "unicode-data.js").write_text(module, encoding="utf-8")

    source_names = ["ReadMe.txt", "DerivedCoreProperties.txt", "Scripts.txt", "UnicodeData.txt", "DerivedAge.txt"]
    metadata = {
        "unicode_version": "18.0.0",
        "source": "Unicode Character Database 18.0.0",
        "source_archive_sha256": "7b3e555514060b92290d154f53655c5eb0fa62b16eb04c03434ff72d1a66a0d8",
        "source_files": {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in source_names},
        "range_counts": {
            "XID_Start": len(xid_start), "XID_Continue": len(xid_continue), "Letter": len(letters),
            "Script_Latin": len(latin), "Script_Arabic": len(arabic),
            "Default_Ignorable_Code_Point": len(ignorables),
        },
        "normalization_counts": {"combining_class_entries": len(classes)},
        "normalization_method": "ECMAScript NFD/NFC plus pinned Unicode 18.0.0 combining classes; no canonical decompositions exist for Unicode 17/18 additions.",
    }
    (out / "unicode-data-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
