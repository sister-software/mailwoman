# GB postcode resolution vs OS Code-Point Open — 2026-08-18

The first UK accuracy measurement this project can run without licensed data, published with its
limits stated before its numbers.

**Contains OS data © Crown copyright and database right 2026** (Code-Point Open, Open Government
Licence v3, acquisition 2026-08-05).

## What this measures, and what it cannot

1. **The truth and the gazetteer share a source.** Mailwoman's GB postcode tier is built from
   Code-Point Open (`codepoint-shard.ts`), so grading answers against Code-Point centroids does not
   measure independent coordinate accuracy — it measures the **pipeline end to end**: does a messy,
   real-shaped postcode string come back as the right unit-postcode point through
   parse → retrieval → resolution? That is the engine's claim. The coordinates' accuracy is
   Ordnance Survey's.
2. **The OSGB36 → WGS84 conversion cancels.** Truth is converted by the same `@mailwoman/spatial`
   routine the shard build uses (pinned against the OSTN15 test set in its own suite), so a
   systematic conversion bias would be invisible here.
3. **Premise-level accuracy is out of reach.** A unit postcode covers tens of properties and no
   open GB register grades a rooftop answer. Thresholds are postcode-scale. This is the boundary
   of what open GB data permits, and measuring up to that boundary — rather than asserting past
   it — is the point of the record.

## Method

- **Sample:** 600 unit postcodes — a seeded draw (`mulberry32(20260818)`), 5 from each of the 120
  Code-Point area files, so London does not drown Orkney. Positional-quality-90 rows (no
  coordinate available) are excluded, matching the shard build. Northern Ireland is not in
  Code-Point Open and is therefore not in this record.
- **Legs per postcode:** as published (`SW10 0AA`); lowercased and unspaced (`sw100aa` — the user
  register); country-suffixed (`SW10 0AA, UK`); and a **typo leg** — the final letter stepped to
  its successor. 348 of the 600 mutants turn out to be real neighbouring units (measured, not
  assumed — the first draft of this leg reasoned "mutants almost never exist" and was wrong by
  58%); those are out of the typo leg's scope. The remaining **252 phantom postcodes must
  ABSTAIN**: a "corrected" postcode is a different postcode, and snapping `BT3 9QQ` to `S3 9QQ`
  is the trap this leg exists to catch.
- **Configurations:** the shipped pipeline (`mailwoman` 9.1.0, model v4.4.0) at production
  defaults under two locales — `en-US` (the out-of-the-box default) and `en-GB`.
- **Grading:** haversine distance to the Code-Point centroid; a no-result is a miss at every
  threshold. Harness: `packages/mailwoman/eval-harness/gb-codepoint-eval.ts` (seeded, re-runnable;
  results JSONL committed to the lab eval store).

## Results

### `--locale en-GB`

| leg                  | n   | resolved | ≤1 km                 | ≤5 km   | ≤25 km  | median km |
| -------------------- | --- | -------- | --------------------- | ------- | ------- | --------- |
| as published         | 600 | 600      | **600/600**           | 600/600 | 600/600 | 0.00      |
| lowercased, unspaced | 600 | 600      | **600/600**           | 600/600 | 600/600 | 0.00      |
| `, UK` suffixed      | 600 | 600      | **600/600**           | 600/600 | 600/600 | 0.00      |
| typo (252 phantom)   | 252 | —        | **252/252 abstained** |         |         |           |

Every sampled postcode, in every input shape, resolves to its own unit-postcode point — the 0.00
medians are the circularity of section 1 working as described, and the claim they support is
retrieval fidelity, not coordinate accuracy. Every phantom postcode abstains; none is "corrected"
into a different real postcode.

### `--locale en-US` (production default)

| leg                  | n   | resolved | ≤1 km                 | ≤5 km   | ≤25 km  | median km |
| -------------------- | --- | -------- | --------------------- | ------- | ------- | --------- |
| as published         | 600 | 597      | 597/600               | 597/600 | 597/600 | 0.00      |
| lowercased, unspaced | 600 | 600      | **600/600**           | 600/600 | 600/600 | 0.00      |
| `, UK` suffixed      | 600 | 600      | 592/600               | 592/600 | 592/600 | 0.00      |
| typo (252 phantom)   | 252 | —        | **252/252 abstained** |         |         |           |

The eleven failures were one defect, named with receipts rather than averaged away: under the
`en-US` default the model occasionally tagged a GB postcode's outward code as `street` and its
inward code as `house_number` (`KT2 6AB` → street "KT2" + house_number "6AB") — **even though the
query-shape stage detected `uk_postcode` at 0.9 confidence and the kind classifier said
`postcode_only` at 1.0**. With no postcode span in the tree, the bare form resolved nothing
(3/600); the `, UK` form resolved only the country token and answered the United Kingdom label
centroid, 27–221 km off (8/600). The `en-GB` locale decoded all eleven correctly.

**Fixed the same day** (#1735, `dd74a3a73`) with two rungs — a parse-side repair that consumes the
shape/tree contradiction, and an explicit-country pre-scope in the resolver walk (the suffixed
failures were a sibling-scope gap: the country node resolved to GB while the postcode lookup ran
under the locale-inferred US filter beside it). Post-fix, the production default matches `en-GB`:
**600/600 on every leg**, phantom abstention unchanged at 252/252, and the full regression board
shows three rows changed — all improvements — and zero regressions. The pre-fix table above is
kept as the record of what the eval found; finding it was this record's purpose.

## Re-run

```
node packages/mailwoman/eval-harness/gb-codepoint-eval.ts --stamp 2026-08-05 --per-area 5 --seed 20260818
```

Requires a Code-Point Open acquisition under `$MAILWOMAN_DATA_ROOT/codepoint/<stamp>/` (the
acquisition tooling records its own manifest and checksum) and the shipped GB postcode shard.
