# #727 phase 4c — `StreetLocalityEvidence`: street-name existence as the k-best arbiter signal

Status: SPEC (measured design, not yet implemented). Author: night-4 autonomous shift, 2026-07-17.
Prereqs: PR #1154 (the span-decode surface on main). Companion receipts:
`docs/articles/evals/2026-07-17-phase4-name-evidence-rerank.md` (the measurement) and PR #1152
(P1's design doc, which specified this evidence source independently the same day).

## The one-paragraph case

The span head's k-best list contains the right street parse far more often than rank 1 shows it
(oracle@5 0.723 vs seg@1 0.577 on parity). Phase 4a measured the planned arbiter signal —
full-geocode resolution tier — at exactly **zero** collected headroom: the failing class is
context-free fragments, which never reach rooftop layers, so every hypothesis ties at admin tier
(evidence rate 3.4%). The corrected signal is **street-NAME existence**: "does this hypothesis's
street surface exist as a street name in the national register?" — queryable for fragments, and
measured on the FR fragment board (n=1600) at **street@1 0.619 → 0.711 (+9.3pp), bare-street
0.675 → 0.875 (+20.0pp), 148 fixes / 3 breaks** with zero training.

## Measured policy (falsifier v2 — the numbers above)

Rerank rule, applied only when rank-1's street is not the evidence pick:

> Pick the first hypothesis in parse-score order whose street surface passes ALL of:
>
> 1. **Exists** in the street-name index (fold: NFD strip-diacritics, lowercase, whitespace-collapse).
> 2. **G1 — not pure type vocabulary**: the surface contains at least one token that is not a
>    street-type/particle word (`rue`, `chemin`, `route`, `de`, `du`, …). Without this, truncated
>    spans win — bare `rue` is "a street name that exists" 10 of the original 14 breaks.
> 3. **G2 — margin cap**: `score(rank1) − score(candidate) ≤ 2.5`. Without this, evidence reaches
>    4+ score units down the list and moves off correct rank-1 parses whose gold street misses the
>    index (hyphen/apostrophe folds — the other 4 original breaks).
>
> If no hypothesis passes, keep rank 1 (fail-open, positive evidence only).

This stays inside the anti-Pelias rule from `resolver/rerank.ts`: one bit of evidence, no score
blending, model order preserved among candidates with equal evidence. G1 is a lexicon fact
(libpostal street-type dictionaries), not a tuned weight; G2's 2.5 is the one scalar — it must be
re-fit (or replaced by the isotonic ambiguity gate the plan pre-registered) when the span head
retrains, since raw score margins are not calibrated across models.

Residual per-class notes from the board: street-housenumber dips 0.922 → 0.912 under G2 (the cap
blocks a few legitimate deep picks); date-name stays hard (0.100 → 0.180 — most failures are not
in the top 5 at all, that class is a model problem, not an arbiter problem).

## Interface

```ts
/** One street-name existence probe. Backend-agnostic; FR = BAN street-centroids, US = TIGER, … */
export interface StreetLocalityEvidence {
	/**
	 * True when `streetSurface` (folded) exists as a street name — optionally scoped to a locality
	 * or postcode when the hypothesis carries one (fragments usually don't; unscoped is the
	 * measured mode). POSITIVE EVIDENCE ONLY: implementations must return false on any doubt
	 * (missing index, unsupported country) so the rerank fails open to the model's ranking.
	 */
	hasStreetName(streetSurface: string, scope?: { locality?: string; postcode?: string }): boolean
	/** ISO-2 countries this instance can answer for. Anything else → no evidence, never a veto. */
	readonly countries: ReadonlySet<string>
}
```

Home: `resolver/street-evidence.ts` (sibling of `rerank.ts`; the resolver package owns atlas
arbitration). The k-best consumer composes it with `rerankByResolution`'s scaffold — evidence
providers are injected, never imported concretely, matching the `PlaceLookup` pattern.

Index backends, in build order:

1. **FR** — exists: `street-centroids-fr.db` (2.2M `street_norm` rows, BAN). The measured board.
2. **US** — TIGER edges already ship for interpolation; a `street_norm` projection is a small
   gazetteer-pipeline addition (`mailwoman gazetteer build`, sealed artifact, provenance-tracked).
3. **PT/RO/NO/…** — per the registry-backed-structured-prediction doctrine tiers; each new index
   is data work only, no code change.

Fold parity is a CONTRACT: the index builder and the runtime prober must share the fold function
(export it beside the interface). The 4 original G2 breaks were fold mismatches (`pillet-will`
stored unhyphenated); the builder should normalize hyphens/apostrophes to spaces on BOTH sides —
re-measure the 3 residual breaks after that change, it likely cuts them further.

## What phase 4c does NOT do

- No changes to the model, the decoder, or parse scores (one probability space, untouched).
- No global vetoes: absence of a name is NEVER evidence against a parse (index incompleteness is
  the default state of the world). Only presence promotes.
- No per-class weights, no score blending — the moment a second scalar appears beside G2's margin,
  stop and re-read the rerank.ts header.
- No production wiring until a span-head model ships: spanScores exist only on the phase-1
  artifact (v301). The rerank rides the span-arc retrain (plan #1134 step 4/5) behind a flag, with
  the golden gate + gauntlet battery as the promotion bar.

## Measured-read pre-registration for the implementation PR

On the FR fragment board (same fixtures, same v301 artifact, k=5): street@1 ≥ 0.70 overall,
bare-street ≥ 0.86, breaks ≤ 5 of recoverable, zero regression on street-housenumber beyond
−1.5pp vs seg@1. On parity fixtures: no coordinate-acceptability regression (P1/P2/P3 gate).

## Logged training signal (free byproduct)

Every fired rerank (148 on the board) is a labeled rank-2-beats-rank-1 example. Persist
`{input, rank1, picked, evidence}` behind the flag — that corpus is the future distillation set
for teaching the model what the atlas keeps correcting (the model-first end state).
