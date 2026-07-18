# Night postmortem — 2026-07-18 (v7 ship + Latin-locale expansion + v8 planning)

_Drafted during the shift; finalized at hand-off. Window: ~01:30–11:55 UTC (2026-07-18). Cron `3a3d942a` cancelled at wrap._

## What shipped / landed

- **v7.0.0 SHIPPED** (npm all 12 workspaces, GitHub release, tag, SBOM). Package-only major (model stays 6.5.0/v381). Rules parser + classifiers excised. OPEN operator action: `npm deprecate @mailwoman/classifiers` (needs operator npm auth — my session is E401).
- **Docs/spec:** releases.mdx v7.0.0 row (#03c0a169 on main); deepparse-locale-gap spec merged (#1174) + corrected (#1175, NZ rank).
- **Two v8 epics filed:** #1176 (non-Latin/CJK threshold), #1177 (weights sharding).

## The Latin-locale expansion (toward v7.1.0)

**NZ — FORKED, not stuck.** The recipe/corpus/pipeline all work (300k synth-nz rows, country=NZ 100%, `B-dependent_locality` in 72% of BIO labels). But **two 2k probes (v382, v383) both no-op on the target**: `dependent_locality` = 0.0% emission. Ruled out every silent-drop mechanism (shard loaded, source in the multinomial, labels present, coarse_filter passes, argmax decode). Root cause = **dead-tag prior**: v381 never emits `dependent_locality` (confirmed on a live NZ parse); 2k @ LR 1e-5 can't resurrect a deeply-negative output row. Treadmill guard hit → stopped knob-spinning. See `memory/project-nz-dependent-locality-dead-tag.md`.

- **The fix is a STAGE4 mechanism, not a knob** — Fable's #1100 design independently prescribes a _fresh-head param-group LR_ for new/dead output tags (the #727 scar). NZ `dependent_locality` is the first instance of the exact "add/resurrect an output tag" problem #456+#1100 need. Options: (a) re-init the B/I-dependent_locality output row + dedicated head LR; (b) map NZ suburb→locality (accept the shipped distinction-loss, a working locality); (c) fold into a STAGE4 bump.

**CA/MX — v7.1.0 CANDIDATE, VETTED, STAGED (v385 latam 8k).** Overture ingest landed clean (CA 16.8M, MX 30.7M, BR 89.9M, no token); CA/MX use the existing `overture` adapter with LIVE `locality`+`postcode` (no dead-tag). Built `v0.13.0-latam` (456k-row `overture-latam` shard, own source weight so the trained EU `overture` rows aren't diluted) → 2k probe (net-positive) → 8k resume. **Grade: MX locality +8.7 (74.0→82.7, native-order), CA neutral (free); golden 2pp PASS (only `country` −1.6, sub-threshold, recovered from 2k's −2.0); gauntlet 33/33 + same known-xfail profile as shipped (US #1101 held).** ALL GUARDS PASS. Evidence: `2026-07-18-v710-camx-latam-grade.md`. **Promote (HF+npm v7.1.0) = operator's call — staged, not shipped.** BR dropped (0% OA-lineage license + `SN (CASA N)` garbage numbers). MX/BR/CA locality semantics were audited (CA/MX clean; NZ needed the districtAsLocality remap).

## Three Fable plans (all in `scratchpad/`, all decisive)

1. **v8 CJK (`v8-cjk-architecture-plan.md`):** CharCNN char-encoder (internal, already half-built in `model.py`, #825) + script-routing (boundary). Reject multilingual-tokenizer. Latin model byte-identical → provable no-forgetting. Char-level is SMALLER (collapses the 73k embedding = 72% of the model). JP schema already declared. KR may be the cheapest FIRST non-Latin ship (whitespace-separated). Biggest risk: JP kanji BIO-alignment (no whitespace) → hand-check 50 rows.
2. **Sharding (`sharded-onnx-research.md`):** not a size problem yet — a DUPLICATION one (fr-fr ships a byte-identical 39MB copy of en-us; +4 locales = +4 copies). Fix = `neural-weights-base-latn` + thin overlays. Cheapest proof: restructure fr-fr as the first overlay (md5-identical). Phase B (the CJK model as the 2nd shard) = shared with #1176.
3. **Secondary-address / vertical axis (`secondary-address-vertical-axis-design.md`, #1100):** batch #456+#1100 into ONE Latin STAGE4 (union is a free superset; trained vocab is append-only). Keep CJK out of the Latin vocab. Ordinal = resolve-time (`codex/level-semantics.ts` already shipped `levelToOrdinal`). 6 new tags (33→45 BIO). Cheapest first ship = decode-time codex unit-splitter, NO retrain. Unnamed risk: vertical **identity** (address-id hashes the surface; matcher has no unit-agreement field) — a must-key-equal/differ fixture board is the acceptance spec.

## Late-night additions (post-v7.1.0, ~08:00–10:30 UTC)

- **BR (v7.2 candidate) — BUILT clean but FAILS the guard (country trade).** Overture BR shard clean (210k rows, house_number 96%, country=BR/source=overture-latam, CDLA-Permissive-2.0 license). Trained the full LATAM 8k (v386, CA+MX+BR, `output-v386-latam-br`). **Golden 2pp gate FAILS: `country` −5.3pp** (211/245 vs shipped 224); all else flat. v385 (CA/MX only) was country −1.6 (PASS) → BR pushed it over. **Mechanism:** the `overture-latam` source at weight 6.0 now carries 3 new countries' surfaces, and the #1104 country channel over-reacts (accumulating new-country mass degrades US/FR country recall). **BR is NOT a clean add as-is.** The clean v7.1.0 = CA/MX (v385) stands.

**ROOT CAUSE (diagnosed, no-GPU) — the fix is now precise:** the CA/MX/BR shard rows carry **0% country labels** (verified: 0/456k CA/MX, 0/210k BR — Overture addresses are country-implicit, all bare street+locality+postcode). The country lexicon DOES include Canada/Mexico/Brazil (not the gap). So the mechanism is **country-emission dilution**: 666k country-token-less rows at `overture-latam` weight 6.0 teach the model that "no country present" is normal → it under-emits country → US/FR golden country recall drops. It scales with the country-less mass (−1.6 at 456k → −5.3 at 666k), which is why v7.1.0 (CA/MX) passes and v7.2 (+BR) fails on the same axis.

**The fix (day-shift, cheap):** give the LATAM rows country-token exposure — an **international-order variant that appends the country** (`…, Canada` / `…, México` / `…, Brasil`) for a fraction of rows. This is exactly what the `locale` recipe's `intl-fraction` does (it's why DE/FR/etc. don't dilute country); the bare `overture` adapter lacks it. Add an intl-fraction to the overture adapter → rebuild the LATAM shard → retrain → country recovers, and BR (and larger LATAM) becomes a clean add. This ALSO makes v7.1.0's −1.6 a known, fixable nick (a v7.1.1 with country-bearing rows would zero it). (After BR the Overture Latin frontier is closed — Fable.)

- **#1177 Phase-A dedup POC** (`poc/fr-fr-weights-overlay`, `3c339af7`): fr-fr resolves the shared en-us model instead of a 35.8MB copy; **md5-proven identical**; retires 36MB; **also fixes #1117** (fr-fr's stale link-dev-weights pin). Branch for operator review.
- **v8 non-Latin de-risk — DATA PIPELINE FULLY GREEN** (`2026-07-18-v8-jp-phase0-alignment-derisk.md`): (a) alignment — 1,060 JP rows, 46 prefectures, 100% clean field→char-span, 0 collisions, NO segmenter needed (Fable's named biggest risk retired); (b) corpus-build — `alignRow` produces correct char-offset spans for JP kanji (rural + urban chōme), #555 doesn't bite kanji. **The JP corpus is buildable now.** KR NOT executable (no Overture-KR data) → **JP-first is the only non-Latin path.** Remaining v8 work is TRAINING-side: the built CharCNN is Latin-char-_word_ shaped; JP needs a char-_level_ encoder/loader/model rework + two schema decisions (address_levels→region/prefecture; `2-3-16` house_number vs sub_block-split) — a **day-shift design arc**, deliberately held for operator sign-off rather than rushed pre-handoff.

## Decisions made autonomously

- Shipped v7.0.0 (dry-run gate green first). Filed #1176/#1177. Corrected the NZ spec premise (#1175).
- Ran two NZ probes; STOPPED on the treadmill after the second no-op rather than blind-escalating to 8k.
- Used the Fable window (operator-authorized until ~midnight) for 4 consults: v8 CJK, sharding, secondary-address, (NZ resurrection folded into #1100's finding).

## Open questions for the operator

1. `npm deprecate @mailwoman/classifiers` (needs your npm auth).
2. NZ `dependent_locality`: resurrect via STAGE4/head-LR, or remap suburb→locality? (b) ships faster; (a) is the "right" schema and coincides with the #456/#1100 STAGE4.
3. Promote calls: any v7.1.0 (CA/MX/BR) model is staged for your gate, never self-shipped.

## Next steps (the cron drives)

- Build CA/MX/BR overture shards → overlay → one STAGE-3 multi-locale run (CA+MX+BR, LIVE tags) → export → grade (emergence + golden 2pp guard) → stage v7.1.0. (NZ excluded until the dead-tag call.)
- Optionally: the fr-fr→overlay dedup proof (Phase A of #1177 — one evening, md5-provable, retires npm bytes).

## Numbers

Modal: NZ v382+v383 probes (2×2k) + 4 exports/quantizes. 4 Fable consults + several forks. 0 NaN. 0 regressions shipped (v383 guard PASS; nothing promoted). Uncommitted: NZ recipe + configs + sync_nz (branch, not main; fix COUNTRY_SOURCES.NZ path first).
