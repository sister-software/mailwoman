# Delimited address joins for the record-matcher — the #694 flip evidence

`ingestRows` space-joins a multi-column address mapping into one concatenated run
(`"214 JONES RD ELKHART TX 75839"`). That strips the parser's only segmentation signal, and it
interacts badly with the #690 all-caps case-normalization: on comma-less input, title-casing **craters**
the geocode. #699 shipped the fix as a default-OFF capability (`IngestOptions.addressSeparator`). This
is the evidence for flipping the record-matcher's geocode callers onto it.

## The setup

The cross-dataset correlation (`scripts/record-matcher/cross-dataset-correlation.ts`, #618) ingests four
TX-scoped sources (TX HHSC facilities, FCC RHC posted-services, NPPES org NPIs, FCC RHC commitments —
1200 records, 300/source) through the real parser + resolver, and counts entities spanning ≥2 sources.
Four configs, same script, same data:

| config | join  | #690 case-norm | geocode rate | rooftop (Σ of 1200) | entities | cross-source links |
| ------ | ----- | -------------- | -----------: | ------------------: | -------: | -----------------: |
| A      | space | off            |     **100%** |      579 (baseline) |      839 |                 23 |
| A+     | space | **on**         |  **39.2%** ⚠ |                   — |        — |                 12 |
| B      | comma | off            |     **100%** |           610 (+5%) |      837 |                 23 |
| C      | comma | **on**         |     **100%** |      **667 (+15%)** |      825 |             **25** |

## What it says

**1. Space-join + #690 craters (config A+).** Title-casing a concatenated all-caps run
(`"214 JONES RD ELKHART TX 75839"` → `"...Rd Elkhart Tx 75839"`) destroys segmentation: geocode rate
falls 100% → 39.2%, cross-source links 23 → 12. This is the #694 trap, and it's why #690 was **never**
wired into the geocoder.

**2. Comma-join eliminates the crater (B, C).** With `addressSeparator: ", "`, the parser gets delimited
input and the geocode rate holds at 100% with **or without** #690. The crater is gone.

**3. Comma-join + #690 is the best config (C) — +15% rooftop over the current baseline.** Delimiting
alone lifts rooftop 579 → 610 (the parser segments better with commas); adding #690 lifts it again to
**667 (+15% over A)**, and cross-source links 23 → **25** (fcc-rhc ↔ nppes 1 → 3). The gain is
concentrated exactly where it should be — the all-caps sources, where #690 fixes the OOD parse:

| source                           | A (space) | B (comma) | C (comma + #690) |              A→C |
| -------------------------------- | --------: | --------: | ---------------: | ---------------: |
| txhhsc-nursing (100% all-caps)   |       135 |       145 |          **167** |          **+32** |
| nppes                            |       107 |       110 |          **150** |          **+43** |
| fcc-rhc (~46% all-caps)          |       132 |       147 |              142 |              +10 |
| fcc-rhc-commitments (mixed-case) |       205 |       208 |              208 | +3 (byte-stable) |

The mixed-case source barely moves (detection doesn't fire), and the all-caps sources gain the most
rooftop precision — exactly the #690 contract, delivered cleanly once the input is delimited.

## The flip

The evidence supports flipping the record-matcher's geocode ingest to **`addressSeparator: ", "` +
`normalizeCase`**: no crater, +9% rooftop precision, links hold/improve. Caveats for the migration
(tracked on #694):

- It changes the parsed address string → re-validate the matcher's clustering at scale (here, links
  held at 23 and rose to 25, but a larger run should confirm).
- The dedup GBT was trained on space-joined strings; anything that feeds GBT training/eval must be
  re-baselined if flipped. The capability stays **default-OFF** until that migration is deliberate.

_Source: `scripts/record-matcher/cross-dataset-correlation.ts` (--comma-address, --normalize-case);
diagnostic `scripts/eval/geocode-case-diag.ts` (comma-less title-case 150→17 vs delimited 150/150)._
