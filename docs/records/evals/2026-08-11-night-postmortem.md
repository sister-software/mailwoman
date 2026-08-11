# Night shift postmortem — 2026-08-11 (03:00–16:00 UTC)

The first shift after the v9.1.0 ship and the home-lab update. Conn taken 03:07 UTC on the
clean-slate handoff; the release itself was already complete (48/48 verified at shift start — the
three E404 weights packages had been published by the operator at 02:33, before the shift).

## What shipped

Nineteen merged PRs in total (#1584–#1605), three of which update this postmortem itself —
**sixteen non-postmortem PRs**, all via auto-merge on green CI; no releases, no npm publishes,
Modal $0. The first six carried the primary tasks; the rest came from the CI-fleet repairs, the
operator-directed issue sweep, and the production e2e matrix completion.

- **#1584** — docs client-bundle fix. The handoff's unresolved §4 mystery (six dark CI runs):
  filer's `read-excel-file` dependency made spliterator's XLSX vendor imports resolvable, dragging
  unzipper-esm + graceful-fs (bare `zlib`/`assert`/`constants` requires) into the demo's client
  compile. Shimmed at the vendor boundary; the alias-hash cache rotation also evicted the warm
  webpack caches that had made the failure runner-dependent.
- **#1586** — the web loader now resolves evidence-lexicon generations from the model card.
  Found verifying the repoint: the browser had been running the locality_surface channel OFF
  since the v7 lexicon rename on 2026-08-05 (tolerant 404, zero errors anywhere) — a
  locality_surface-REQUIRED model served OOD for six days. TDD, 4 new tests.
- **#1587** — board #47 closed: `--int8-weights-cache` pairs with `--weights-cache` so floors AND
  the int8 delta cap grade package-shaped in ONE run. Verified against the shipped v9.1.0 pair on
  v9.0.0-base: PASS, zero failed floors, `us.country_homograph_f1` **83.3 in both precisions**
  (the old `--model` dual read 7.1 — under-fed, floors invalid), max delta 0.3pp byte-matching the
  release's two-run evidence. Receipt: `scratchpad/gate-47-paired-verify/`.
- **#1588** — the pair-index transition HEAD probe retired per its own removal condition (both
  generation objects verified 200). Its aborted HEAD was the last console error standing between
  the strict e2e and a green run against production.
- **#1590** — the e2e suite migrated to the React-ported demo's DOM (`#addr-input` →
  `#mw-pipeline-input`, `#addr-suggest-list` → `#mw-demo-suggest-list`, heading dropped, chips
  rotated). The suite had been unable to run against prod at all.
- **#1591** — the coverage-register design record (`docs/superpowers/specs/`), the night's
  synthesis: all three runnable inferential-resolution falsifiers converged on honest per-cell
  coverage assertions as phase 1.

