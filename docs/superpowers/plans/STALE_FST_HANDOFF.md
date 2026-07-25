# STALE FST HANDOFF — rebuild + reship the 768k importance gazetteer FST (#1142)

**Date:** 2026-07-25 · **For:** Kimi (executing lead) · **From:** the outgoing lead (Claude).
**Repo:** mailwoman @ `main`. **Companion doc:** `docs/superpowers/plans/2026-07-25-LEAD-HANDOFF.md`
(the broader v8 + comma-free context — read its §0 discipline first).

## Why this exists (and the ONE thing you must not get wrong)

The shipped FST gazetteer (`fst-en-US.bin`, **220,469 rows**) is stale relative to a rebuilt
importance FST (**768,643 rows**). The rebuild was **deliberately HELD** (#1142), not forgotten —
and the reason it was held is the trap in this task:

> **On anchor-rich golden eval, importance DATA is redundant once suppression length-scaling exists
> (#1173, already shipped). The rebuilt FST's value regime is the bare-fragment / autocomplete path,
> which golden STRUCTURALLY CANNOT SEE. Therefore golden can only VETO this reship, never green-light
> it. The 768k FST ships ONLY if a FRAGMENT-BOARD run with the rebuilt FST beats the shipped FST on
> bare-locality + admin/street-homonym, WHILE golden stays flat.**

If you rebuild the FST and reship it because "bigger/fresher is better" or because golden is flat,
you will have shipped an unjustified artifact. The fragment board — not golden, not intuition — is
the gate. This is the whole discipline of the task.

The full design record is `scratchpad/fable-1142-importance-street-context-gate.md` (read it in
full — it is the source of truth for this handoff; everything below is distilled from it).

## How this connects to the comma-free fix (why it's being done now)

The comma-free trailing-locality fix (LEAD-HANDOFF §1) has a **fork A** = activate the dormant FST
gazetteer emission prior (`buildFSTEmissionPriors` at `neural/classifier.ts:646`, gated on an
`opts.fst` that production doesn't pass). Fork A was flagged risky precisely because it would
inherit THIS stale, importance-incomplete FST. Doing this task properly de-risks fork A: a rebuilt,
gated, fragment-validated FST is one the comma-free prior can trust. So: **finish the FST first,
then fork A of the comma-free fix becomes a clean follow-on.** (Fork B — a targeted
trailing-locality bias — remains the alternative that sidesteps the FST channel entirely; this task
is what makes fork A competitive with B.)

## Current state (what already shipped — do not redo)

- **#1172** (`c1139ba3`) — FST builder dedup fix. Merged.
- **#1173** (`d5fbf237`) — the CONSUMER fix in `neural/fst-prior.ts`, on the SHIPPED model+FST: US
  golden **+35**, fragment battery **+58 net** (admin-street-homonym +50, bare-locality −2),
  gauntlet PASS. Mechanism: the flat −1.5 `SUPPRESS_WHEN_PLACE` clamp on B/I-street, B/I-house_number,
  B-venue was killing the street reading for weak lone-token matches; #1173 scales ONLY the
  suppression term by match length (1-tok ×0.25, 2-tok ×0.7, 3+ ×1.0) via `importanceLengthScaleMode`
  (`off|suppression|both`, default `suppression`). Ablation: `both` (also scaling the positive bias)
  is strictly worse (US +26 / FR −9) — positive locality bias earns its keep in the bare-fragment
  regime and stays full strength.
- **Residual:** an FR **−3** on the fragment board, and the unresolved reship of the 768k FST.

## The work (in order)

### Step 1 — implement the street-context gate (targets the FR −3; the enabler for the reship)

Positive-evidence-only scaling of the POSITIVE admin/locality bias — all inside
`buildFSTEmissionPriors`/`applyBias` in `neural/fst-prior.ts`, NO decoder / `addEmissionMatrix`
change. Scale down positive locality/region bias when EITHER gate fires:

1. **Street-type adjacency** — the word-group immediately after (suffix locales: "Washington Blvd")
   or before (prefix locales: "Rue de Rivoli" — this is what recovers the FR −3) the matched span is
   a street-type token. **Signal source = the street-morphology FST** (`fst-street-morphology.bin`,
   already shipped, locale-general, already at the call site). **NOT** codex `us/street-suffix.ts`
   (US-only — using it re-introduces an FR regression).
2. **House-number left** — the word-group before the match (or before a street-type prefix) matches
   `/^\d{1,6}[a-z]?$/` ("500 Washington" is street-headed — "the house number is the license", #1143).

When a gate fires, scale positive `impBias` (`neural/fst-prior.ts:360`) by **×~0.25** (tune 0.15–0.4).
**Do NOT zero it** — "New York Ave" still needs some admin mass for the semi-markov decoder.

**HARD INVARIANT — syntactic context only, NEVER importance magnitude.** `importance²` sharpening was
measured and REJECTED: Washington/Madison/Jackson are simultaneously the highest-importance US names
AND the commonest US street names, so any magnitude discount re-imports the regression. Gate on
syntax (street-adjacency, house-number-left), never on the importance value.

Default-safe asymmetry (verify these by hand after implementing): "Washington" alone → full boost;
"Washington DC" → adjacent region, gate silent → full boost; "Washington Blvd" / "500 Washington" →
gate fires → street wins. No street context ⇒ **byte-identical** to today.

Wiring (from the design doc — verify the line numbers against current `main`, they drift):

- New `FSTPriorOpts.streetContext?: { fst: FSTMatcherLike; positiveScale?: number }`. Absent →
  current behavior (default-safe no-op).
- After `groupPiecesIntoWords()`, precompute per-parse `streetTypeFlags[]` (walk each word-group vs
  the morphology FST, O(words)) + `houseNumberFlags[]` (the regex). Pass the matched span's
  start/end group index into `applyBias` → check `flags[start−1] || flags[end+1]`.
- `applyBias`: scale `impBias` only; the suppression path keeps its #1173 length-scaling (they
  compose — length = weak lone match; context = strong match in a street position).
- In `neural/classifier.ts`, pass the EXISTING `opts.fstStreetMorphology` matcher (already used at
  the morphology call site) into `buildFSTEmissionPriors`. Inert when the morphology FST isn't loaded.

### Step 2 — rebuild the 768k importance FST

- Importance table: `node mailwoman/out/cli.js gazetteer importance --db <wof.db>` — downloads
  Nominatim `wikimedia-importance.csv.gz`, joins via `concordances`, writes `place_importance`, then
  layers a population-derived fallback (requires `place_population`; run `gazetteer build admin`
  first if the DB lacks `concordances`/`place_population`). Header:
  `mailwoman/commands/gazetteer/importance.tsx`.
- FST serialization reads `importance` (Wikipedia importance [0,1]) and writes it as an f32 at byte
  offset 12 per entry — `resolver-wof-sqlite/fst-serialize.ts:183` (format doc at the file top).
  **Confirm the exact emit CLI on `main`** — `serializeFST`'s non-test callers are
  `mailwoman/commands/autocomplete.tsx`, `resolver-wof-sqlite/street-morphology-fst-builder.ts` (that
  one emits the _morphology_ FST, not the gazetteer FST), and several `scripts/eval|diagnostic/*`; the
  `fst-en-US.bin` gazetteer emit is NOT a `gazetteer build` subcommand, so trace it via
  `grep -rl 'fst-en-US.bin'` + the `autocomplete` build path. Do NOT hand-roll a serializer — reuse
  `serializeFST` (`resolver-wof-sqlite/fst-serialize.ts:58`).
- **Build discipline (repo rule):** DBs/artifacts are read-only once built — build to a temp path,
  verify, then move into place. Never mutate a shipped FST/DB.

### Step 3 — measure on the FRAGMENT board (the gate), golden as veto only

Baselines = POST-#1173 `main` (don't give back the +35/+58). Run WITH the rebuilt FST:

| Board                        | Command                                                          | Pass condition                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| US golden exact              | `eval parity data/eval/golden`                                   | ≥ post-#1173 (flat-or-better) — **veto only**                                                                                              |
| FR golden                    | same                                                             | recover the residual −3; hard floor −0 net                                                                                                 |
| Fragment (BAN ~400/class)    | `eval fragment-board`                                            | bare-street ±2pp; **admin-street-homonym ≥ baseline (+50 holds)**; **bare-locality ≥ baseline −2pp** (the importance-win negative control) |
| Paris homonyms / FR fixtures | the #1142 A/B hazard set                                         | 0 regressions                                                                                                                              |
| Promotion                    | `eval gate` + `eval gauntlet` (incl. the 17 FR venue-trap cases) | PASS                                                                                                                                       |

**Reship condition, restated:** ship the 768k FST **only if** the fragment-board run with the
rebuilt FST beats the shipped FST on **bare-locality + homonym** while **golden stays flat**. Golden
flat is necessary but NOT sufficient. If the fragment board doesn't move, the rebuild is not
justified — keep the shipped 220k FST and ship only the Step-1 gate (which is a pure consumer change,
independently valuable for the FR −3).

### Step 4 — reship (only if Step 3 passes)

Via the release HF path — `mailwoman/release-tools/publish-hf.ts` `--fst /path/to/fst-en-US.bin`
(remote name `fst-en-US.bin`, BCP-47 casing — a casing mismatch 404s the demo gazetteer). The FST is
**model-independent** (the release skill reuses the prior version's FST for model-only bumps), so this
is an FST-only artifact update, not a model release. Follow the two-phase PR publish flow in the
`mailwoman-release` skill / `RELEASING.md` — never publish locally.

## Invariants (violate any of these and the work is wrong)

1. **Fragment board is the gate; golden can only veto.** (The central trap — see the top.)
2. **Positive evidence only.** The gate scales DOWN a positive bias when street context is present;
   absence of context never penalizes. Byte-identical output when no street context.
3. **Syntactic context, never importance magnitude.** No `importance²`, no magnitude discount.
4. **Street signal = the morphology FST, not codex US suffixes** (the FR regression trap).
5. **Measure in the shipped configuration** (LEAD-HANDOFF §0.4) — anchor + gazetteer on,
   `postcode-<cc>.bin` present. Harness caches lie; an identical-artifact rerun that disagrees means
   a stale cache, not a real delta.
6. **Spot-verify load-bearing numbers on the live CLI** before any reship decision (LEAD-HANDOFF §5 —
   probe reports have been wrong before). `node mailwoman/out/cli.js parse --neural "<input>"`.
7. **Don't touch the operator's WIP.** `corpus-python/modal/train_remote.py` (`sync_latam_br`/`sync_gb`)
   and `corpus-python/src/mailwoman_train/configs/v3.10.0-gb-probe.yaml` are UNCOMMITTED and the
   OPERATOR'S — stash/pop them across any pull, never commit them (LEAD-HANDOFF §0.7).

## File map

| File                                                      | Role                                                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `scratchpad/fable-1142-importance-street-context-gate.md` | **the authoritative design** — read in full                                                                       |
| `neural/fst-prior.ts`                                     | `buildFSTEmissionPriors`/`applyBias` — the gate goes here; `impBias` at :360, `importanceLengthScaleMode` (#1173) |
| `neural/classifier.ts`                                    | wires the priors; `opts.fst`/`opts.fstBiasScale` (dormant, :646); pass `fstStreetMorphology` into the gate        |
| `neural/street-morphology-prior.ts`                       | the morphology FST consumer — the street-type signal source                                                       |
| `resolver-wof-sqlite/fst-serialize.ts`                    | FST (de)serializer; importance f32 at offset 12 (:183); format doc at top                                         |
| `resolver-wof-sqlite/street-morphology-fst-builder.ts`    | builds `fst-street-morphology.bin`                                                                                |
| `mailwoman/commands/gazetteer/importance.tsx`             | `gazetteer importance` — builds `place_importance` (Nominatim Wikipedia + population fallback)                    |
| `mailwoman/commands/gazetteer/build/`                     | the FST/DB build commands (confirm the FST-emit CLI here)                                                         |
| `mailwoman/release-tools/publish-hf.ts`                   | the HF reship path (`--fst`)                                                                                      |

## Bottom line

#1172 + #1173 are merged and the reship was correctly held. The ship path for the rebuild is:
**implement the street-context gate (Step 1, recovers FR −3) → rebuild the 768k importance FST
(Step 2) → run the fragment board WITH the rebuilt FST (Step 3) → that board, and only that board,
justifies reshipping the 768k FST (Step 4).** If the board doesn't move, ship the gate alone and keep
the 220k FST. Then fork A of the comma-free fix can be built on a trustworthy FST.
