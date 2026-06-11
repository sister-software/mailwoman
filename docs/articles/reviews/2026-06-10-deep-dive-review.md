# Mailwoman deep dive: docs, implementation, and the road to a geocoder

**Date:** 2026-06-10 · **Scope:** full-repo technical review (docs site, parser implementation, resolver/data layer, training+eval pipeline) plus external geocoder-landscape research. Produced from five parallel review passes; this document is the synthesis.

---

## Verdict

The model refactor has earned the word "mature" — and the external research backs it harder than expected: **no open-source geocoder ships a neural parser in production**. Every published neural-vs-libpostal comparison (Huppert's SOTA survey, Continuity's transformer parser, the arXiv fraud-detection work) reaches the same conclusion mailwoman bet on: transformers beat CRFs exactly where real geocoder queries live (typos, prefixes, degraded input), at under 80 MB instead of libpostal's 2.2 GiB. The ONNX-in-browser parser is ahead of the field, not behind it.

The Elasticsearch-free architecture is also no longer a contrarian bet. Pelias's Placeholder/PIP sidecars exist _because_ ES can't do admin hierarchy; Photon just finished a multi-year forced OpenSearch port; Nominatim 5.0 (Feb 2025) shipped as a pip-installable library; addok serves all of France from Redis+SQLite in 6 GB. The field is drifting toward "geocoder as a library" — which is what the ancestors-table-in-SQLite design already is.

The weaknesses are not in the model or the architecture. They are operational: **stale doc entry points, a reproducibility crater in training, scattered promotion gates, and three missing geocoder table stakes** (interpolation, reverse, autocomplete integration). All fixable; none require rethinking the design.

One calibration note from the research: the incumbent moved. Senzing retrained libpostal's CRF in 2024–2025 (~1.2B records, +4% avg accuracy, up to +87% per-country, Apache 2). Parity claims should benchmark against _that_ model, not the 2017 weights the current arenas use.

---

## 1. Documentation

**Strong:** the concept layer is genuinely rich — 34 concept articles, the "Understanding" section (falsehoods, why-neural, alternatives-rejected), and the decision-record spine from #467 (`closed-vocab-fields-model-first.mdx` + parity-endgame + knowledge-ladder) form a coherent, current narrative around model-first + soft anchors. Architecture documentation scores ~8/10.

**Weak:** the _entry points_ and _operational_ layers.

| Issue                        | Detail                                                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AGENTS.md dead links         | `docs/plan/README.md`, `docs/plan/reference/`, `docs/evals/` all moved to `docs/articles/...` (and `SCHEMA.md` → `SCHEMA.mdx`). The canonical onboarding file 404s on its three "read this first" pointers. |
| `status.mdx` ~6 weeks stale  | Claims shipped model is v0.4.0 / npm 3.0.0; reality is v4.1.0 npm with the v0.9.x line at v0.9.13. Training-state section frozen in May.                                                                    |
| No version↔capability matrix | Nothing maps npm versions → model lineage → features (anchors, unit coverage, calibration). The model-version vs npm-version split confuses every reader.                                                   |
| No operational runbooks      | 92 eval reports but no "to evaluate your change, run X"; corpus/training docs scattered across 4 files with no retrain runbook; the gazetteer-anchor implementation isn't cross-linked from its design doc. |

**Top doc fixes by ROI:** (1) fix AGENTS.md paths (30 min), (2) versions/capabilities matrix page, (3) refresh `status.mdx` + link the parity scorecard as the live truth, (4) a CONTRIBUTING_MODEL_WORK runbook (eval harness + lever taxonomy + shard recipe), (5) cross-link gazetteer-anchor design ↔ implementation.

---

## 2. Parser implementation

**Strong.** The 6-stage runtime pipeline (`mailwoman/runtime-pipeline.ts` → `core/pipeline/runtime-pipeline.ts`) composes via injection — every stage optional with graceful defaults, workspace boundaries respected. Anchor and gazetteer features are _additive_ model inputs with zero-filled fallbacks (the architectural intent of "soft anchor, never override" is visible in the code, not just the docs). `build-tree.ts` is robust: boundary trimming, same-tag whitespace merge (the Saint-Paul fix), distance-based parent attachment. Three lossless serializers. ~755 tests.

