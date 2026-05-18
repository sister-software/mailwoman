# Golden eval set v0.1.0

Hand-labeled ground truth for the Mailwoman neural classifier. **This is the
contract for "what good looks like."** The corpus pipeline's `corpus-v0.1.0`
ships paired with this golden set; eval scripts compare classifier output to
the components in each entry.

## Files

- `us.jsonl` — US addresses (target: 500 entries).
- `fr.jsonl` — FR addresses (target: 500 entries).
- `adversarial.jsonl` — graceful-failure + kryptonite cases per Phase 1.6 §3
  (#22). Seeded with 54 entries across the four adversarial categories below.
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

## Adversarial categories (`adversarial.jsonl`)

Each entry in the adversarial file lands in exactly one category — the
`notes` field begins with `kryptonite/<subtype>:` or
`graceful/<subtype>:` so eval scripts can stratify.

**`kryptonite/place-name-venue`** — venue token shared with locality.
"Buffalo Health Clinic, …, Buffalo, NY 14201". Model must label first
Buffalo as venue, second as locality.

**`kryptonite/place-shaped-venue`** — venue contains a multi-token
sub-string that looks like a complete address. "Paris, Texas Steakhouse,
…, Houston, TX 77002". The actual locality+region is later in the line;
the place-shaped prefix is venue.

**`kryptonite/particle-honorific`** — apostrophe + St./Saint /
Mt./Mount / Ft./Fort / directional-initial ambiguity. Same surface form
plays different syntactic roles in venue vs street vs locality. E.g.
"P'tit St. Denis Street Café" — venue's "St." is an honorific, not a
street_prefix.

**`kryptonite/disambiguation`** — locality alone (or locality+region)
that could resolve to many real places. Ground truth matches what was
written, not what is most famous.

**`graceful/typo`** — single-char edits or transpositions on a clean
address. "Pensylvania" → still recoverable; the model should produce
the same parse with marginally lower confidence.

**`graceful/mis-casing`** / **`graceful/mis-punctuation`** —
all-uppercase, commas removed, comma-separated-no-spaces, dot-as-
separator. Heavy load on token-boundary heuristics.

**`graceful/whitespace`** — runs of multiple spaces inside the address.
The model must collapse internal whitespace.

**`graceful/no-commas`** — separator-stripped form, common in legacy
systems.

**`graceful/label-prefix`** / **`graceful/contamination`** /
**`graceful/trailing-junk`** — extraneous noise around the address.
Tokens of noise should land `O`.

**`graceful/attention`** — "c/o" forms. Lands on the `attention`
component.

**`graceful/unit`** — non-standard unit designators (hyphenated, hash-
prefixed, multi-part building+suite).

**`graceful/country`** — dotted "U.S.A." variants on the country line.

The per-entry `notes` field also documents _what the model should
ideally do_ on each adversarial case — including when partial-parse +
low-confidence-flag is the right answer rather than a full but wrong
parse.

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
