# Pair-index across the WOF hierarchy — design + probe build

**Date:** 2026-07-26 · **Status:** design + built probe artifact (survey candidate #3,
`2026-07-26-static-index-opportunities.md`) · **Branch:** `feat/night-pair-hierarchy` ·
**Scope:** design + probe, NOT a ship — no decode wiring, no default changes, no weights-package
changes.

**Dual mandate (why this artifact, per ROAD_TO §8):** the same (child, parent) pair set serves

- **(a)** a future decode-time soft prior — the PIX1 GB/NZ `dependent_locality` mechanism
  (`neural/placetype-pair-prior.ts`) extended to more hierarchy edges, and
- **(b)** the Option-A **locality evidence channel** (Track 2): a training-time per-span input
  feature — "this span is a known locality under a plausible parent present in the same input" —
  inside the evidence BUNDLE (street-type channel + locality channel; no single channel decisive;
  evidence-ablation invariance gate). One build outlives the mechanism that first consumes it — the
  anti-flag-pile property the survey named.

## What exists today (the base being generalized)

PIX1 (`neural/pair-index-resolver.ts`) is a flat binary: magic, JSON header, then sorted
`(child, parent, tagIdx)` records; `u16`-length-prefixed UTF-8 names; Map-backed `probe()`. The
header carries per-country calibration (`delta`, optional `transitionBeta`), provenance
(`sourceMD5s`, `buildDate`), and `foldVersion`/`schemaVersion`. Two artifacts exist, both
register-built (PPD / LINZ), both `(dependent_locality, locality)` in tag space, GB + NZ. The
builder command is `mailwoman gazetteer pair-index` over a tuples CSV
(`mailwoman/gazetteer-pipeline/pair-index.ts` owns fold/dedupe/holdout).

The WOF admin DB (`dataRootPath("wof", "admin-global-priority.db")`, read-only) carries the
`ancestors` table — `(id, ancestor_id, ancestor_placetype)` for every place — plus `spr` (name,
placetype, country, currency flags) and `names` (per-language variants with an `official` bit).
That table is precisely the per-country pair source for every hierarchy edge the registers don't
cover.

## Design decisions

### D1 — one artifact per (country, edge-type), not one multi-edge artifact

`pair-index-<childTag>-<parentTag>-<cc>.bin` (probe: `pair-index-locality-region-us.bin`). Rationale:

1. **Calibration is per-edge.** `delta` (and `transitionBeta`) live in the header as scalars — the
   whole point of the artifact-header calibration discipline. A multi-edge file needs a per-edge δ
   map, which breaks the `PairIndexLike` contract (`readonly delta?: number`) and every consumer of
   it. Different edges will calibrate differently: a (locality, region) hit is weaker evidence than
   a register-built (dependent_locality, locality) hit — region names are a tiny closed set that
   co-occurs with almost any locality.
2. **Independent shipping cadence.** (locality, region) can calibrate and ship while
   (neighbourhood, locality) is still on the bench. A multi-edge artifact couples their release.
3. **Edge identity is NOT recoverable from the entry tag.** Entries carry only the child's
   `ComponentTag` — (locality, region) and a future (locality, country) both emit `locality`.
   Per-edge files make the edge unambiguous without a format change; a multi-edge file would need a
   per-entry edge field (a real PIX2).
4. **The loader story stays trivial** for both consumers: decode auto-wire stays
   one-file-per-pattern; the training channel builder consumes N small files per country and knows
   each file's edge from its header.

Cost: a handful of files per country instead of one. At 3–4.5 MB per (locality, region) file the
aggregate is dominated by the biggest edge either way.

### D2 — serialization: PIX1 reused verbatim, extension rides the header JSON

Zero changes to `neural/pair-index-resolver.ts`. The extension keys follow the `transitionBeta`
precedent exactly — absence-tolerant readers parse the header JSON and never consult unknown keys,
so **`schemaVersion` stays 1**:

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

