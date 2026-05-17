# Golden eval set v0.1.0

Hand-labeled ground truth for the Mailwoman neural classifier. **This is the
contract for "what good looks like."** The corpus pipeline's `corpus-v0.1.0`
ships paired with this golden set; eval scripts compare classifier output to
the components in each entry.

## Files

- `us.jsonl` — US addresses (target: 500 entries).
- `fr.jsonl` — FR addresses (target: 500 entries).
- `README.md` — this file.

Each `.jsonl` is one entry per line, no trailing whitespace.

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
- `components`: per-`ComponentTag` ground truth. Surface forms must occur in
  `raw` (within fuzzy match tolerance — see alignment).
- `country`: ISO 3166-1 alpha-2.
- `source`: always `"golden"`.
- `notes`: human-readable description of what makes this entry interesting
  (edge case, dialect, abbreviation, accent, …).

`ComponentTag` is the union defined in `@mailwoman/core/types`. See
`packages/core/core/types/component.ts` for the authoritative list.

## Coverage targets (per the Phase 1 plan)

A golden entry should land in one or more of these categories. Aim for
roughly even coverage across them:

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
   It verifies every entry's components are reachable in `raw` (via the same
   `reconcileComponents` alignment helper), every tag is in the
   `ComponentTag` union, and the file shape is well-formed.
3. Open a PR. The pre-merge eval script (added later) re-runs validation +
   reports per-tag and per-source category coverage.

## Why hand-labeled, not synthesized?

Phase 1 corpus rows are derived from public data sources (WOF, BAN, OSM, …)
and carry adapter-level ground truth — but those sources have their own
biases (BAN over-represents urban France; WOF leans coarse). The golden set
is the smoke test for those biases. It's small enough to be inspected by a
human reviewer and broad enough to catch class regressions.

## Versioning

This directory is locked to `corpus-v0.1.0`. Any schema change to
`ComponentTag` triggers a new golden version (per the same rule applied to
`tokenizer-v0.1.0`).
