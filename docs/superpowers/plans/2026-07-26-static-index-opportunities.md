# Static-index opportunities — serializing runtime decisions into sealed artifacts

**Date:** 2026-07-26 · **Status:** read-only survey (fork agent), ranked by use-to-effort ·
**Directive:** "every opportunity we find to serialize runtime decisions into static indexes… Who's
on First's hierarchy is under-leveraged for this sort of thing."

**Context:** a parallel session is moving the FST degenerate-surface fix from decode-time guards to
build-time artifact curation. This survey asks where else the same move would help. Systems that
work well keep this knowledge in the artifact or index layer: Carmen's index-time token hygiene,
Airmail's IDF-by-architecture, and ASR bias-list pruning. Systems that work poorly arbitrate at
runtime: Pelias's rule cascade and AddrKG-LLM's prompt rulebook.

**Precedents already in the repo** (cite these when proposing a candidate):

- `coincident-roles` (#403) is a build-time relation that **replaced #387's hardcoded 15 km runtime
  constant with the gazetteer's own structure**. At runtime it is an O(1) membership lookup
  (`resolver-wof-sqlite/coincident-roles.ts:6-30`). Every candidate below follows this pattern.
- `pair-index-gb/nz.bin` keeps its per-country δ and `transitionBeta` calibrations in the **artifact
  header** rather than in code (`neural/pair-index-resolver.ts:59-81`).
- The weights packages carry `calibration.json` and `calibration-per-locale.json`. Other examples
  are the postcode anchor binaries, the anchor/country/street-type lexicons, and the
  `postal-city-alias` tables.
- In flight: degenerate-surface exclusion at FST build time (stopwords and street-type surfaces).

---

## Ranked candidates

### 1. Serialize the street-morphology FST — `fst-street-morphology.bin` (S) — **fixes a live demo-parity drift**

- **Runtime decision today:** each process **builds the street-morphology matcher from scratch** by
  reading `core/data/libpostal/dictionaries/*/street_types.txt` from disk
  (`mailwoman/runtime-pipeline.ts:255-260`, "Built on the first pipeline call"). The same build is
  duplicated at `mailwoman/eval-harness/parity-corpus.ts:101-102` and
  `scripts/eval/harness-neural.ts:738`.
- **Browser gap:** a repo-wide grep shows that **no browser surface builds it at all**.
  `neural-web/`, `react/` and `docs/src` have zero references. The browser demo therefore runs
  without the street-context check (#1315) that node runtimes apply by default. That violates
  standing invariant 2 ("the demo is the geocoder — must not silently trail"). Serializing the
  matcher removes a real behavioral difference between runtimes, beyond any latency benefit.
- **Artifact:** `fst-street-morphology.bin` in the existing FST wire format. The gazetteer pipeline
  builds one locale-general artifact, ships it beside `fst-<locale>.bin`, and node and web load it
  through their existing deserialize paths (`fst-deserialize-web.ts` exists). The file is small,
  since the street-type dictionaries total a few hundred KB of text.
- **Win:** browser and node behave the same, the first-call build cost disappears, three duplicate
  build call sites go away, and the parent session's curation policy applies to the matcher
  uniformly.
- **WOF contribution:** none, since the data is libpostal-sourced. The candidate is included because
  it is the cheapest and most concrete example in this survey and it restores an invariant.

### 2. Gazetteer-derived coverage + geometry tables replace hand-grown code constants (S/M)

Two hand-maintained tables in source re-derive what the gazetteer build already knows:

- **`HARD_PLACE_COUNTRY_SAFELIST`** (`core/pipeline/runtime-pipeline.ts:81-93`) is the hard-country
  coverage guard. It has been **extended by hand at each promotion** (#928 added GB/CA, and AU was
  added with the placer class). The measured evidence ("US 100, FR 100, DE 100, ES 99.8 … FI 69.5,
  PL 77.8 (out)") lives in a **code comment** (`:76`), where a reader must remember it instead of
  querying it.
- **`COUNTRY_BBOX`** (`resolver/plausibility.ts:95-118`) holds hand-typed per-country bounding boxes
  for coordinate plausibility. WOF carries country geometries, so these boxes re-derive WOF data by
  hand.
- **An artifact home already exists:** `layer_manifest` / `layer_coverage`
  (`core/layers/manifest.ts:69,135`), which is the layer interface's coverage implementation, plus
  the candidate gazetteer's own manifest. The gazetteer build or eval would write per-country
  `hard_resolve_rate` and per-country bbox rows. The ≥95% bar then becomes a manifest query. A
  missing row means unmeasured rather than ineligible.
- **Win:** the safelist updates at **rebuild** when the gazetteer improves, instead of waiting for
  someone to remember a hand-edited code PR. The plausibility boxes stop drifting from the data.
  Effort is S for bbox and M for wiring the resolve-rate measurement into the build/eval loop.

### 3. Generalize the placetype-pair index across the WOF hierarchy (M) — **the operator's thesis, and Track-2 dual-use**

- **Today:** PIX1 `(child, parent)` pairs exist for one placetype in two countries (GB/NZ
  `dependent_locality`), with per-country δ and transitionBeta in the header
  (`neural/pair-index-resolver.ts:59-81`; design: `2026-07-22-placetype-census-bias.md`). The
  runtime recomputes hierarchical consistency in several places: `adminCoherence` joint re-picks,
  `region-country-coherence`, and `hierarchyCompletion` ancestry walks
  (`resolver-wof-sqlite/ancestry.ts:58` `ancestorLineage`, `PLACETYPE_DEPTH:25`).
- **Artifact:** per-country pair extracts for the rest of the hierarchy: `(locality, region)`,
  `(neighbourhood, locality)` and `(locality, country)`. They would be built from WOF ancestry, plus
  registers where they exist, with the same PIX1 format, loader and per-country calibration. WOF's
  `ancestors` table supplies these pairs directly, which is the concrete form of the operator's
  claim about the hierarchy.
- **Dual use (the strategic part):** the Option-A locality evidence channel (Track 2, ROAD_TO §8)
  needs this artifact as a **training-time input feature** meaning "this span is a known locality
  under a plausible parent present in the same input." One build feeds both the interim decode
  prior and the next-major encoder channel. The artifact therefore outlives the first mechanism that
  consumes it, which avoids adding another decode flag.
- **Design constraints:** the prior is soft, uses positive evidence only, and is calibrated per
  country. The GB arc already established all three. Effort is M: each source needs a builder, and
  the format, loader and calibration protocol already exist.

### 4. Bake surface-ambiguity (namesake/homograph) classes into FST entries (M)

- **Today:** the anchor lexicon computes a **homograph bit at build time** for country∩region
  surfaces, which is the established precedent. Locality surfaces have no equivalent. An FST surface
  like "lane" carries 23 accepting entries, and decode has no precomputed signal that a surface is
  branch-ambiguous ("London" ON vs UK, "Paris" TX vs FR). Runtime ranking resolves the namesake
  question again on every parse (population-first, with #743's known ceiling for low-population
  locales).
- **Artifact:** at FST build, classify each surface across its WOF hierarchy branches as
  `unambiguous / country-ambiguous / placetype-ambiguous`, with a branch count, and store the class
  per entry. The place-table row (`resolver-wof-sqlite/fst-serialize.ts:21-22`, 56-byte rows) has a
  spare `_pad u16`, so the bits fit without a format break.
- **Consumers:** the FST prior could scale its positive bias by ambiguity class instead of
  importance alone, which is a principled relative of the degenerate-surface exclusion. The
  resolver's namesake ranking could skip work on unambiguous hits. The Option-A channel could use
  the class directly, since ambiguity is evidence a model should weigh. Effort is M, and the change
  can go into any FST rebuild.

### 5. Move caller-supplied calibrations into artifact headers (S)

- **Evidence:** `core/resolver/types.ts:353-360` documents the interpolation radius multiplier as "a
  property of the **calibration set** rather than the geometry". The caller still passes it:
  `mailwoman/geocode-core.ts:640-650` resolves 1.70 or the per-region tables from `deps` and
  forwards the value on each call. The TIGER interpolation DB, which the value describes, does not
  record it.
- **Artifact:** calibration rows in the interpolation/situs DB manifest. The layer interface already
  gives every layer DB a manifest. Readers take the value from the header, and callers stop carrying
  numbers. The pair index made the same change with δ. Effort is S, and the per-region table shape
  already exists in code (`interpCalibrationForRegion`).

### 6. FST header carries `PLACETYPE_ORDER` + the curation policy (S — rider on the in-flight rebuild)

- `PLACETYPE_ORDER` is duplicated between `fst-serialize.ts:38` and `fst-deserialize-web.ts`, and
  both copies must be updated together. The degenerate-surface exclusion policy has no record in the
  artifact. Both belong in the FST header. The order table makes the format self-describing and
  removes the duplication. The curation policy line records provenance: which dictionaries and which
  date. If this goes into the parent session's rebuild, it adds no extra cost. Version-check the
  format bump.

### 7. Conventions / per-locale emission masks → artifact (L — defer until it grows)

- `codex/address-system-conventions.ts` (87 lines, consumed via `addressSystemConventions: "auto"`,
  `neural/classifier.ts:432-453`) is already static and small, so moving it gains little today. It
  should become an artifact when the locality-conditional-hierarchy direction lands, with per-country
  emission masks derived from WOF ancestry statistics (the memory's "admin FST → per-country
  emission mask"). It is listed here so its eventual home is planned in advance.

---

## Deliberately runtime — do not bake (direct flags)

- **Word-consistency heal** (`neural/word-consistency.ts:134`) arbitrates the model's per-parse
  disagreement, so it depends on the input by definition.
- **`suppressGazetteerNearPostcode`** (`neural/gazetteer-inference.ts:194`) applies positional rules
  that must mirror training exactly. Moving it anywhere else would reopen the train/inference gap it
  exists to close.
- **`normalizeCase` detection and `bridgePunctuationGaps`** respond to the shape of the input.
- **`spanRescore`, `adminCoherence`, the `postcodeConsistency` joint checks and `parentFallback`**
  compute over each candidate set from live lookups. Candidate 3 can **assist** them with
  precomputed admissibility, but the joint decision happens at runtime.
- **The coarse placer, reconcile and the model itself** own ambiguity. Artifacts inform them and
  never override them (the registry-backed structured-prediction design).

## Sequencing note

Candidates 1, 5 and 6 are small and independent, and 6 can go into the in-flight FST rebuild.
Candidate 2 lands with the next gazetteer rebuild cycle. Candidates 3 and 4 are the strategic pair.
Both feed Track 2's Option-A evidence bundle, so their builders should be designed together, with
one WOF ancestry pass emitting both the pair extracts and the ambiguity classes.
