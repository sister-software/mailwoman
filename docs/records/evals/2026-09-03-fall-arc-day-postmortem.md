# Day shift postmortem — 2026-09-03 (07:05–16:00 UTC)

The first shift of the Fall arc, driven from the git-ignored `scratchpad/HANDOFF-2026-09-03_fall-arc.md`
after a week of structural cleanup. The handoff's first item was a live demo that did not render; the
rest was pre-authorized housekeeping and a proposed order of measurements. Modal spend: $0.

## What shipped

All via PRs on auto-merge after CI; no release, no npm publish, no GPU.

- **#2093** — `@mailwoman/react` declares `styles.css` a side effect. `sideEffects: false` (#2063) let
  webpack drop the bare stylesheet import, so `/demo` rendered its map at 0 px high. Receipt #2092.
  A docs test now refuses a package stylesheet import the manifest would let webpack drop, and
  `packages/react/**` joins the docs-build path filters.
- **#2096** — MapLibre's tile worker loads from a staged same-origin copy. maplibre-gl 6 derives its
  worker URL from `import.meta.url`; the docs bundle inlines that as a `file:` path, MapLibre
  answers `""`, and `new Worker("")` spawns the page. Receipt #2095. Local build: 0 → 33 tile
  requests. A `demo-smoke.yml` dispatch against production after the deploy went green, the first since
  2026-08-20, so the daily smoke's `networkidle` timeout closed with it.
- **#2097** (#2049), **#2098** (#2047), **#2101** (#2045), **#2102** (#1942), **#2104** (#2015),
  **#2106** (#2016), and on auto-merge at the time of writing **#2103** (#1938), **#2105** (#2018),
  **#2107** (#2017), **#2108** (the declared feature count's one home, after #2104's `vi.mock` tests
  proved order-dependent under the root vitest `isolate: false`).
- **#2109** — the gauntlet resolver pins carry `poiVenueTier`, so the board-routed path can grade
  the venue tier. **#2112** (#2110, on auto-merge at the time of writing) — the venue tier's reach
  follows the anchor's grade: a unit-grade postcode hit bounds the entity to 1 km, every other admin
  or street anchor keeps 30 km.
- **#2113** (#2046) — the four layer schemas take their shared column runs from
  `@mailwoman/sqlite/schema-columns` by composition, so the two tables that interleave product columns keep
  their order; the stored DDL of all 24 tables is byte-identical before and after (7,918 bytes).
- **#2114** (#2035) — each overlay's `link-dev-weights.ts` is a manifest
  plus a call to `materializeDevOverlay`; ten scripts go from 1,143 to 540 lines, the 90-entry overlay listing
  is stable across all ten and byte-identical on a second pass, `weights.test.ts` 15 of 15.
- **#2116** — the fr-fr, en-nz and en-au manifests link the evidence lexicons their cards name and their
  `files` arrays ship; the lab overlay listing for the three locales is byte-identical before and after.

## Measurements and their verdicts

| Step           | Issue                               | Verdict                                                                                                                                 | Denominator                                                 |
| -------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1              | #1684 exp 3, GHSL habitability mask | NO-GO on the pre-registered rule                                                                                                        | 46 of 416 FIRST_PASS tail rows; 420 truth points as control |
| 2              | evidence-derivation Task 1          | PROCEED: 44 mis-tags vs 4 fold failures                                                                                                 | 61 unique locality-band coverage misses of 651 board rows   |
| 3              | #2045 ES/IT postcode systems        | shipped; board byte-stable                                                                                                              | 0 of 651 rows differ                                        |
| 6              | #2034 `队`-final census             | 109 `队`, 24 `连`, 9 `大队`, 5 `分场`; `连`/`旗`/`团` collide with names                                                                | 50,000 CN rows                                              |
| 8              | #1684 exp 2, dwell → amenity        | NO-GO on the 1.5× bar; direction holds in 60 of 60 cells                                                                                | 2,940,857 res-9 cells, five countries                       |
| 9              | #1942, #1938                        | both fixed; conformance 183 of 183; board 0 of 651 differ each                                                                          | plus ES 15-row and IT 228-row confound arms                 |
| 4 (first pass) | #1684 exp 1 via `poi_venue_tier`    | visit: 11 of 119 rows move, 2 cross tolerance, 0 regress; deliver: 1 of 424 panel rows moves (the one venue-led row), 0 of 13 trap rows | no build; the suppress branch stays undesigned              |

| 4 (treatment) | #2110 venue-tier reach | tier off vs on on the branch: 2 improve, 0 regress (routed, 651 rows); tier off, main vs branch: 0 of 651 differ; of the old reach's 17 moved rows, only Chichester is refused |

