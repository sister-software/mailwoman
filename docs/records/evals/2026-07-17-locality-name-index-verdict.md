# 2026-07-17 — Locality name-index (the FR comma-drop xfail): a decode-time atlas prior is falsified; the split belongs to the k-best arbiter

The tracked defect (gauntlet `KNOWN_INV_XFAIL`, `comma-drop|181 Rue du Chevaleret, Paris`): a
comma-free address whose locality is the terminal token with no anchor after it —
`181 Rue du Chevaleret Paris` — absorbs the locality into the street span (`street="du Chevaleret
Paris"`, no locality), loses the rooftop, resolves to null. Every anchored form parses fine: the
comma form, the `…, 75013 Paris` postcode form, and the US twin (`…Washington DC`, fixed on merit by
the v381 punct-drop augmentation). The disambiguating knowledge is which names are places — the atlas.

The pre-registered question (road-to-v7 P1): can a **decode-time emission prior**, atlas-verified and
scoped like the doubleton bias (`neural/query-shape-prior.ts`), make the split without a retrain or the
k-best arbiter? Measured answer: **no.** The prior is structurally incapable of the disambiguation, for
a reason the emissions make arithmetic. This is the design-doc exit the task pre-registered.

Runner: `scratchpad/locality-index-probe.run.ts` (the shipped `neural-weights-en-us` model — v381 int8,
md5 `2025ac6e` — the same model the gauntlet grades every base with, FR included; `traceParse` raw
logits at the terminal piece). Baseline: `mailwoman eval gauntlet --layer metamorphic` → **PASS with 6
tracked xfails**, the Chevaleret comma-drop among them (`address_point→admin`, coord → null).

## What the emissions say

A decode-time prior can only add a constant to `B-locality` at the terminal piece. It flips the piece
from `I-street` to `B-locality` when the bias exceeds the model's own emission gap
(`max(I-street, B-street) − B-locality`). So the prior works iff a single bias threshold separates the
class that should flip (terminal token IS the locality) from the class that must not (the street
legitimately ends in a place-word). It does not:

| class                                    |                           example | terminal gap |
| ---------------------------------------- | --------------------------------: | -----------: |
| **flip** (terminal = locality)           |           `…Victor Hugo Bordeaux` |         2.18 |
| flip                                     |              `…Gambetta Toulouse` |         2.69 |
| flip (**the target**)                    | `181 Rue du Chevaleret **Paris**` |         3.29 |
| flip                                     |              `…de la Gare Rennes` |         4.30 |
| flip                                     |  `8 Boulevard Voltaire Marseille` |         5.03 |
| **keep** (place-word is the street)      |              `22 Rue de **Rome**` |         3.66 |
| keep                                     |                   `3 Rue de Metz` |         4.35 |
| keep                                     |               `8 Rue de **Lyon**` |         4.84 |
| keep (**identical token to the target**) |             `15 Rue de **Paris**` |         5.31 |
| keep                                     |                 `9 Rue de Rennes` |         5.71 |

Flip-class gaps span **[2.18, 5.03]**; keep-class gaps span **[3.66, 6.13]**. They **overlap on
[3.66, 5.03]**. A bias set to flip all ten targets (5.04) wrongly flips **3/10** real
`Rue de <City>` streets; a bias set at the flip-class median (~3.2) already breaks `Rue de Rome`.
There is no threshold that flips `…Paix **Lyon**` (3.15, locality) without also flipping
`Rue de **Rome**` (3.66, street) or `Rue de **Lyon**` (4.84, street). This is the same
constant-vs-context-mass defeat that beat the word-consistency heal on digit ownership: an additive
prior cannot outvote a distribution it is added to uniformly.

## Why the atlas can't rescue it — three structural walls

1. **Membership is identical across the boundary.** The target `…Chevaleret **Paris**` and the
   false-positive `15 Rue de **Paris**` carry the _same terminal token_ with the _same atlas hit_.
   Any atlas-membership gate — a shipped lexicon or a runtime candidate probe — fires identically on
   both. The only separator is grammatical attachment (does the place-word stand alone after a complete
   street, or complete a `Rue de …` name?), which membership cannot see and the model already encodes
   weakly in exactly the overlapping gaps above. An atlas-gated flat bias throws that signal away and
   replaces it with a constant.

