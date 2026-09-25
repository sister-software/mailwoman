# #727 phase 4c — `StreetLocalityEvidence`: street-name existence as the k-best arbiter signal

Status: spec. The design is measured but not yet implemented. Author: night-4 autonomous shift, 2026-07-17.
Prerequisite: PR #1154 (the span-decode surface on main). Companion receipts:
`docs/articles/evals/2026-07-17-phase4-name-evidence-rerank.md` (the measurement) and PR #1152
(P1's design doc, which independently specified this evidence source on the same day).

## The one-paragraph case

The span head's k-best list contains the right street parse much more frequently than rank 1 does
(oracle@5 0.723 vs seg@1 0.577 on parity). Phase 4a measured the planned arbiter signal, the
full-geocode resolution tier, and found it collected **zero** headroom. The failing inputs are
context-free fragments. These never reach rooftop layers, so every hypothesis ties at admin tier
(evidence rate 3.4%). The replacement signal is **street-name existence**: whether the hypothesis's
street surface exists as a street name in the national register. Fragments can be queried this way.
On the FR fragment board (n=1600), without any training, it moved **street@1 0.619 → 0.711 (+9.3pp) and bare-street
0.675 → 0.875 (+20.0pp), with 148 fixes and 3 breaks**.

## Measured policy (falsifier v2 — the numbers above)

Rerank rule, applied only when rank-1's street is not the evidence pick:

> Pick the first hypothesis in parse-score order whose street surface passes all of:
>
> 1. **Exists** in the street-name index (fold: NFD strip-diacritics, lowercase, whitespace-collapse).
> 2. **G1, type vocabulary**: the surface contains at least one token that is not a
>    street-type or particle word (`rue`, `chemin`, `route`, `de`, `du`, …). Without G1, truncated
>    spans win. Bare `rue` counts as an existing street name, and it caused 10 of the original 14 breaks.
> 3. **G2, margin cap**: `score(rank1) − score(candidate) ≤ 2.5`. Without G2, the evidence reaches
>    4+ score units down the list and replaces correct rank-1 parses whose gold street is missing from the
>    index. Hyphen and apostrophe folding caused the other 4 original breaks.
>
> If no hypothesis passes, keep rank 1. The rule fails open and uses positive evidence only.

This policy follows the anti-Pelias rule from `resolver/rerank.ts`. It uses one bit of evidence, does not blend
scores, and preserves model order among candidates with equal evidence. G1 comes from a lexicon
(the libpostal street-type dictionaries) and has no tuned weight. G2's 2.5 is the only scalar. Re-fit it,
or replace it with the isotonic ambiguity check the plan pre-registered, whenever the span head
retrains, because raw score margins are not calibrated across models.

Two per-class results from the board remain. Street-housenumber dips 0.922 → 0.912 under G2 because the cap
blocks a few legitimate deep picks. Date-name stays hard (0.100 → 0.180). Most of its failures are absent
from the top 5, so the fix for that class belongs in the model rather than the arbiter.

> **Substrate correction (2026-07-17, v3.10.1 8k):** the numbers above were measured on the v301
> phase-1 head. On the 8k ship-recipe substrate, which is the model phase 4c decodes,
> the rerank collects **+6.0pp overall (0.791 → 0.851), with 96 fixes and 3 breaks (32:1)**. The per-class
> improvements differ from the v301 measurement. The ship-recipe model already scores 0.905 on bare-street, where the rerank adds +4.5pp.
> **Date-name is now the main beneficiary (+16.7pp)**. Phase 4c therefore targets date-name and the long tail
> more than bare-street. See `docs/articles/evals/2026-07-17-v3101-span-head-8k-result.md`.

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

The interface lives in `resolver/street-evidence.ts`, beside `rerank.ts`, because the resolver package owns atlas
arbitration. The k-best consumer composes it with the `rerankByResolution` scaffold. Evidence
providers are injected rather than imported concretely, as in the `PlaceLookup` pattern.

Index backends, in build order:

1. **FR** already exists: `street-centroids-fr.db` (2.2M `street_norm` rows from BAN). The board above measured this index.
2. **US**: TIGER edges already ship for interpolation. A `street_norm` projection is a small
   gazetteer-pipeline addition (`mailwoman gazetteer build`, sealed artifact, provenance-tracked).
3. **PT/RO/NO/…** follow the tiers of the registry-backed structured-prediction doctrine. Each new index
   requires data work only and no code change.

The index builder and the runtime prober must share the fold function, so export it beside the interface.
The 4 original G2 breaks were fold mismatches, such as `pillet-will`
stored without its hyphen. The builder should normalize hyphens and apostrophes to spaces on both sides.
Re-measure the 3 residual breaks after that change, which will likely reduce them further.

## What phase 4c does not do

- Phase 4c does not change the model, the decoder, or parse scores. There is one probability space, and it stays untouched.
- It adds no global vetoes. A missing name is never evidence against a parse, because the index is
  expected to be incomplete. Only a name's presence promotes a hypothesis.
- It adds no per-class weights and does not blend scores. If a second scalar appears beside G2's margin,
  stop and re-read the rerank.ts header.
- It adds no production wiring until a span-head model ships. The rerank runs on the v3.10.1 8k model (step-4, 2026-07-17),
  which exports spanScores and the semi-crf-transitions sidecar and is staged at
  `scratchpad/v3101-cache`. The rerank runs on that model behind a flag. To promote it, the golden check and
  gauntlet battery must pass with the rerank active.

## Measured-read pre-registration for the implementation PR

On the FR fragment board (same fixtures, the **v3.10.1 8k substrate**, k=5, and not the v301 proxy),
the implementation must reach street@1 ≥ 0.85 overall and date-name ≥ 0.55 (the class that gains most), with breaks ≤ 5 of recoverable
and a street-housenumber regression of at most −1.0pp vs seg@1. On parity fixtures, it must show
no coordinate-acceptability regression (P1/P2/P3 check). The baseline is seg@1 0.791. The wired implementation must reproduce the v2 policy
board result of 0.851 (96 fixes / 3 breaks).

## Logged training signal (free byproduct)

Every fired rerank (148 on the board) is a labeled example of rank 2 beating rank 1. Persist
`{input, rank1, picked, evidence}` behind the flag. That corpus becomes the future distillation set
that teaches the model the corrections the atlas keeps making, which moves toward the model-first end state.
