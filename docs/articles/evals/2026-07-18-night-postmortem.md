# Night postmortem — 2026-07-18 (v7 ship + Latin-locale expansion + v8 planning)

_Drafted during the shift; living document. Operator handed the conn ~night; hourly cron `3a3d942a` fires at :13._

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