**Production changes beyond code:** the demo repointed to v9.1.0 — R2 + HF `defaultVersion`
flipped, 19 objects staged with every md5 verified (int8 `98a49b5c…`, Fisher `e9d77f7d…` — the R2
mirror the card's `hf+r2` owed), `postcode-de.bin` + `wof-polygons.db` carried forward, and the
manifest entry's `hasFST`/`hasPolygons`/`steps` corrected (the HF entry carried stub-probe values).
Live verification: all four lexicons 200 including `locality-surface-lexicon-v7.json`, and the
prod e2e cascade at 8/9 (the one red is pre-existing, filed #1589).

## Measurements landed (receipts under `scratchpad/`)

- **Board #17 closed** — post-fanout panel A/B (`task28/`, receipt §13): control 325/390/404 →
  new 328/393/408 @1/5/25 km, four movers, all better, zero regressions. `Weimar Thüringen`
  435 km AT → 0.00 km DE and `Rotterdam` 5704 km US → 11 km NL are new coverage-jump wins;
  `Warwick`/`Windsor` are now correct in BOTH arms (the v9.1.0 model absorbed them).
- **Falsifiers 1–3 graded** (`falsifiers/GRADING.md`, bars pre-registered per probe):
  negative evidence shrinks **1/47** missed candidate sets (35/47 wrong answers sit in unheld
  ground — the design doc's kill condition, met); naming families exist at **19.5%** of localities
  (numbered grids dominate, presidents 2%); the CPT density prior grades **WEAK/KILLED**
  (grocery MARE 59.8%, pharmacy 75.3%) and is confounded by poi.db's defaulted completeness.
- **The Nominatim NZ arm** (found complete on disk, just stopped): **58/60 @1 km** on the en-nz
  panel rows vs mailwoman's 3/60 — the two non-@1km rows are `Wellington`/`Auckland` city-only
  centroid artifacts. The missing layer is ~7,630 place nodes (963 suburbs, `Stanmore Bay` among
  them). Receipts on #1585 and in `pelias-rig/logs/`.
- **Board #33 re-measured** (`board-33-dep-locality-receipt-2026-08-11.md`): 2/13 world-board
  dep-localities now type correctly under v4.4.0 (was 0). Of the 11 misses: 5 pure typed-one-up
  (the #1278 pair-index resurrection class — no BR/MN/CO/IE/NG index exists), 2 street
  absorptions, 4 drops.
- **Board #31 verified**: exactly 4 de-de panel rows carry leading `B `/`C ` tokens
  (`C Finkeldeweg 78, 12557 Berlin` …) — frozen-panel disposition is the operator's.

## Issues filed

- **#1585** — the fuzzy typo-corrector crosses country scope under an explicit locale hint
  (`Stanmore Bay` --locale en-NZ → "Banmore", IN; five-whys verified: no candidate key, no WOF
  row, unscoped fuzzy tier). Sizing comment: mechanism fix + ~7.6k-row NZ locality shard buys
  3/60 → ~55+/60.
- **#1589** — a bare non-US postcode never probes the postcode tier (`100 00` → nothing while
  candidate.db holds Prague at 50.077/14.466; parse correct, ladder abstains).

## The CI-fleet tail (08:00–09:30 UTC)

- **Version parity had been dark FIVE DAYS under two stacked breaks** (PRs #1593 + #1594): #1451's
  APIClient migration of `check-release-parity.ts` ended the workflow's zero-install premise but
  only the script moved (daily `ERR_MODULE_NOT_FOUND`), and underneath, the script still read the
  pre-reorg `docs/articles/releases.mdx` path — the same stale-docstring trap that misdirected the
  v9.1.0 prepare preflight. Post-fix dispatch: **"All release surfaces in parity"** (npm 9.1.0 =
  demo v9.1.0 = matrix current row) — the check's first green since the reorg, and an independent
  CI verification of the night's repoint.
- **The intent-rules scaling canary hardened** (PR #1595) after its third same-night load flake
  (3.19–3.25x against the 3x bar, algorithm healthy each time): paired back-to-back arms + median
  per-pair ratio replace sequential best-of blocks; the bar itself untouched.
- The scheduled demo smoke now RUNS (unblocked by #1590) and honestly reds on the Zabiče case
  every cycle until the demo republish — flagged as an operator decision, not silently quieted.

## The issue sweep (operator-directed, 10:20–12:10 UTC)

Six issues resolved, three advanced with receipts:

- **#1491 closed** — verified already fixed (`--corpus-version` + the command-tree collision guard
  test, green).
- **#1377 closed** (PR #1596) — filer 3a residuals: the supersession docstring un-conflated
  (`sourceVintage` ≠ `validFrom`, the exact confusion the field split guards), `assertISODate`
  caller threading, `deriveClusterMembersAsOf` IN-list chunked at 8k (the adjacency map already
  membership-filters both endpoints, so the computed component is identical past the 16k
  bound-variable ceiling). filer 556/556.
- **#1371 closed** (PR #1597) — bdc build robustness, with the crash window fixed in the SHARED
  `swapDatabaseIntoPlace` (restore-on-failed-forward-rename, two new tests) so every sealed-artifact
  builder inherits it; bdc migrated onto the helper + heals an orphaned aside at build start.
- **#1559 closed** — both awk-translated shard readers verified BYTE-IDENTICAL against the real
  sources (FR stride: 501 lines; GeoNames CA admin1=10/08: 483/572 localities, the numeric-coercion
  seam included). `fr__countrywide.zip` (609 MB) + `geonames/CA.zip` now cached on the host.
- **#1507 closed** — verified already wired (check-case grades place identity; 7 world-capital
  cases live; 34/34 tests).
- **#1561 closed** (PR #1600) — the four unzip subprocesses were already migrated
  (`extractZipEntries`/`verifyZipIntegrity`); removed the dead `runCapture` and its stale
  `unzip -tq` docstring.
- **#1577 advanced** (PR #1598) — `man mailwoman` derives from the CLI's own help tree
  (freshness-tested, `package.json#man` wired); full audit comment: 8 bullets verified
  already-shipped, 2 open (data pull `--host`, progress bar), the terminal-clear unreproduced with
  pty receipts.
- **#1528 advanced to close** (PR #1599) — the derived-weights key hashes the COMPILED builder
  counterparts + the postcode pipeline dir (where #1527's fix actually lived), and a serve-time
  PCB1 floor guard evicts poisoned entries and refuses poisoned stashes (the 0-record GB
  reproduction pinned in tests).
- **#1375 advanced** — the FIRST real-PBF build-local OSM runs: DC 18 rows with an EXACT Overpass
  match (18 = 18 inside `area[wikidata=Q61]`; a naive bbox reads 51 by crossing into VA/MD),
  VT 103 rows triangulating between polygon truth (95) and bbox world (261) per the Geofabrik
  buffer; 18/18 coverage-derivation agreement. Finding fed to the coverage-register record: the
  bbox polyfill writes coverage over unsurveyed corners (VT: 1,062 cells blanketing NY/NH/MA/QC
  territory the PBF doesn't hold).
- **#1493 advanced** — evidence pinned: nothing in-tree can LOAD `fst-global-priority.bin` (317 MB,
  retirement looks free, held for the operator); the CJK three are real frozen 2026-05-28 files
  with the #1176/#1142 forks stated.

## The production e2e matrix, completed (12:00–12:20 UTC)

The migrated suite was driven to a fully-dispositioned state against the live deploy:

- **Green**: cold-load, structural render, the resolve cascade (Chicago, Berlin native-order, the
  ZIP marker, rooftop siblings), street tier, viewport bias, debug drawer, theme — with two more
  port casualties found and fixed on the way (PR #1603: the `__mailwomanDemoMap` test seam the
  viewport suite drives the real map through, dropped by the port and restored with a documented
  TEST SEAM comment; the `/debug/` trailing-slash navigation missed by #1590 because the spec
  bypasses the fixture).
- **#1602 filed (NEW model-boundary finding)**: `1502 A Cage Street, Houston, TX 77020` misses the
  situs tier on prod AND the Node path — v4.4.0 parses `street="Cage"`, `house_number="1502 A"`
  while the TX shard keys `street_norm="a cage street"`, `number="1502"`; either mismatch kills
  the keyed probe. The #48 (identifier/unit boundary) family, now with a live resolver-visible
  receipt and two lever shapes (a leading-letter-street board slice; a self-validating probe
  retry).
- **The two standing reds, not relaxed**: Zabiče SI (demo republish debt) and the autocomplete
  typeahead (port interaction drift).
- **PR #1604**: ConsoleFixture failures now NAME their resource URL (`msg.location()`) — its first
  capture resolved what had looked like an intermittent 404 into a stale-tree artifact on the
  spot.
- One CI catch on #1598 (the man page): the freshness test's cross-rootDir import (TS6059 — the
  standing vitest≠tsc lesson); moved beside its generator per the `derived-weights-key.test.ts`
  precedent.

## Decisions made autonomously

- **#47 fix shape**: paired weights-caches over feeding channel siblings into the `--model`
  branch. The `--model` path's channel semantics (repo lexicon copy, spec-driven flags) differ
  from the card-driven package-shaped semantics; changing them would silently re-anchor every
  historical `--model` floor. Pairing adds a flag and drifts nothing.
- **Demo repoint executed under the shift's delegated authority** (reversible: flip
  `defaultVersion` back). Every byte verified before and after; two latent defects found during
  verification became #1586/#1588 rather than being worked around.
- **The Modal budget was not spent** ($0 of $30): every measurement priced coverage above
  training, and no clean single-variable training expectation emerged. #29/#48 keep their
  receipts.
- **The Nominatim append ladder was stopped by the treadmill guard** (07:12): two runs (node
  cache 1000 → 4000) hit the same under-1k/s cliff at ~1.1M nodes, so the second knob was not turned
  solo. Diagnosis (append-mode COPY into a `planet_osm_nodes` btree that no longer fits the buffer
  pool) + a three-way fork recorded in `pelias-rig/logs/nominatim-append-ledger.txt`.
- **Two honest e2e reds left standing, not relaxed**: the Zabiče SI case (the demo's stale
  candidate gazetteer — Node resolves `Zabiče 8, 6250 Zabiče` to 45.508/14.369 SI correctly; the
  browser serves the pre-importance artifact) and the autocomplete typeahead (interaction drift
  beyond ids).

## What went well

- The verification-finds-defects loop: every deliverable's verification pass surfaced a real
  latent defect (repoint → #1586 + #1588; e2e → #1590 + #1589; the gate PR → the reach-around
  guard catch). None were worked around; all were fixed or filed with receipts.
- Pre-registered falsifiers did their job: two of three KILLED their own hypotheses cleanly, and
  the convergence produced a design record instead of three disconnected negative results.
- The measured-lever discipline: the append's first collapse got a measured knob (cache), the
  second identical collapse got the treadmill guard, not a third guess.

## What could've gone better

- The self-hosted CI runners share the lab host: the panel A/B flaked PR #1584's intent-rules
  SCALING test (3.19x against the `x < 3` bar), costing a rerun and serialization discipline all night. Timing
  tests are the canary; measurement harnesses and CI must not share the host's quiet hours.
- One self-inflicted CI round: my gate-test fixture spelled the node_modules layout by hand and
  the reach-around guard rightly rejected it — the guard's own prescription
  (`weightsCachePackageDir`) was the fix. Running the guard test locally before pushing would
  have saved the round.
- My falsifier-1 probe drew its population from the pre-hint-fix benchmark leg and re-derived
  components on tonight's binary — the verdict survives (stated in the receipt), but the probe
  should have pinned its leg first.
- A local/UTC timestamp slip in one mid-shift status line (caught and corrected; `date -u`
  before stamping, as the standing rule says).

## Open questions for the operator

1. **The Nominatim multi-country fork**: (a) fresh merged import (~6–10 h, replaces the live NZ
   arm, disk tight: 150–250G projected vs 229G free — measure first), (b) per-country projects,
   or (c) accept the nz-only arm and let Pelias + planet-Photon carry the multi-country picture.
2. **The demo's stale candidate gazetteer** (the Zabiče red): the browser republish (2.1 GB
   candidate.db + importance reader + `ADMIN_GAZETTEER_VERSION` bump) is the standing board row —
   schedule it?
3. **#1585 fix shape**: hint-scoped fuzzy + abstain-on-empty — approve for its own board?
4. **Panel v2's four defective DE rows** (board #31): panel v3 with re-pin, or annotate as an
   input-defect stratum?
5. **The NZ locality shard source**: LINZ (permissive, candidate-table-eligible) vs OSM
   (build-local only under the ODbL posture).

## Concrete next steps

- The coverage register (#1591's design record) — phase 1 items and its own pre-build falsifiers
  are enumerated in `docs/superpowers/specs/2026-08-11-coverage-register-design.md`.
- Extend #1278 pair indexes toward the board-#33 typed-one-up class (BR/MN/CO/IE/NG), gated on a
  WOF dep-locality coverage check per country (the WOF-currency lesson).
- The autocomplete e2e spec needs an interaction-level pass against the React port.
- `docs/articles/evals/` in the night-shift skill is stale — postmortems live in
  `docs/records/evals/` since the docs reorg (this file is the worked example).

## Numbers

| metric                     | value                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| Shift span                 | 02:59–13:09 UTC (conn 03:07; operator returned early)                                              |
| PRs merged                 | 19 total (#1584–#1605) · 16 non-postmortem · 6 primary-task (#1584, #1586–#1588, #1590, #1591)     |
| Issues closed              | 7 (#1491, #1371, #1377, #1507, #1528, #1559, #1561)                                                |
| Issues filed               | 3 (#1585, #1589, #1602); advanced with receipts: #1577, #1375, #1493                               |
| Boards closed              | #17, #47; #33 re-measured; #31 verified                                                            |
| Falsifiers graded          | 3 of 4 (f4 moot until inference exists)                                                            |
| Modal spend                | $0 of $30                                                                                          |
| NaN incidents              | 0                                                                                                  |
| CI failures on own changes | 3 (1 load flake rerun; 2 real catches — the reach-around guard, the man-page rootDir — both fixed) |
| Dark workflows healed      | version-parity (2 stacked breaks, 5 days dark); demo-smoke unblocked to an honest red              |
| Demo regressions           | 0 introduced; 2 latent defects found + fixed (#1586, #1588)                                        |
| Production state           | demo on v9.1.0 (R2+HF), all md5-verified; npm untouched                                            |
