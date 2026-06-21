# Night shift — 2026-06-21 (national rooftop + resolver/typed-schema stack)

_Living document — sketched during the shift. Window: started ~02:55 UTC, ends 15:00 UTC._

## What shipped

- **#735 national US rooftop rollout — ✅ SHIPPED + LIVE-VERIFIED (`99b8c5a4`).** Hosted the 50-state situs (#476/#567, 124.9M US address points) + TIGER interp shards on R2 (33 GB, 95 objects, `mailwoman/street/us/<slug>/{situs,interp}.db`) and extended `HOSTED_STREET_SLUGS` to all 52 slugs (50 states + dc + vi). Any US address now resolves to its building (`address_point`, ≤10 m) instead of the WOF admin city centroid. Deploy green; **live e2e 4/4** on production (TX/GA/WA/MT resolve to the building, ≤600 m of the situs truth). The flagship "type any US address, get the building" experience is national.
- **#734 EU-recall characterization — ✅ posted to the issue.** Quantified the candidate EU recall (18-country holdout, 20,056 rows): TOTAL 87.8%, but **LT = 0% is a pure eval-format artifact** (33k LT rows exist; the holdout carries Lithuanian type-suffixes `mstl./m./k.` + genitive case the gazetteer never uses) — excluding LT, recall ≈ **93.7%**, matching the issue's claim. Corrected the lever: the real residual (AT 74%, FI 80%, SK 78%) is **coverage DEPTH** (city districts/sub-localities) + **bilingual-name aliases** (Koper-Capodistria), NOT qualifier-strip widening.
- **#175 typed-schema arc closed — ✅ browser reader typed.** `httpvfs-resolver.ts`'s candidate rows now project the shared `CandidateTable` (via the exported `@mailwoman/resolver-wof-sqlite/candidate-schema`), so the writer↔reader column contract is compile-checked on all three consumers (build / Node / browser). The hot writers (`build-unified-wof` 1.5M-row ingest + backfills) stay positional on purpose — perf, same call as `build-candidate`'s clustered load.
- **#530 typo-inject augmentation — ✅ SHIPPED (`ec2f4d38`).** Implements the Phase-1-deferred stochastic augmentation. The deferral asked for a "seed-aware API so the corpus stays reproducible"; resolution: seed the PRNG (mulberry32) from the row's own `source_id` — deterministic per row, no global state, the `(row) => CanonicalRow | null` signature stays unchanged. Injects ONE realistic typo (adjacent-QWERTY-key sub OR adjacent-char transposition) into a single alpha-name component, applied to BOTH `raw` and the component so the `alignRow` substring contract holds. The alignment round-trip test caught a real bug: "Cupertino" (locality) is a substring of "Cupertino Avenue" (street), where a naive first-occurrence `replace` corrupts the wrong span — fixed by requiring the value occur exactly once in `raw` and not be a substring of another component. Wired into the default (locale-agnostic) set + the AUGMENTATIONS registry. Verified: corpus 450/450, tsc -b clean. **NOTE for operator:** this changes the DEFAULT corpus distribution — the next corpus build emits a typo'd variant per eligible row. Deterministic so reproducible; one line in `defaultAugmentationsForCountry` to tune the rate or gate it. Pairs with #531 (the retrieval half — scoped, not built tonight).

## What went well

- **Real rooftop, validated locally before the e2e.** Pulled a real address from each test state's shard (TX/GA/WA/MT), and all four resolve `address_point` with the building coord = the shard coord exactly (TX 29.7747,-95.3350 1 m). The e2e (`210-national-rooftop.spec.ts`) grades the assembled coordinate within ~600 m — tight enough to fail a centroid fallback.

## What could've gone better / friction

- **`il` vs `il-cook`.** The national build split Cook County out (OOM avoidance), but `il.db` (4.86M rows) ALREADY contains Cook/Chicago (632k Chicago rows) while `il-cook.db` (1.46M, 612k Chicago) is a separate, overlapping build — merging would dup. Decision: **host `il.db` alone** (complete state incl. Cook); `il-cook` is a stale/ambiguous artifact to investigate, not a rollout blocker.
- **Stale `out/` broke the CLI locally.** After checking out main for the shift (without recompiling), `out/commands/tiger/fetch.js` (from my prior tiger-branch work, NOT on main) was orphaned in `out/` and pastel still loaded it → `fetchTIGER` import crash. `tsc -b` doesn't delete orphaned outputs. Fixed by removing the stale dir. Local-tree only (a fresh clone of main is fine) — but a second instance of the "stale compiled artifact" class this week (cf. the demo `core/out` footgun). Worth a `compile:clean` after any branch switch.

## Decisions made autonomously

- IL: host `il.db` alone (above).
- Skip re-uploading the 4 already-hosted states (ca/ny/mi/dc) — identical content, saves bandwidth.

## Open questions

- `il-cook` provenance — is it a higher-quality Cook source meant to replace `il`'s Cook rows, or a redundant build? (File an issue; not blocking.)
- **#739 (tiger-fetch) — BLOCKED on release-ordering, flagged on the PR.** Code is clean (corpus 444/444); CI red on the `ci:smoke` clean-install guard (#596) because the new `@mailwoman/tiger` workspace isn't on npm, so the published CLI 404s on it. Needs an operator call: publish `@mailwoman/tiger` in the same release, OR make it private/bundled. Not force-merged.
- **#531 (typo-tolerant retrieval) — scoped, not built.** The FTS path already has trigram-Jaccard fuzzy; the candidate path (now the demo/CLI default) has none, and its `WITHOUT ROWID` B-tree clusters alphabetically (not by edit-distance), so a fuzzy fallback needs a NEW trigram/spellfix side-index + a candidate rebuild + a browser fetch-cost measurement — bigger than a night-shift item. Design follow-up. **#530 (the parser-side half — teach the MODEL to tolerate typos in the surface) is now SHIPPED** (above); #531 is the retrieval-side half (recover the gazetteer hit when the *parsed* token is itself misspelled). They're complementary, not substitutes.

## Concrete next steps

- Finish the upload → run the `210` e2e gate (build with the 52-slug `resources.tsx`, serve :7770) → if green, commit `resources.tsx` + the spec → push (deploy) → live-verify a TX rooftop on production.
- Then the secondary stack: typed-schema follow-through, #739 merge, #531 typo-tolerant, #475 postal_city, #734 EU-recall, hygiene.

## Numbers

| metric                      | value                 |
| --------------------------- | --------------------- |
| shift window                | 02:55 UTC → 15:00 UTC |
| states hosted (street tier) | 4 → 52 (in flight)    |
| situs upload                | 33 GB, 48 states      |
| Modal $ / GPU               | $0 (no-GPU plan)      |
| CI failures / regressions   | 0 so far              |
