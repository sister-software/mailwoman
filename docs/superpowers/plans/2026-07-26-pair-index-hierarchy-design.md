# Pair-index across the WOF hierarchy — design + probe build

**Date:** 2026-07-26 · **Status:** design + built probe artifact (survey candidate #3,
`2026-07-26-static-index-opportunities.md`) · **Branch:** `feat/night-pair-hierarchy` ·
**Scope:** design and probe only. This work adds no decode wiring and changes no defaults or
weights-package contents.

**Dual mandate (why this artifact, per ROAD_TO §8):** the same (child, parent) pair set serves two
consumers:

- **(a)** a future decode-time soft prior, which extends the PIX1 GB/NZ `dependent_locality`
  mechanism (`neural/placetype-pair-prior.ts`) to more hierarchy edges.
- **(b)** the Option-A **locality evidence channel** (Track 2), a training-time per-span input
  feature meaning "this span is a known locality under a plausible parent present in the same
  input". The channel sits inside the evidence bundle with the street-type channel. Neither channel
  is decisive alone, and an evidence-ablation invariance check guards the bundle.

One build can outlive the first mechanism that consumes it. The survey cited this as the reason the
artifact avoids adding another decode flag.

## What exists today (the base being generalized)

PIX1 (`neural/pair-index-resolver.ts`) is a flat binary: magic, JSON header, then sorted
`(child, parent, tagIdx)` records. Names are `u16`-length-prefixed UTF-8, and `probe()` is Map-backed. The
header carries per-country calibration (`delta`, optional `transitionBeta`), provenance
(`sourceMD5s`, `buildDate`), and `foldVersion`/`schemaVersion`. Two artifacts exist, for GB and NZ.
Both are register-built (PPD and LINZ) and both cover `(dependent_locality, locality)` in tag space.
The builder command is `mailwoman gazetteer pair-index`, which reads a tuples CSV.
`mailwoman/gazetteer-pipeline/pair-index.ts` owns fold, dedupe and holdout.

The WOF admin DB (`dataRootPath("wof", "admin-global-priority.db")`, read-only) has an `ancestors`
table with `(id, ancestor_id, ancestor_placetype)` for every place. It also has `spr` (name,
placetype, country, currency flags) and `names` (per-language variants with an `official` bit). The
`ancestors` table can supply per-country pairs for every hierarchy edge the registers don't cover.

## Design decisions

### D1 — one artifact per (country, edge-type) rather than one multi-edge artifact

`pair-index-<childTag>-<parentTag>-<cc>.bin` (probe: `pair-index-locality-region-us.bin`). Rationale:

1. **Calibration is per-edge.** `delta` (and `transitionBeta`) live in the header as scalars, as
   the artifact-header calibration convention requires. A multi-edge file would need a per-edge δ
   map, which breaks the `PairIndexLike` interface (`readonly delta?: number`) and every consumer of
   it. Different edges will calibrate differently. A (locality, region) hit is weaker evidence than
   a register-built (dependent_locality, locality) hit, because region names are a tiny closed set
   that co-occurs with almost any locality.
2. **Independent shipping cadence.** (locality, region) can calibrate and ship while
   (neighborhood, locality) is still on the bench. A multi-edge artifact couples their release.
3. **The entry tag does not identify the edge.** Entries carry only the child's `ComponentTag`, so
   (locality, region) and a future (locality, country) both emit `locality`. Per-edge files make
   the edge unambiguous without a format change. A multi-edge file would need a per-entry edge field
   (a real PIX2).
4. **Loading stays simple** for both consumers. Decode auto-wire keeps one file per pattern. The
   training channel builder consumes N small files per country and reads each file's edge from its
   header.

The cost is a handful of files per country instead of one. At 3–4.5 MB per (locality, region) file,
the biggest edge dominates the aggregate size either way.

### D2 — serialization: PIX1 reused verbatim, extension rides the header JSON

`neural/pair-index-resolver.ts` does not change. The extension keys follow the `transitionBeta`
precedent. Absence-tolerant readers parse the header JSON and ignore unknown keys, so
**`schemaVersion` stays 1**:

```jsonc
{
	"country": "us",
	"delta": 0, // probe artifacts are UNCALIBRATED — zero on purpose, see D5
	"schemaVersion": 1,
	"foldVersion": 1,
	"sourceMD5s": ["<md5 of admin-global-priority.db>"],
	"buildDate": "2026-07-26T21:42:19.712Z",
	// --- hierarchy extension keys (new, absence-tolerant) ---
	"edge": { "child": "locality", "parent": "region" }, // ComponentTag space
	"source": {
		"kind": "wof-ancestors", // vs the registers' implicit kind on GB/NZ
		"db": "admin-global-priority.db",
		"childWOFPlacetypes": ["locality"],
		"parentWOFPlacetypes": ["region", "macroregion"], // FR; US is ["region"]
		"namePolicy": "spr-name+official-names-v1",
	},
	"probeArtifact": true,
}
```

- `edge` is in **tag space**: it says what a hit resolves to and what the channel feature means.
  `source.*WOFPlacetypes` is in **WOF space**: it says what was extracted. The two are separate on
  purpose. FR's `region` ComponentTag covers both WOF `region` (départements, such as
  "Ille-et-Vilaine") and WOF `macroregion` (régions, such as "Bretagne"), and either surface is a
  region-tagged parent in a French address. The builder owns the per-country WOF mapping and
  records it in the header.
- `source.kind` matters because the same tag-space edge can come from two sources. The shipped GB
  (dependent_locality, locality) artifact is **register-built**. A WOF `neighbourhood`-ancestry
  build of the same edge would be a geographic sibling with different evidential weight. Per-country
  calibration decides which one ships, and the header records which one a file holds.
- Country scoping is unchanged from PIX1. The header stores `country`, and the consumer checks it.
  `loadFromWeights` peeks the header and skips construction on a mismatch. An input without country
  context gets no bias, per the census-bias design's decision 5.
- **Per-edge delta = per-file delta** (D1), so this never needs a schema change.

### D3 — name policy: `spr.name ∪ official names` (`spr-name+official-names-v1`)

The surfaces for each place are the `spr.name` default plus every `names` row with
`official = 1`, for child and parent alike. The policy uses both for these reasons:

- `spr.name` alone breaks FR. WOF's default names for FR macroregions are anglicized ("Brittany",
  "Upper France", "Great East"), and French addresses do not contain them. The official names
  ("Bretagne", "Hauts-de-France", "Grand Est") are the in-country surfaces, and official-language
  names are the established name-exact evidence class (#936).
- Official names alone under-cover. About 5k of 160k US localities have no `official=1` row, and
  `spr.name` fills them.

Measured effect (lower() SQL projection): US 137,511 → 138,439 (+0.7%). FR 105,752 → 161,842
(+53%, from the macroregion official/anglicized split plus commune name variants). Post-fold
actuals are below.

**Open question (operator):** should the policy add `eng`-preferred names too? "Brittany" is a
plausible surface in an anglophone-written FR address. The measured cost is +30,129 name rows for
FR localities, mostly duplicates of the French forms after folding. This is deferred. v1 keeps the
policy minimal and named. Bump `namePolicy` when it changes.

### D4 — fold + tag semantics unchanged

Both sides use `normalizeFSTToken` (NFKC, lowercase, strip `\p{P}\p{S}`) with `foldVersion: 1`.
This is the single-sourced fold shared with the GB/NZ artifacts and the decode-side probe. The entry
`tag` is the child's ComponentTag (`locality`), as in the register builds. The builder dedupes
upstream with the length-prefixed pair key, and `serializePairIndex`'s duplicate assert remains the
backstop.

### D5 — probe-artifact safety (three independent locks)

1. `delta: 0` means an accidentally wired probe artifact adds no bias. The `--delta` flag
   normally has no default. The probe instead pins the one value that is inert.
2. The filename `pair-index-locality-region-<cc>.bin` does not match the loader's auto-wire pattern
   (`pair-index-<cc>.bin` as a weights-package sibling).
3. The files live in `$MAILWOMAN_DATA_ROOT/db/wof/pair-index-hierarchy-probe/`, which is the data
   root rather than a weights workspace. No artifact ships from there.

## Measured sizes (2026-07-26, admin-global-priority.db)

Built (post-fold, actual artifacts):

| Edge               | Country | id-edges | surface pairs | distinct folded pairs | bytes     |
| ------------------ | ------- | -------- | ------------- | --------------------- | --------- |
| (locality, region) | US      | 155,198  | 156,656       | **138,366**           | 3,270,483 |
| (locality, region) | FR      | 110,834  | 172,691       | **161,749**           | 4,449,304 |

Projections (distinct lower() pairs, spr-name-only policy — same DB, same filters):

| Edge                     | Country | pairs (projection) |
| ------------------------ | ------- | ------------------ |
| (locality, region)       | GB      | 16,366             |
| (locality, region)       | NZ      | 2,266              |
| (neighborhood, locality) | US      | 39,274             |
| (neighborhood, locality) | GB      | 12,888             |
| (neighborhood, locality) | FR      | 1,472              |

Reference points: the shipped register-built GB (dependent_locality, locality) artifact has 19,209
pairs (a few hundred KB), and the PIX1 reader was sized for "~20k entries". The (locality, region)
artifacts are about 8× that. At FR scale (161,749 entries), the `PairIndexResolver` constructor took
111.9 ms and the probe Map used about 21 MB of heap. That cost is acceptable for a build- or
training-side consumer and for a server-side decode prior. **It is too high for the browser demo as
is.** Before any decode ship of a US-scale artifact, one of two things must happen. Either lazy
construction stays behind the existing peek-header-first check, so only the matching country pays,
and that cost is measured and accepted. Or the reader gains a binary-search mode over the sorted
records. The format is already sorted by (child, parent), and a fixed-stride offset table in the
header extension would make this cheap. See the open questions below.

## The two consumers

### (a) Decode prior (future, conditional — NOT this task)

The boundary is the same as today: `PairIndexLike` structural injection into
`placetype-pair-prior.ts`, the loader's country check, positive evidence only, and the probe-mode
chain (segment → anchored). Only calibration and the emission target change per edge, and the entry
tag already encodes the target. The (locality, region) edge has a sharper confound profile than
dep-loc. Region names are a small closed set, so the pair hit fires on nearly every "city,
state"-shaped input. δ must therefore be small, and most of the value may come from the transition
term (β) and from namesake disambiguation. "Portland, Maine" and "Portland, Oregon" both hit, so the
pair prior contributes locality-boundary evidence rather than a parent choice. The calibration
protocol is the same as Task 7's: held-out register/OA rows plus confound boards, a δ sweep, and the
chosen value shipped in the header.

**Measurement plan for the decode probe (named held-out populations, pre-registered):**

1. **Target population:** comma-free US "street city state [zip]" rows, the US analogue of the GB
   comma-free dep-loc misses. The source is held-out national-situs/OA rows that are in no training
   extract. The existing `applyPairIndexHoldout` (10%, seed 42) also withholds pairs from the index
   itself, so in-index lift and coverage are measured separately. This keeps the Kimi-#1
   leaked-ceiling correction.
2. **Falsifier boards:**
   - (i) Namesake board (the London-ON class): child names valid under multiple parents, with the
     parent present in the input. The metric is that parent choice stays unchanged, because the
     prior must not pick parents.
   - (ii) Venue-confound board: locality names inside venue or street spans ("Springfield Mall
     Rd"). The false-positive bar to engage window mode is 0, as in the GB arc.
   - (iii) FR bare-locality board: single-segment communes with no parent present. The bar is
     byte-stable output, since an input without a parent cannot produce a probe hit.
3. **Byte-stability populations:** all non-target tier-1 presets must be byte-identical with the
   flag on (the D-rule). The anchored path only adds to a zero matrix, so this check is expected
   to pass by construction.
4. **Ledger:** flip attribution uses the existing `TRACE_PRIOR_KINDS` entry. Eval rows are named per
   population, and every verdict cites per-population rows rather than an aggregate alone.

### (b) Option-A locality evidence channel (Track 2 — the strategic consumer)

This consumer follows the street-type channel plumbing: `data.street_type_lexicon_path` →
`data_loader` painting → `model.use_street_type_anchor` injection, all default-False at c116f9d1.

- **Config:** `data.pair_index_paths: {country: [paths]}`, with N per-edge PIX1 files per country.
  D1's per-edge packaging makes the channel's feature slots self-describing: each edge type gets one
  slot, read from the file's `edge` header key.
- **Painting (loader, raw surface only, never gold labels):** for each row, the loader folds the
  input words once with `normalizeFSTToken` (the same fold, with `foldVersion` asserted at load).
  For every candidate word-window pair (a child window and a parent window elsewhere in the same
  input), it probes each edge's index. A hit paints the child window's pieces with that edge's
  feature bit (`known_locality_under_present_region: 1`). It can also paint the parent window's
  pieces with the reciprocal bit. The feature is per-span, presence-only, positive evidence, and
  absence paints no feature bit.
- **Bundle and check (required by the P-A verdict):** the locality channel enters only alongside
  the street-type channel, with a feature-dropout curriculum. The standing battery includes the
  evidence-ablation invariance check: zeroing the features must cause no regression on unaffected
  spans. The P-A probe showed that a channel trained alone drifts into over-trust (house-number
  classes −0.070/−0.045 by step 3k).
- **Train/inference symmetry:** at inference the same artifact feeds the same feature, because the
  loader and the runtime probe share the fold and the file. This lets the project retire decode
  flags. Once the channel is in the encoder, the pair prior (δ) becomes redundant and can be retired
  per the §8 payoff. The artifact stays.

## Probe build receipts (2026-07-26)

The builder is `mailwoman/gazetteer-pipeline/pair-index-hierarchy-probe.ts`. It is typed and
committed, reads the admin DB read-only, writes to a temp file and renames it, and reads the result
back to verify it. It runs through `runIfScript`, so importing it has no side effects. It lives in
the pipeline directory, as scripts/AGENTS.md directs, rather than in the gitignored
`scripts/diagnostic/`, so the extraction is reproducible from git.

The verifier is `mailwoman/gazetteer-pipeline/pair-index-hierarchy-verify.ts`. It is a separate
implementation on purpose: it derives pairs with a flat SQL CTE, while the builder uses JS-side
joins. Agreement between the two is the receipt. Full verifier output (exit 0):

```
$MAILWOMAN_DATA_ROOT/db/wof/pair-index-hierarchy-probe/pair-index-locality-region-us.bin (3,270,483 bytes)
  header: country=us delta=0 edge=locality→region namePolicy=spr-name+official-names-v1 buildDate=2026-07-26T21:50:18.636Z
  COUNT OK: artifact pairCount 138,366 == DB-derived 138,366
  SWEEP OK: all 138,366 expected pairs probe → locality
  PROBE OK: ("Springfield", "Illinois") → locality [expect present]
  PROBE OK: ("Portland", "Oregon") → locality [expect present]
  PROBE OK: ("Portland", "Maine") → locality [expect present]
  PROBE OK: ("Springfield", "Bretagne") → (no entry) [expect absent]
  PROBE OK: ("Springfield", "Ontario") → (no entry) [expect absent]

$MAILWOMAN_DATA_ROOT/db/wof/pair-index-hierarchy-probe/pair-index-locality-region-fr.bin (4,449,304 bytes)
  header: country=fr delta=0 edge=locality→region namePolicy=spr-name+official-names-v1 buildDate=2026-07-26T21:50:19.708Z
  COUNT OK: artifact pairCount 161,749 == DB-derived 161,749
  SWEEP OK: all 161,749 expected pairs probe → locality
  PROBE OK: ("Rennes", "Bretagne") → locality [expect present]
  PROBE OK: ("Rennes", "Ille-et-Vilaine") → locality [expect present]
  PROBE OK: ("Brest", "Finistère") → locality [expect present]
  PROBE OK: ("Marseille", "Bouches-du-Rhône") → locality [expect present]
  PROBE OK: ("Rennes", "Illinois") → (no entry) [expect absent]
  PROBE OK: ("Brest", "Normandie") → (no entry) [expect absent]

All checks passed for: us, fr
```

An earlier verifier run mixed numbered `?1` placeholders with anonymous `?` placeholders. It bound
its SQL parameters wrongly and "verified" against an empty expected set. The count check caught the
error. The script now uses numbered placeholders throughout and has a comment explaining why.

## Graduation path (when the operator green-lights either consumer)

1. The probe module moves into `mailwoman gazetteer pair-index` behind an
   `--edge wof:<child>,<parent>` mode, since that command already handles delta, transitionBeta,
   holdout and self-check. The `runIfScript` entry is then removed.
2. Per-country cross-check constants are pinned from this build's numbers, following the
   `EXPECTED_GB_PAIR_COUNT` convention: US 138,366, FR 161,749. A mismatch on rebuild means the fold
   or the source has diverged, and it must be investigated before the artifact is trusted.
3. The reader scale decision (below) is made before any browser-facing ship.

## Open questions for the operator

1. **Reader at 140k+ entries:** should the design accept the ~110 ms / ~21 MB Map build behind the
   country check (server-side only), or add a binary-search/offset-table read mode before any decode
   use? The Option-A training consumer is unaffected, since the Python side reads the file once per
   run.
2. **Name policy:** should it add `eng`-preferred surfaces (D3)? That would bump `namePolicy` to v2.
3. **Edge priority after (locality, region):** should (neighborhood, locality) for US/GB come next,
   as the survey suggests, or (locality, country) for the coarse-placer boundary? The neighborhood
   edge is the likelier second slot for the Option-A channel. Both its child and parent are
   open-vocabulary, which is the hard case the region edge doesn't exercise.
4. **FR localadmin:** WOF FR has 35,282 `localadmin` rows (communes proper) alongside 57,187
   `locality` rows. The probe used `locality` only. A v2 should measure whether localadmin ancestry
   adds real commune coverage or only duplicates folded surfaces.
5. **Track-2 handoff:** the §8 adjudication routes productionization of the channel to
   DeepSeek/Track-2. Should the `pair_index_paths` config sketch above go into that brief as is?

## Dispositions (2026-07-27, Claude — productionization owner per the ownership change)

1. **Reader mode: defer the binary-search/offset-table work.** The training consumer reads the file
   once per run. The decode consumer may never exist, because the bundle arc absorbed the
   locality-evidence role on the input side, and the productionization plan's Phase 4 retires decode
   priors rather than adding one. No component is built speculatively. If a decode use appears, the
   offset table needs only one absence-tolerant header key, and the design already reserves that
   slot.
2. **namePolicy v2 (eng-preferred): rejected for the pair artifacts.** It adds 30k mostly duplicate
   rows. English exonyms would also paint training evidence the feed never contains (BAN is French),
   which creates train/inference skew with no training benefit. Anglophone-written addresses are a
   resolver concern, already covered by the #936 official-names work. Revisit this only with a
   measured anglophone-written-FR eval population.
3. **Next edge: (neighborhood, locality).** The doc already leaned this way, and the bundle arc gave
   a stronger reason. The confirmed weakness is open-vocab×open-vocab discrimination, which this edge
   exercises and the region edge doesn't. (locality, country) stays unbuilt, because the #1104
   country channel and the coarse placer already own that boundary (no double coverage, per D3).
   The edge is sequenced into the productionization plan's Phase 1 builder consolidation, with one
   WOF-ancestry pass for both edges.
4. **FR localadmin: yes, measure it in the v2 build.** It is one flag and probe-safe. The
   expectation is that it adds real pairs, since communes are FR's canonical admin unit and BAN
   cites them. The build report states distinct pairs added versus folded duplicates. If the
   additions are duplicates, the build stays locality-only.
5. **The `pair_index_paths` sketch: adopted into the (now Claude-owned) productionization plan,
   with one amendment.** Pair-derived evidence enters as a bundle channel under the same three-law
   selectivity and absence-curriculum regime that the bundle arc proved necessary, since the sketch
   predates those findings. It follows the binary bundle ship, so only one artifact changes at a
   time, per the plan's open-items ordering.