**Ranked weaknesses:**

1. **`parse()` vs `parseWithLogits()` duplication** (`neural/classifier.ts:157` vs `:240`) — ~78 identical lines (anchor/gazetteer build, prior stacking, viterbi). Worse: only `parse()` runs postcode/unit repair, so reconcile consumes _unrepaired_ labels — design intent undocumented, latent divergence bug. Extract a shared `buildTokens()` helper.
2. **TLA in `core/resources/libpostal.ts`** — the known fragility surface; `Graph.ts` already dodges the barrel import to avoid it. Lazy-load `availableLanguages` behind an async getter and the whole class of vitest/bundler cycle bugs disappears.
3. **`__isCompiledTree` path-sniffing** (`core/utils/repo.ts:42`) — breaks on output-dir or symlink changes; discovered only at runtime.
4. **Policy registry**: `applyPreferenceFilters` (~30 lines, the rule/neural dedup core) has no tests, and per-component neural rollout requires code changes — no config surface for A/B-ing `neural_preferred` per tag.
5. **Reconcile's classifier contract is still a mock** — `ClassifierCandidate` top-k is hand-built in tests; no production path emits it yet. Flag before the real wiring lands.
6. Smaller: `ParseOpts` not exported (typo-silent options), gazetteer lexicon parsed without schema validation, grouper penalty hardcoded at 0.55.

---

## 3. Training + eval pipeline

**Operationally mature, structurally fragile.** The corpus build is deterministic with full lineage (manifests + SHAs, locality-holdout splits, synth ancestry tags); training deps are pinned (the v4.1.0 Safari-opset set); the eval ledger (`evals/scores-by-version.json`) is current through v0.9.13 with corpus/eval-set SHAs per run. The eval inventory is huge: 40+ harnesses spanning name-match, coordinate error, PIP containment, calibration, per-locale tripwires.

**The five risks, ranked:**

1. **No clone-and-train path.** Corpus shards, tokenizer, anchor/gazetteer lookups all live on R2/Modal/`/mnt/playpen` with hardcoded paths. A fresh agent cannot reproduce v0.9.12 from the repo. → `REPRODUCIBILITY.md` + publish corpus snapshots beside model releases.
2. **Gate scatter.** Each config carries its own pre-registered gate comment; execution is manual night-shift discipline, not CI. One `promotion-gate.sh` that parses the config's gate block and runs the listed scripts would turn lore into enforcement — and auto-append to the ledger on pass.
3. **Curriculum state unlogged.** Anchor/gazetteer confidence ramps are step-aware; a resume mid-ramp silently changes training dynamics and nothing records which curriculum a checkpoint saw. Stamp curriculum state into the model card; assert on resume.
4. **Overlay shard resolution fails silently.** Overlay manifests cross-reference base corpora by absolute path; the loader's glob fallback means a moved base corpus trains on the wrong data without erroring (the v0.7.1 trap, still open). Add strict mode + explicit `base_corpus_version` lineage.
5. **Int8 toolchain pinning is undocumented.** The value_info-strip fix and the Safari-WebGPU opset≤17 invariant live in code comments; a well-meaning dep bump re-breaks iOS undetected. Add a version-verification script + a toy export/quant CI check.

Eval-hygiene lore (tokenizer-F1 incomparability, name-match vs coordinate truth, German native-order rendering) is _partially_ encoded in tooling (`--tokenizer` flag, `de-order-eval.sh`, honest-eval) — better than memory-only, but the promotion-gate consolidation is what makes it survivable.

---

## 4. Distance to a full geocoder

Capability checklist (evidence-based, from the resolver/data-layer pass):