2. **The gate reads pieces, not surfaces.** The en-us SentencePiece tokenizer fragments the FR city
   names this defect targets: `Marseille→"e"`, `Nantes→"es"`, `Grenoble→"ble"`, `Strasbourg→"bourg"`,
   `Turin→"in"`. The terminal _piece_ the prior would key on is a subword, not the locality surface, so
   a piece-level lexicon lookup never fires on half the target class (count at the unit the model reads).
   A char/word-level lookup re-imports the phrase-grouper's boundary problem.

3. **A shippable-small index can't be complete, and completeness wouldn't help.** The anchor lexicon is
   11 KB; the WOF locality set is millions of surfaces. A population-thresholded subset is both
   coverage-limited (misses the long tail the defect also hits) and — per wall 1 — useless where it does
   hit, because `Paris` is in it for both the target and the false-positive. There is no small index,
   and no complete index, that separates the two.

Two practical failures compound these: the terminal-single-token scope misses multi-word localities
(`Mountain View` — terminal `"View"` is not a locality), and the fix is necessary-not-sufficient anyway
(`15 Rue de Paris **Lyon**` parses `street="de Paris Lyon"` — the model sweeps the real trailing
locality into the street too, so flipping one terminal piece leaves a broken street tail).

## The honest fix — the resolver-as-arbiter, with its evidence interface

The split is decidable, just not from token identity. It is decidable from **whole-parse atlas
consistency**, which is the registry-backed doctrine's positive-evidence street/locality existence, and
which only the k-best arbiter (#727 stage-2) can consume. The arbiter generates the two competing
parses and scores each against the atlas:

- **Parse A** — `house="181" street="du Chevaleret" locality="Paris"`. Evidence: does a national
  register (BAN, Tier A) contain a thoroughfare `Rue du Chevaleret` **within** the locality `Paris`?
  Yes → A is atlas-consistent.
- **Parse B** — `house="181" street="du Chevaleret Paris"`. Evidence: does any register contain a
  thoroughfare literally named `du Chevaleret Paris`? No → B is atlas-inconsistent.
- For the false-positive `15 Rue de Paris`: parse B (`street="de Paris"`) **is** atlas-consistent —
  `Rue de Paris` is a real thoroughfare in many communes — so the arbiter keeps it. Same terminal
  token, opposite verdict, because the evidence is joint, not lexical.

This is the interface **B1 (#727 stage-2)** should consume — a per-candidate-parse evidence vector, not
a per-token clue:

```
StreetLocalityEvidence {
  street_in_locality: PositiveHit | null   // BAN/BAG: thoroughfare exists within the proposed locality
  street_as_named:    PositiveHit | null   // BAN/BAG: the full proposed street surface exists as a thoroughfare name
  locality_exists:    PositiveHit | null   // WOF/atlas: the proposed locality surface is a settlement (NOT street-existence)
  // PositiveHit = { tier: "A"|"B"|"C", population_rank?: number, provenance: string }
}
```

The arbiter prefers the candidate maximizing `street_in_locality + locality_exists` while penalizing a
`street_as_named`-only reading — positive evidence only, no global veto (the digit-ownership scar).
Tier discipline holds: WOF supplies `locality_exists` but never street existence; BAN/BAG (Tier A) is
the proving ground for the two street signals. This is the same shape the cascade-viability probe landed
on (2026-07-17): _the atlas judges parses, not tokens._

## Verdict

Do not build the decode-time locality prior; it cannot separate `…Chevaleret Paris` from
`Rue de Paris`, which carry the identical terminal token and identical atlas membership, and whose
emission gaps overlap. Leave the `comma-drop|181 Rue du Chevaleret, Paris` xfail tracked
(visible, non-blocking) and route the fix to the k-best arbiter (#727 stage-2) via the
`StreetLocalityEvidence` interface above. The probe cost one eval sweep and closes P1 with receipts.

> Note: the P1 brief cited "issue #30" for the locality name-index; GitHub #30 is in fact the NAD
> adapter. The concrete tracker for this defect is the #1101 comma-free-invariant xfail in
> `mailwoman/eval-harness/gauntlet/metamorphic.ts`.
