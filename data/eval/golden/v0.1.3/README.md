# Golden eval set v0.1.3

Hand-labeled ground truth for the Mailwoman neural classifier. This set defines the expected
output. Eval scripts compare classifier output to the components in each entry.

## What changed in v0.1.3 (2026-08-06)

US street spans are now labeled with the split convention. The rest of this file is carried forward
from v0.1.2. The `convention` block in `MANIFEST.json` is the authoritative statement of the
convention. `REVIEW-DECK.md` lists the rows that changed, and
[SCHEMA.mdx](../../../../docs/engineering/reference/SCHEMA.mdx) describes the interface.

`6220 SE Salmon St` is four components instead of two: `house_number` `6220`, `street_prefix` `SE`,
`street` `Salmon`, `street_suffix` `St`. v0.1.2 folded the prefix and the type into `street`, which
disagreed with the corpus that trains the model. The eval scorer hid the mismatch by joining the
model's spans back together before comparing. As a result, the v9.0.0 candidate failed its promotion
check on `us.street` because of the labeling convention. Its parse was not the cause.

`mailwoman corpus golden-relabel` (`corpus/src/tools/golden-relabel-street.ts`) produced this
version from v0.1.2 by splitting on the USPS Pub-28 table in `@mailwoman/codex/us`. The relabel
changed 1,907 of 2,956 US rows, and 140 rows carry a review flag. **FR rows are byte-identical to
v0.1.2.** This relabel did not address French street typology.

A scorer that folds `street_prefix`/`street`/`street_suffix` back together does not grade against
this answer key. `packages/mailwoman/lib/dev-tools/per-locale-f1.run.ts` reads the declaration in
`MANIFEST.json` and scores split-convention rows without folding them.

Numbers here are not comparable with v0.1.2 numbers. The evaluation spec that grades
against this key is `mailwoman/eval-harness/specs/v9.0.0-base.json`.

## Files

- `us.jsonl` — US addresses (target: 500 entries).
- `fr.jsonl` — FR addresses (target: 500 entries).
- `adversarial.jsonl` — graceful-failure and kryptonite cases from Phase 1.6 §3 (#22). It was
  seeded with 54 entries across the four adversarial categories below.
- `README.md` — this file.

Each `.jsonl` file has one entry per line and no trailing whitespace.

## Schema (per entry)

```jsonc
{
	"raw": "1600 Pennsylvania Avenue NW, Washington, DC 20500",
	"components": {
		"house_number": "1600",
		"street": "Pennsylvania Avenue NW",
		"locality": "Washington",
		"region": "DC",
		"postcode": "20500",
	},
	"country": "US",
	"source": "golden",
	"notes": "the White House — canonical street + state-abbrev + ZIP",
}
```

- `raw`: the address string a classifier sees.
- `components`: ground truth keyed by `ComponentTag`. Each surface form must occur in `raw`, within
  the fuzzy-match tolerance of the alignment helper.
- `country`: ISO 3166-1 alpha-2.
- `source`: always `"golden"`.
- `notes`: a human-readable description of what makes this entry interesting (edge case, dialect,
  abbreviation, accent, …).

`ComponentTag` is the union defined in `@mailwoman/core/types`.
`packages/core/core/types/component.ts` holds the authoritative list.

## Coverage targets (per the Phase 1 plan)

Each golden entry should fall into one or more of these categories. Aim for roughly even coverage
across them:

- Residential (single-family, urban, rural)
- Commercial / business
- PO boxes
- Intersections (no number)
- Venues (parks, transit, named buildings)
- Single-line variants (no commas)
- Multi-line variants (newlines)
- Abbreviations (state, directional, road type)
- Typos (single-char edits, ~5% of entries)
- Accent variations (FR; US Spanish-origin names)
- Non-standard casing (all lower, all upper)
- US-specific: ZIP vs ZIP+4, state name vs alpha-2, directional N/S/E/W/NW/etc.
- FR-specific: CEDEX, arrondissement notation (Paris 8e ↔ 75008), particle
  variants (Rue de la République ↔ Rue République)

## Contribution workflow

1. Add new entries to `us.jsonl` or `fr.jsonl` as JSON objects (one per line).
2. Run the validator:
   ```sh
   npx mailwoman corpus validate-golden data/eval/golden/v0.1.0/
   ```
   The validator checks that every entry's components are reachable in `raw` (using the
   `reconcileComponents` alignment helper), that every tag is in the `ComponentTag` union, and that
   the file is well-formed.
3. Open a PR. The pre-merge eval script (added later) re-runs validation and reports coverage per
   tag and per source category.

## Adversarial categories (`adversarial.jsonl`)

Each entry in the adversarial file belongs to exactly one category. Its `notes` field begins with
`kryptonite/<subtype>:` or `graceful/<subtype>:` so that eval scripts can stratify results.

**`kryptonite/place-name-venue`**: the venue shares a token with the locality. In "Buffalo Health
Clinic, …, Buffalo, NY 14201", the model must label the first Buffalo as venue and the second as
locality.

**`kryptonite/place-shaped-venue`**: the venue contains a multi-token substring that looks like a
complete address. In "Paris, Texas Steakhouse, …, Houston, TX 77002", the actual locality and
region come later in the line, and the place-shaped prefix is part of the venue.

**`kryptonite/particle-honorific`**: ambiguity from apostrophes, St./Saint, Mt./Mount, Ft./Fort
and directional initials. The same surface form plays different roles in a venue, a street or a
locality. For example, in "P'tit St. Denis Street Café" the venue's "St." is an honorific instead
of a street_prefix.

**`kryptonite/disambiguation`**: a locality alone (or a locality and region) that could resolve to
several real places. The ground truth matches what was written, even when a more famous place shares the name.

**`graceful/typo`**: single-character edits or transpositions on a clean address, such as
"Pensylvania". The model should produce the same parse with slightly lower confidence.

**`graceful/mis-casing`** / **`graceful/mis-punctuation`**: all-uppercase text, removed commas,
commas without spaces, and dots as separators. These cases test token-boundary heuristics.

**`graceful/whitespace`**: runs of multiple spaces inside the address. The model must collapse
internal whitespace.

**`graceful/no-commas`**: the address with separators stripped, which is common in legacy systems.

**`graceful/label-prefix`** / **`graceful/contamination`** / **`graceful/trailing-junk`**:
extraneous noise around the address. Noise tokens should be labeled `O`.

**`graceful/attention`**: "c/o" forms, which belong to the `attention` component.

**`graceful/unit`**: non-standard unit designators (hyphenated, hash-prefixed, or multi-part
building and suite).

**`graceful/country`**: dotted "U.S.A." variants on the country line.

The per-entry `notes` field also describes _what the model should ideally do_ on each adversarial
case. For some cases, a partial parse with a low-confidence flag is the right answer instead of a
full but wrong parse.

## Why hand-labeled rather than synthesized?

Phase 1 corpus rows come from public data sources (WOF, BAN, OSM, …) and carry adapter-level
ground truth. Those sources have their own biases: BAN over-represents urban France, and WOF is
mostly coarse. The golden set tests for those biases. It is small enough for a human reviewer to
inspect and broad enough to catch class regressions.

## Versioning

This directory is locked to `corpus-v0.1.0`. Any schema change to `ComponentTag` requires a new
golden version, following the same rule as `tokenizer-v0.1.0`.
