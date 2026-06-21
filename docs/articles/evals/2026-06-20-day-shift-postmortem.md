---
title: "Day shift 2026-06-20 — EU coverage + the byte-range candidate gazetteer"
---

# Day shift 2026-06-20 — postmortem

Two arcs shipped today, both measurement-led: closing the EU coordinate gap with **coverage, not GPU**, and moving the browser demo's admin tier off FTS onto a **byte-range candidate gazetteer** that resolves a place in ~12 range fetches instead of 243.

## What shipped

### 1. EU coverage — zero GPU

- **The lever was coverage, not a retrain.** The Three-Gap Matrix + a held-out coordinate eval (`scripts/eval/eu-coord-direct.ts`) showed the 15 zero-DB EU locales' median coordinate was reachable from gazetteer coverage alone; the "21% broken" was a loc-correct (whole-parse) artifact, not the coordinate. The #566 trap, avoided. See `project-eu-coverage-not-retrain`.
- **Overture divisions → the canonical admin DB.** Built the divisions-theme gazetteer, folded the ingest into the canonical build (`build-unified-wof.ts --overture-countries`), and rebuilt + swapped `admin-global-priority.db`: **+15 EU locales (299 k divisions) + TW (16,750)**, with the 10 priority countries **byte-identical** to the prior DB and the US resolver eval **unchanged** (loc 97.6 / region 99.9 / coord p50 3.3 km). Median coordinate solved 14/15 at ES/IT/NL control parity (0.4–7.1 km).
- The `overture` corpus adapter (#470) was realized along the way (`mailwoman corpus run overture`), and the build manifest records the new source for reproducibility.

### 2. The byte-range candidate gazetteer — retired the slim `wof-hot.db`

- **The measurement that started it.** Byte-ranging the full 2.6 GB admin DB worked but cost **243 serial range fetches / 16.5 MB per session** — FTS postings for a common name scatter across the file, and `requestChunkSize` tuning made it _worse_ (over-fetch). The slim DB was cheaper only because it was small + US/DE/FR-only.
- **DeepSeek consult (2 turns) → a precomputed candidate table.** Explode each place's normalized name + aliases + region abbrevs + US postcodes into one `WITHOUT ROWID` B-tree keyed on `name_key`, population rank precomputed, rows denormalized (name, centroid, bbox) so a resolve is one contiguous probe. Measured: **~12 fetches / 0.9 MB per session**, **490 MB single file, global coverage**, US locality **96.8 %** (region-bbox disambiguation), EU coord parity **88.6 %**.
- **Shipped end-to-end:** the `mailwoman-wof-build-candidate` CLI (TS port of the prototype), the `WofCandidateTableLookup` resolver (a drop-in for the slim httpvfs lookup), the demo wiring, and the **retirement of the slim build** (`build-slim` / `--wof-hot` / `SLIM_COUNTRIES` removed; polygons sourced from `--admin`). A Cloudflare WAF range-rule guards the 490 MB object from full-file downloads. See `project-candidate-table-byte-range`.
- **Browser e2e green (4/4):** Chicago locality, ZIP-only marker, the Berlin regression, and the White-House no-fail check — all in headless Chromium against the live R2 object.

## Key decisions

- **Candidate table over both alternatives.** It beat the full-DB byte-range (243 → 12 fetches) _and_ the slim (global coverage, no `SLIM_COUNTRIES` upkeep). The decision was the spike number, not the estimate.
- **Coverage over a GPU retrain for EU.** The falsification made the retrain (#148) unnecessary for the coordinate; it stays on HOLD.
- **US-only postcodes in the candidate table**, matching what the slim carried; international postcodes are country-gated by the resolved locality so an ambiguous ZIP (10115 = Berlin DE _and_ NYC) can't drag a German address to Manhattan.

## What went well

- **Verify-before-verdict paid out repeatedly.** The spike caught 243 fetches against my ~1 MB estimate; the e2e caught the postcode regression _before_ the slim was torn out; the US A/B gate proved the admin-DB swap was byte-identical before promotion.
- **The consult earned its keep.** DeepSeek's candidate-table structure was the structural win; we trusted the structure and tested the numbers ourselves.

## What could've gone better

- **Lockfile drift went to CI red.** The new `mailwoman-wof-build-candidate` bin changed workspace metadata yarn 4 records in the lockfile; the staged-scoped pre-commit hook missed it and `yarn install --immutable` failed in CI. Run `yarn install --immutable` after adding a bin/export.
- **WAF propagation lag read as a bug.** The rule was correct on the right zone the whole time; testing within ~60 s of creation showed it not blocking. Cloudflare custom rules take a few minutes to reach all edges.
- **`PRAGMA page_size` was a no-op.** `node:sqlite` initializes the file at the 4096 default before the pragma runs; set it right before `VACUUM`.
- **Immutable-cache churn.** Three candidate-DB version bumps (`-20` → `-20a` → `-20b`) for re-uploads, because the object is `immutable` and needs a fresh URL each rebuild.

## Open / next

- **~11 % EU surface-variant recall** — the candidate table is exact-normalized-name; names like "Costa de Caparica" vs the gazetteer's "Costa da Caparica" miss. Mitigable with richer alias coverage.
- **DE/FR postcodes** in the candidate table (currently US-only; international postcodes fall to the locality centroid).
- A `build-candidate` unit test (the `build-slim.test.ts` convention).

The candidate-table story is written up as a Research Log post: [243 round trips to find a city](/research/243-round-trips-to-find-a-city).

## Numbers

|                            | value                                                 |
| -------------------------- | ----------------------------------------------------- |
| byte-range fetches/session | 243 (full DB) → **12** (candidate)                    |
| candidate DB size          | 490 MB (vs 2.6 GB full / 53 MB slim), **global**      |
| US locality accuracy       | 96.8 % (region-bbox)                                  |
| EU coord parity / median   | 88.6 % / solved 14/15                                 |
| admin-DB swap regression   | 0 (priority counts byte-identical, US eval unchanged) |
| GPU spent                  | **0**                                                 |
| DeepSeek                   | 2 turns (v4-pro)                                      |
| browser e2e                | 4/4 green                                             |
