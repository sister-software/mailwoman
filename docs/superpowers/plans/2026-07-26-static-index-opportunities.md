# Static-index opportunities — serializing runtime decisions into sealed artifacts

**Date:** 2026-07-26 · **Status:** read-only survey (fork agent), ranked by leverage-to-effort ·
**Directive:** "every opportunity we find to serialize runtime decisions into static indexes… Who's
on First's hierarchy is under-leveraged for this sort of thing."

**Context:** the FST degenerate-surface fix is moving from decode-time guards to build-time artifact
curation (parallel session, in flight). This survey asks where else the same move pays. The healthy
systems keep this knowledge in the artifact/index layer (Carmen's index-time token hygiene, Airmail's
IDF-by-architecture, ASR bias-list pruning); the unhealthy ones arbitrate at runtime (Pelias's rule
cascade, AddrKG-LLM's prompt rulebook).

**Precedents already executed in-repo** (the mentality winning, cite these when pitching):

- `coincident-roles` (#403): a build-time relation that **replaced #387's hardcoded 15 km runtime
  constant with the gazetteer's own structure** — runtime is an O(1) membership lookup
  (`resolver-wof-sqlite/coincident-roles.ts:6-30`). The template sentence for this whole doc.
- `pair-index-gb/nz.bin`: per-country δ + `transitionBeta` calibrations live in the **artifact
  header**, not code (`neural/pair-index-resolver.ts:59-81`).
- `calibration.json` / `calibration-per-locale.json` in the weights packages; postcode anchor
  binaries; anchor/country/street-type lexicons; `postal-city-alias` tables.
- In flight: degenerate-surface exclusion at FST build time (stopwords + street-type surfaces).

---

## Ranked candidates

### 1. Serialize the street-morphology FST — `fst-street-morphology.bin` (S) — **fixes a live demo-parity drift**

- **Runtime decision today:** the street-morphology matcher is **built from scratch per process** by
  reading `core/data/libpostal/dictionaries/*/street_types.txt` off disk —
  `mailwoman/runtime-pipeline.ts:255-260` ("Built on the first pipeline call"), duplicated
  independently at `mailwoman/eval-harness/parity-corpus.ts:101-102` and
  `scripts/eval/harness-neural.ts:738`.
- **The kicker:** a repo-wide grep shows **no browser surface builds it at all** — `neural-web/`,
  `react/`, `docs/src` have zero references. The browser demo runs WITHOUT the street-context gate
  (#1315) that node runtimes apply by default. That violates standing invariant 2 ("the demo is the
  geocoder — must not silently trail"); serializing isn't just latency hygiene, it closes a real
  behavioral fork between runtimes.
- **Artifact:** `fst-street-morphology.bin` in the existing FST wire format, built by the gazetteer
  pipeline (locale-general, one artifact), shipped beside `fst-<locale>.bin` and loaded by the same
  deserialize path node + web already have (`fst-deserialize-web.ts` exists). Rough size: small —
  street-type dictionaries are a few hundred KB of text total.
- **Win:** browser/node behavior parity, no first-call build cost, kills three duplicate build call
  sites, and the parent session's curation policy applies to it uniformly.
- **WOF contribution:** none (libpostal-sourced) — included because it's the cheapest, most concrete
  instance of the mentality and it repairs an invariant.

### 2. Gazetteer-derived coverage + geometry tables replace hand-grown code constants (S/M)

Two hand-maintained tables in source re-derive what the gazetteer build already knows:

- **`HARD_PLACE_COUNTRY_SAFELIST`** (`core/pipeline/runtime-pipeline.ts:81-93`): the hard-country
  coverage guard, grown **by hand at promotes** (#928 added GB/CA; AU added with the placer class).
  The measured evidence ("US 100, FR 100, DE 100, ES 99.8 … FI 69.5, PL 77.8 (out)") lives in a
  **code comment** (`:76`) — measurement as trivia, exactly the "no load-bearing trivia" smell.
- **`COUNTRY_BBOX`** (`resolver/plausibility.ts:95-118`): per-country bounding boxes, hand-typed,
  used for coordinate plausibility. WOF carries country geometries; this is WOF data re-derived by
  eyeball.
- **Artifact home already exists:** `layer_manifest` / `layer_coverage`
  (`core/layers/manifest.ts:69,135`) — the layer contract's coverage machinery, plus the candidate
  gazetteer's own manifest. Bake at gazetteer build/eval time: per-country `hard_resolve_rate` (the
  ≥95% bar becomes a manifest query, honoring meaning-of-zero: absence = unmeasured, not
  ineligible) and per-country bbox rows.
- **Win:** the safelist updates when the gazetteer improves — at **rebuild**, not at a hand-edited
  code PR after someone remembers; plausibility boxes stop drifting from the data. Effort S for
  bbox, M for wiring the resolve-rate measurement into the build/eval loop.

### 3. Generalize the placetype-pair index across the WOF hierarchy (M) — **the operator's thesis, and Track-2 dual-use**

- **Today:** PIX1 `(child, parent)` pairs exist for one placetype in two countries — GB/NZ
  `dependent_locality` — with per-country δ + transitionBeta in the header
  (`neural/pair-index-resolver.ts:59-81`; design: `2026-07-22-placetype-census-bias.md`). Meanwhile
  the runtime recomputes hierarchical consistency piecemeal: `adminCoherence` joint re-picks,
  `region-country-coherence`, `hierarchyCompletion` ancestry walks
  (`resolver-wof-sqlite/ancestry.ts:58` `ancestorLineage`, `PLACETYPE_DEPTH:25`).
- **Artifact:** per-country pair shards for the REST of the hierarchy — `(locality, region)`,
  `(neighbourhood, locality)`, `(locality, country)` — built from WOF ancestry (+ registers where
  they exist), same PIX1 format, loader, and per-country calibration discipline. WOF's `ancestors`
  table is precisely the source; this is the "hierarchy is under-leveraged" claim made concrete.
- **Dual-use (the strategic part):** the Option-A locality evidence channel (Track 2,
  ROAD_TO §8) needs exactly this artifact as a **training-time input feature** — "this span is a
  known locality under a plausible parent present in the same input." One build feeds both the
  interim decode prior and the next-major encoder channel, so the artifact outlives the mechanism
  that first consumes it (the anti-flag-pile property).
- **Doctrine check:** soft prior, positive-evidence-only, per-country calibrated — all already
  established by the GB arc. Effort M: builders per source; format + loader + calibration protocol
  exist.

### 4. Bake surface-ambiguity (namesake/homograph) classes into FST entries (M)

- **Today:** the anchor lexicon computes a **homograph bit at build time** (country∩region — the
  established precedent). The locality-level equivalent is implicit: an FST surface like "lane"
  carries 23 accepting entries and decode has no precomputed signal that a surface is
  branch-ambiguous ("London" ON vs UK; "Paris" TX vs FR) — the namesake problem is re-litigated by
  runtime ranking every parse (population-first, #743's known ceiling for low-pop locales).
- **Artifact:** at FST build, classify each surface across its WOF hierarchy branches —
  `unambiguous / country-ambiguous / placetype-ambiguous` + branch count — and store it per entry.
  The place-table row (`resolver-wof-sqlite/fst-serialize.ts:21-22`, 56-byte rows) has a spare
  `_pad u16` — bits are available without a format break.
- **Consumers:** the FST prior (temper the positive bias by ambiguity class instead of importance
  alone — a principled cousin of the degenerate-surface exclusion), the resolver's namesake ranking
  (skip work on unambiguous hits), and the Option-A channel (ambiguity is exactly the evidence a
  model should weigh). Effort M; rides any FST rebuild.

### 5. Move caller-supplied calibrations into artifact headers (S)

- **Receipt:** `core/resolver/types.ts:353-360` documents the interpolation radius multiplier as "a
  property of the **calibration set**, not the geometry" — yet the CALLER passes it
  (`mailwoman/geocode-core.ts:640-650` resolves 1.70/per-region tables from `deps` and forwards it
  per call). The artifact whose property it is (the TIGER interpolation DB) says nothing.
- **Artifact:** calibration rows in the interpolation/situs DB manifest (the layer contract already
  gives every layer DB a manifest); readers consume from the header, callers stop carrying numbers.
  Same move the pair-index made with δ. Effort S; the per-region table shape already exists in
  code (`interpCalibrationForRegion`).

### 6. FST header carries `PLACETYPE_ORDER` + the curation policy (S — rider on the in-flight rebuild)

- `PLACETYPE_ORDER` is duplicated between `fst-serialize.ts:38` and `fst-deserialize-web.ts` (a
  recorded update-both trap). The degenerate-surface exclusion policy currently has no in-artifact
  record. Both belong in the FST header: the order table (self-describing format, kills the
  duplication) and the curation policy line (which dictionaries, which date — provenance). Zero
  standalone cost if it rides the parent session's rebuild; version-gate the format bump.

### 7. Conventions / per-locale emission masks → artifact (L — defer until it grows)

- `codex/address-system-conventions.ts` (87 lines, consumed via `addressSystemConventions: "auto"`,
  `neural/classifier.ts:432-453`) is already static-in-code and small — moving it buys little
  today. It becomes an artifact the day the locality-conditional-hierarchy direction lands
  (per-country emission masks derived from WOF ancestry statistics — the memory's "admin FST →
  per-country emission mask"). Flagged so the eventual home is planned, not accreted.

---

## Deliberately runtime — do not bake (honest flags)

- **Word-consistency heal** (`neural/word-consistency.ts:134`) — arbitration over the model's
  per-parse disagreement; input-dependent by definition.
- **`suppressGazetteerNearPostcode`** (`neural/gazetteer-inference.ts:194`) — positional choreography
  that must mirror training exactly; baking it anywhere else re-opens the train/inference split it
  exists to close.
- **`normalizeCase` detection, `bridgePunctuationGaps`** — input-shape responses.
- **`spanRescore`, `adminCoherence`, `postcodeConsistency` joint checks, `parentFallback`** —
  per-candidate-set math over live lookups; candidate 3 can **assist** them with precomputed
  admissibility, but the joint decision is genuinely runtime.
- **Coarse placer, reconcile, the model itself** — model-owns-ambiguity; artifacts inform, never
  override (registry-backed structured-prediction doctrine).

## Sequencing note

1 + 5 + 6 are small and independent; 6 rides the in-flight FST rebuild. 2 lands with the next
gazetteer rebuild cycle. 3 and 4 are the strategic pair — both feed Track 2's Option-A evidence
bundle, so their builders should be designed once, together (same WOF ancestry pass emits pair
shards AND ambiguity classes).