| Capability                               | Status                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Freeform forward geocoding (admin-level) | **Shipped** — parser → WOF resolver → coords/IDs/confidence, 7 priority countries, HTTP `/api/resolve`                                                                                                                                                                                             |
| Structured forward                       | Partial — admin components only; no street/house-number resolution                                                                                                                                                                                                                                 |
| Fuzzy/typo tolerance                     | Shipped (FTS5 BM25 + trigram soft-match + the neural parser itself)                                                                                                                                                                                                                                |
| Postcode resolution                      | Shipped (anchor posterior, postcode→locality, mismatch detection)                                                                                                                                                                                                                                  |
| Confidence                               | Partial — per-component calibrated + resolver score; no end-to-end composition (commercial norm: Mapbox-style per-component match codes — the isotonic work maps directly onto this)                                                                                                               |
| **Autocomplete**                         | **Missing as a product** — `fst-autocomplete.ts` exists (prefix walk, importance-ranked) but is unwired. This is the highest-traffic endpoint of every production geocoder. BIO tagging is awkward on 3-char prefixes: serve prefixes from the FST tier, engage the parser past a token threshold. |
| **House-number interpolation**           | **Missing** — the single biggest coverage gap vs v0/Pelias. TIGER data already ships; Karlsruhe-schema ranges cover OSM. Scoped at ~2–3 weeks for a prototype.                                                                                                                                     |
| **Reverse geocoding**                    | **Missing** — but `wof-polygons.db` + the PIP machinery already exist; this is assembly, not research.                                                                                                                                                                                             |
| Batch API                                | Missing (cheap, universally expected)                                                                                                                                                                                                                                                              |
| Service abstraction / multi-instance     | Missing — in-process sync SQLite; `RemoteResolver` adapter pattern declared in `core/resolver/types.ts` but unimplemented                                                                                                                                                                          |
| Data update pipeline                     | Operator-driven builds; no delta sync                                                                                                                                                                                                                                                              |

**Data strategy (new input from research):** Overture's address theme is nearing GA — 455M pre-conflated address points (OpenAddresses + agencies) under permissive terms, with stable GERS UUIDs, plus a divisions theme. Adopting Overture as the conflation layer for the _address/street_ tier (keeping WOF for hierarchy) would sidestep both bespoke OA ingestion and the ODbL share-alike question, and make results joinable to the ecosystem (Esri/Precisely already link via GERS). Design the gazetteer schema so a place row can carry a GERS ID alongside the WOF ID. Licensing note: per the OSMF guideline, serving geocode results from OSM-derived data does _not_ infect customer databases (insubstantial extracts) — only systematic bulk extraction re-triggers ODbL.

---

## 5. Recommended roadmap

**Phase A — Consolidate the parser win (now → ~2 weeks).** Land #466/#468 (affix-ml shard + gazetteer choreography) into the consolidation retrain; re-benchmark the arenas against Senzing's retrained libpostal; cut the v1.0-parity model. This finishes the campaign already in flight — don't start geocoder work mid-retrain.

**Phase B — Hygiene sprint (~1 week, parallelizable).** AGENTS.md links + status.mdx + version matrix; `promotion-gate.sh` + ledger auto-append; REPRODUCIBILITY.md; strict shard resolution; `buildTokens()` dedup + libpostal TLA removal. Cheap, and everything after gets safer.

**Phase C — Geocoder table stakes (~6–8 weeks).** In order of leverage: (1) house-number interpolation off TIGER (biggest coverage win, gate on honest-eval coord p50 dropping from ~10 km admin-centroid toward street-level), (2) reverse geocoding off wof-polygons.db (symmetric tree output), (3) autocomplete endpoint wiring the existing FST tier with parser engagement past a token threshold. Add batch as a thin layer over all three.

**Phase D — Data + service maturity (~quarter).** Overture/GERS conflation layer for addresses; RemoteResolver + multi-instance deployment; delta-sync builds; observability (latency SLOs, per-country coverage metrics, periodic honest-eval on production traffic). addok (full France, 6 GB RAM, minutes to deploy) is the ops-simplicity benchmark to cite and beat.

**Positioning:** "the geocoder that's a library" — pip/npm-installable, embedded SQLite, runs in the browser, no ES cluster. Nominatim 5 legitimated the frame; nobody owns it with a neural parser.

---

_Review passes: docs editorial+accuracy, parser implementation, resolver/geocoder gap, training+eval pipeline, external landscape (Pelias/Nominatim/Photon/addok/Airmail/Overture, with sources). Agent transcripts available in session history._
