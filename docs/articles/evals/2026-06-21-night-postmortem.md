# Night shift — 2026-06-21 (national rooftop + resolver/typed-schema stack)

_Living document — sketched during the shift. Window: started ~02:55 UTC, ends 15:00 UTC._

## What shipped

- **#735 national US rooftop rollout — IN FLIGHT.** Hosting the 50-state situs (#476/#567, 124.9M US address points, 29 GB) + TIGER interp shards on R2 so any US address resolves to its building (`address_point`, ≤10 m) instead of the WOF admin city centroid. Staged 48 unhosted states (skipping the already-hosted ca/ny/mi/dc), uploading 33 GB to `mailwoman/street/us/<slug>/{situs,interp}.db`. `HOSTED_STREET_SLUGS` extended to all 52 slugs (50 states + dc + vi).

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
