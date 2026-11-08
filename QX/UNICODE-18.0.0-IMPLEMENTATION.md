# QX V1 — Unicode 18.0.0 implementation record

**Status: Phase 1 implementation and verification complete.**

## Decision and source

QX V1 uses Unicode Character Database **18.0.0** as its pinned Unicode data version. The generated tables were built from the supplied UCD archive.

- Archive SHA-256: `7b3e555514060b92290d154f53655c5eb0fa62b16eb04c03434ff72d1a66a0d8`
- Source-file hashes and generation counts: `engine/qx-core/src/unicode-data-metadata.json`
- Reproducible generator: `engine/qx-core/scripts/generate-unicode-data.py`

## Implemented

- Pinned `XID_Start` and `XID_Continue` properties.
- Pinned General_Category=Letter data.
- Pinned `Script=Latin` and `Script=Arabic` data.
- Pinned `Default_Ignorable_Code_Point` data.
- Pinned all non-zero canonical combining classes from Unicode 18.0.0.
- Updated the Lexer to use these tables instead of JavaScript Unicode property escapes and to report `Lexer.unicodeVersion = "18.0.0"`.
- NFC normalization uses ECMAScript NFD/NFC plus the pinned Unicode 18.0.0 combining-class table. The generator rejects Unicode 17/18 source data if new canonical decomposition mappings appear, because that would require revising the normalization implementation.
- Added tests for Unicode 18 Arabic and Latin letters, script restrictions, default-ignorable characters, canonical composition, combining-mark reordering, and Hangul.

## Verification evidence

- Existing Lexer/Parser and expression-precedence tests plus the new Unicode tests: **35 passed, 0 failed**.
- Official Unicode 18.0.0 `NormalizationTest.txt`: **100,855 NFC checks passed, 0 failed**.
- The generator reproduced the committed Unicode data module and metadata byte-for-byte.
- Runtime used for verification: Node.js 22.16.0 (runtime Unicode 16.0). The QX identifier-property tables and combining classes are pinned to Unicode 18.0.0; the NFC test suite validates the resulting behavior against Unicode 18.0.0.
- Parser files and grammar were not changed.

## Scope boundary

This record closes the Unicode data and Lexer compatibility work for Phase 1 only. It does not claim semantic analysis, type checking, command-signature validation, QIR, VM, Web Backend, or QX Studio are implemented. The next planned stage remains Phase 2: command registry and semantic analysis.