| housekeeping | #2115 street-type lexicon mismatch | the lab resolves `street-type-lexicon-v3.json` for de/es/it/in through the legacy-filename rung from files materialized in the tracked package directory, while the published overlays ship none; A/B with and without the file, board-routed: DE 0 of 12, ES 0 of 25, IT 0 of 12 differ, control 0 differ — hygiene only |

Decision packages posted, no build: #1998, #1999, #2048, and step 4 (#1684 exp 1, on #1684).

## What went well

- Pre-registering each measurement's rule and prediction on the issue before running it. Both NO-GO
  verdicts were read off a rule written earlier, and the one prediction that was wrong (exp 3's M2
  count) was scored as wrong rather than reinterpreted.
- `mwdev_compare` with two `worktree` arms is the right instrument for a source change: every fix
  here carried a 651-row board A/B plus a confound arm, and none of the four parser or codex changes
  moved a row.
- The demo triage stopped at the first failing stage twice, and the second defect only became visible
  once the first was fixed locally.

## What could have gone better

- Four commits were refused by the pre-commit lint or the CI prose rule for things a local run would
  have caught first (`selfPackageImports`, an unused export, a control escape in a regex, a banned
  word in a comment). Running `yarn health:debt`, `node scripts/verify-exports.ts` and
  `yarn lint:prose:code` before pushing costs a minute and would have saved four CI rounds.
- The first local docs rebuild replayed the old module graph from `docs/node_modules/.cache/webpack`
  and emitted a byte-identical CSS bundle; a manifest change needs that cache cleared before the
  rebuild is evidence.
- Two `pkill -f` and unquoted-variable habits from other shells cost a killed background job and one
  no-op formatter run each; both are already in memory and were still reached for.

## Decisions made autonomously

- The #1942 rule was widened from the pre-registered "letter after the comma" to "letter or digit,
  unless the comma is a numeric separator", because the registered rule left the Köln row diverging.
  The deviation is stated in the PR and graded on the same three arms.
- #2016's contract went the documented way: an inside-but-unlabelled service polygon is its own
  outcome, never agreement, because the alternative manufactures a Zone 1 reading.
- No Modal run was launched. No candidate treatment exists for the F1 family, so a control run
  would only re-measure the fine-tune row loss already on record.

## Open questions for the operator

- #2048: `formatted` at both mask-off/on callers (recommended), or the manifest moves instead.
- #1998 (re-register the three rows, recommended) and #1999 (option c, recommended).
- Step 4: confirm the parallel-channel design on #1684 before the build.

## Concrete next steps

- Step 4's cheap half is measured (11 of 119 visit rows move, 2 cross tolerance, 0 regress; the
  deliver population does not move). The remaining build is inferred intent, which the measurement
  does not yet justify.
- The venue-tier default-on decision has its issue (#2110). The routed battery through the new
  `poiVenueTier` pin (PR #2109) read 4 improve, 1 regress, `University of Chichester, The Dome, Upper
Bognor Rd, Bognor Regis PO21 1HR` landing on the Chichester campus 9.87 km away: the 30 km reach was
  sized for a locality centroid and the anchor was a unit postcode 80 m from truth. PR #2112 scales the
  reach to the anchor's grade; on the branch the routed battery reads 2 improve, 0 regress, and the
  default path is byte-stable (0 of 651). The D-rule objection is closed; default-on is the operator's
  decision, with the receipt on #2110. The two paths disagreeing on one row is the reason the routed
  battery is the one that decides.
- #1946 (comma-free segmentation) is a `computeQueryShape` change that moves every single-segment
  query; grade on the full board and all conformance suites.
- #2115: choose the hygiene fix — `copy-weights.ts` materializes only the `files` set a workspace publishes,
  or `resolveEvidenceLexicon` stops guessing the legacy filename for a card that names nothing. Neither changes
  a board row.
- #2035 was sized medium-large (the ten scripts ran 28 to 331 lines) and closed in PR #2114; en-gb keeps
  its card-conditional postcode binary beside the manifest, the one step no manifest expresses.
- #2046 closed in PR #2113 without a rebuild: composition kept the stored column order, and a DDL byte check
  on an in-memory build stood in for the per-artifact rebuild.

| Quantity                    | Value                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| Shift duration              | 07:05–16:00 UTC, with one standby for review                                                    |
| PRs merged or on auto-merge | 15                                                                                              |
| Issues filed                | 2 (#2092, #2095)                                                                                |
| Modal                       | $0, no runs                                                                                     |
| Board A/B runs              | 5 source A/Bs, all 0 of 651 rows differ; 11 config-pin A/Bs for experiment 1 and the venue tier |
| NaN incidents               | 0                                                                                               |
| CI failures on first push   | 4, all fixed on the branch                                                                      |