- `edge` is **tag space** (what a hit resolves to / what the channel feature means);
  `source.*WOFPlacetypes` is **WOF space** (what was extracted). The two are deliberately separate:
  FR's `region` ComponentTag covers BOTH WOF `region` (départements — "Ille-et-Vilaine") and WOF
  `macroregion` (régions — "Bretagne"); either surface is a region-tagged parent in a French
  address. The per-country WOF mapping is builder-owned and header-recorded.
- `source.kind` matters because the SAME tag-space edge can exist from two sources: the shipped GB
  artifact is (dependent_locality, locality) **register-built**; a WOF `neighbourhood`-ancestry
  build of the same edge would be a geographic sibling with different evidential weight. Per-country
  calibration decides which ships; the header says which one you're holding.
- Country scoping is unchanged from PIX1: `country` in the header, hard gate at the consumer
  (`loadFromWeights` peeks the header and skips construction on mismatch; no-country-context → no
  bias, per the census-bias design's decision 5).
- **Per-edge delta = per-file delta** (D1) — no schema change needed for it, ever.

### D3 — name policy: `spr.name ∪ official names` (`spr-name+official-names-v1`)

Surfaces per place = the `spr.name` default plus every `names` row with `official = 1`, for child
and parent alike. Why both:

- `spr.name` alone breaks FR: WOF's default names for FR macroregions are anglicized ("Brittany",
  "Upper France", "Great East") — no French address contains them. The official names ("Bretagne",
  "Hauts-de-France", "Grand Est") are the in-country surfaces, and official-language names are the
  established name-exact evidence class (#936).
- Official names alone under-cover: ~5k of 160k US localities have no `official=1` row; `spr.name`
  fills them.

Measured effect (lower() SQL projection): US 137,511 → 138,439 (+0.7%); FR 105,752 → 161,842
(+53% — the macroregion official/anglicized split plus commune name variants). Post-fold actuals
below.

**Open question (operator):** add `eng`-preferred names too? "Brittany" IS a plausible surface in an
anglophone-written FR address. Measured cost: +30,129 name rows for FR localities (mostly duplicates
of the French forms post-fold). Deferred — v1 keeps the policy minimal and named; bump
`namePolicy` when it changes.

### D4 — fold + tag semantics unchanged

`normalizeFSTToken` (NFKC, lowercase, strip `\p{P}\p{S}`) on both sides, `foldVersion: 1` — the
single-sourced fold shared with the GB/NZ artifacts and the decode-side probe. Entry `tag` = the
CHILD's ComponentTag (`locality`), mirroring the register builds. Dedupe upstream with the
length-prefixed pair key; `serializePairIndex`'s duplicate assert stays the backstop.

### D5 — probe-artifact safety (three independent locks)

1. `delta: 0` — an accidentally-wired probe artifact biases nothing (the `--delta`-required-no-default
   discipline, inverted: the probe pins the one value that is inert).
2. Filename `pair-index-locality-region-<cc>.bin` does not match the loader's auto-wire pattern
   (`pair-index-<cc>.bin` as a weights-package sibling).
3. Location `$MAILWOMAN_DATA_ROOT/wof/pair-index-hierarchy-probe/` — the data root, not a weights
   workspace; nothing ships from there.

## Measured sizes (2026-07-26, admin-global-priority.db)

Built (post-fold, actual artifacts):

| Edge               | Country | id-edges | surface pairs | distinct folded pairs | bytes     |
| ------------------ | ------- | -------- | ------------- | --------------------- | --------- |
| (locality, region) | US      | 155,198  | 156,656       | **138,366**           | 3,270,483 |
| (locality, region) | FR      | 110,834  | 172,691       | **161,749**           | 4,449,304 |

Projections (distinct lower() pairs, spr-name-only policy — same DB, same filters):

| Edge                      | Country | pairs (projection) |
| ------------------------- | ------- | ------------------ |
| (locality, region)        | GB      | 16,366             |
| (locality, region)        | NZ      | 2,266              |
| (neighbourhood, locality) | US      | 39,274             |
| (neighbourhood, locality) | GB      | 12,888             |
| (neighbourhood, locality) | FR      | 1,472              |

Reference points: the shipped register-built GB (dependent_locality, locality) artifact is 19,209
pairs (~few hundred KB); the PIX1 reader was sized for "~20k entries". The (locality, region)
artifacts are ~8× that. Measured at FR scale (161,749 entries): `PairIndexResolver` constructor
111.9 ms, ~21 MB heap for the probe Map. Fine for a build/training-side consumer and for a server-side
decode prior; **NOT fine as-is for the browser demo** — before any decode ship of a US-scale
artifact, either lazy construction stays behind the existing peek-header-first gate (only the
matching country pays) and that is measured acceptable, or the reader grows a binary-search mode
over the sorted records (the format is already sorted by (child, parent); a fixed-stride offset
table in the header extension would make this cheap). Open question below.

## The two consumers

### (a) Decode prior (future, gated — NOT this task)

Same seam as today: `PairIndexLike` structural injection into `placetype-pair-prior.ts`; the
loader's country hard gate; positive-evidence-only; probe-mode chain (segment → anchored). What
changes per edge is only calibration and the emission target (the entry tag already encodes it).
The (locality, region) edge has a sharper confound profile than dep-loc: region names are a small
closed set, so the pair hit fires on nearly every "city, state"-shaped input — δ must be small and
the value may live mostly in the transition term (β) and in namesake disambiguation ("Portland,
Maine" vs "Portland, Oregon" both hit; the pair prior contributes locality-boundary evidence, not
parent choice). Calibration protocol identical to Task 7's: held-out register/OA rows + confound
boards, δ swept, value shipped in the header.

**Measurement plan for the decode probe (named held-out populations, pre-registered):**

1. **Target population:** comma-free US "street city state [zip]" rows — the US analogue of the GB
   comma-free dep-loc misses. Source: held-out national-situs/OA rows NOT in any training shard;
   the existing `applyPairIndexHoldout` (10%, seed 42) additionally withholds pairs from the index
   itself so in-index lift and coverage are measured separately (the Kimi-#1 leaked-ceiling
   correction, kept).
2. **Falsifier boards:** (i) namesake board — the London-ON class: child names valid under multiple
   parents, parent present in input; metric = parent-choice unchanged (the prior must not pick
   parents); (ii) venue-confound board — locality names inside venue/street spans ("Springfield
   Mall Rd"); FP bar 0 to engage window mode, same as the GB arc; (iii) FR bare-locality board —
   single-segment communes with no parent present; bar = byte-stable (no-parent → no probe hit by
   construction).
3. **Byte-stability populations:** all non-target tier-1 presets flag-ON must be byte-identical
   (the D-rule); the anchored path is additive-only against a zero matrix, so this is a check, not
   a hope.
4. **Ledger:** flip-attribution via the existing `TRACE_PRIOR_KINDS` entry; eval rows named per
   population, no aggregate-only verdicts.

### (b) Option-A locality evidence channel (Track 2 — the strategic consumer)

Mirrors the street-type channel plumbing (`data.street_type_lexicon_path` →
`data_loader` painting → `model.use_street_type_anchor` injection, all default-False at c116f9d1):

- **Config:** `data.pair_index_paths: {country: [paths]}` (N per-edge PIX1 files per country —
  D1's per-edge packaging is what makes the channel's feature slots self-describing: one slot per
  edge type, read from each file's `edge` header key).
- **Painting (loader, raw surface only — never gold labels):** for each row, fold the input words
  once (`normalizeFSTToken`, the same fold — `foldVersion` asserted at load); for every candidate
  word-window pair (child window, parent window elsewhere in the same input), probe each edge's
  index. A hit paints the CHILD window's pieces with that edge's feature bit
  (`known_locality_under_present_region: 1`), and optionally the parent window's pieces with the
  reciprocal bit. Per-span, presence-only, positive evidence — absence paints nothing.
- **Bundle + gate (the P-A verdict, non-negotiable):** the locality channel enters ONLY alongside
  the street-type channel, with feature-dropout curriculum, and the evidence-ablation invariance
  gate (features-zeroed vs present ⇒ no regression on unaffected spans) in the standing battery.
  The P-A probe already demonstrated a naked channel drifts into over-trust (house-number classes
  −0.070/−0.045 by 3k).
- **Train/inference symmetry:** at inference the SAME artifact feeds the same feature — the loader
  and the runtime probe share the fold and the file. This is the retirement path for the decode
  flag-pile: once the channel is in the encoder, the pair PRIOR (δ) becomes redundant and can be
  retired per the §8 payoff; the ARTIFACT stays.

## Probe build receipts (2026-07-26)

Builder: `mailwoman/gazetteer-pipeline/pair-index-hierarchy-probe.ts` (typed, committed; reads the
admin DB read-only, temp-write + rename, self-verifying readback; `runIfScript`-runnable, so import
stays side-effect-free — the pipeline home per scripts/AGENTS.md's closed drawer, chosen over the
gitignored `scripts/diagnostic/` precedent so the extraction is reproducible from git). Verifier:
`mailwoman/gazetteer-pipeline/pair-index-hierarchy-verify.ts` — a deliberately SEPARATE
implementation (flat SQL CTE derivation vs the builder's JS-side joins) whose convergence is the
receipt. Full verifier output (exit 0):

```
/mnt/playpen/mailwoman-data/wof/pair-index-hierarchy-probe/pair-index-locality-region-us.bin (3,270,483 bytes)
  header: country=us delta=0 edge=locality→region namePolicy=spr-name+official-names-v1 buildDate=2026-07-26T21:50:18.636Z
  COUNT OK: artifact pairCount 138,366 == DB-derived 138,366
  SWEEP OK: all 138,366 expected pairs probe → locality
  PROBE OK: ("Springfield", "Illinois") → locality [expect present]
  PROBE OK: ("Portland", "Oregon") → locality [expect present]
  PROBE OK: ("Portland", "Maine") → locality [expect present]
  PROBE OK: ("Springfield", "Bretagne") → (no entry) [expect absent]
  PROBE OK: ("Springfield", "Ontario") → (no entry) [expect absent]

/mnt/playpen/mailwoman-data/wof/pair-index-hierarchy-probe/pair-index-locality-region-fr.bin (4,449,304 bytes)
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

(An earlier verifier run mis-bound its SQL parameters — mixed `?1` with anonymous `?` — and
"verified" against an empty expected set; the script now uses explicitly numbered placeholders
throughout and carries a comment so the trap isn't re-walked. The count check is what caught it.)

## Graduation path (when the operator green-lights either consumer)

1. The probe module folds into `mailwoman gazetteer pair-index` behind an `--edge wof:<child>,<parent>`
   mode (the command already owns delta/transitionBeta/holdout/self-check plumbing); the
   `runIfScript` entry retires.
2. Per-country cross-check constants get anchored (the `EXPECTED_GB_PAIR_COUNT` discipline) from
   this build's numbers: US 138,366, FR 161,749 — a mismatch on rebuild means fold or source
   divergence, investigate before trusting.
3. Reader scale decision (below) lands before any browser-facing ship.

## Open questions for the operator

1. **Reader at 140k+ entries:** accept the ~110 ms / ~21 MB Map build behind the country gate
   (server-side only), or invest in a binary-search/offset-table read mode before any decode use?
   The Option-A training consumer doesn't care (Python side reads the file once per run).
2. **Name policy:** add `eng`-preferred surfaces (D3)? Bumps `namePolicy` to v2.
3. **Edge priority after (locality, region):** (neighbourhood, locality) US/GB next per the survey,
   or (locality, country) for the coarse-placer seam? The neighbourhood edge is the Option-A
   channel's likelier second slot (open-vocab child, open-vocab parent — the hard case the region
   edge doesn't exercise).
4. **FR localadmin:** WOF FR has 35,282 `localadmin` rows (communes proper) alongside 57,187
   `locality`. The probe used `locality` only; a v2 should measure whether localadmin ancestry adds
   real commune coverage or only duplicates folded surfaces.
5. **Track-2 handoff:** productionization of the channel is routed to DeepSeek/Track-2 per the §8
   adjudication — does the `pair_index_paths` config sketch above go into that brief as-is?
