# 2026-07-18 — Phase-4c wired: the k-best name-evidence rerank, and the collateral the board missed

Day-shift continuation of the #727 stage-2 arc. The night landed three pieces on main — the span
decode surface (#1154), the `StreetLocalityEvidence` arbiter (#1156), the P1 design (#1152) — and
measured the name-evidence rerank at +6.0pp street@1 on the FR fragment board. This is the wiring:
compose them into one production entry point, `rerankByStreetEvidence`, and — the part the board
did not do — check what the rerank costs the REST of the parse.

## The board measured street in isolation; the wiring measured the whole tree

The night's board scored the street tag alone. Wiring it into a real parse (segmentation → tree)
surfaced a hazard the board could not see: **the span head is a street-boundary specialist, and its
full segmentation decode is far worse than the BIO argmax head on every other tag.** Replacing the
argmax tree with the segmentation decode:

| golden | argmax exact | seg-decode exact    | fr locality       | fr postcode   |
| ------ | ------------ | ------------------- | ----------------- | ------------- |
| us     | 0.724        | 0.661 (−6.4pp)      | —                 | —             |
| fr     | 0.828        | **0.478 (−35.0pp)** | 0.855 → **0.506** | 0.996 → 0.946 |

A −35pp fr collapse. The +6pp street win, taken naively, would have shipped a locality/postcode
disaster. The board's number was real but partial.

## The fix: splice the street only, and only when the atlas confirms it

Two design moves, each measured:

1. **Street-splice, not tree-replace.** Override only the tokens the winning segmentation labels
   street-family; argmax owns locality/region/postcode/house_number. This alone recovered most of
   the loss (fr exact −1.4pp) but still cost fr street −2.7pp — the span head over/under-extends the
   street on clean multi-component inputs where the BIO head is better.
2. **Positive-evidence gate.** Splice only a street the atlas CONFIRMS exists. On a clean address
   the argmax street is already right + confirmed → the splice is a no-op; on a fragment the argmax
   street is wrong/absent and the confirmed segmentation street replaces it. An unconfirmed street
   never overrides the model.

## Result — the honest production delta (vs argmax, the baseline production runs)

| board (evidence-gated street-splice) | argmax baseline | reranked  | delta         |
| ------------------------------------ | --------------- | --------- | ------------- |
| golden us exact                      | 0.724           | 0.724     | **+0.000**    |
| golden fr exact                      | 0.828           | 0.828     | **+0.000**    |
| golden — every tag (us+fr)           | —               | —         | **unchanged** |
| FR fragment street@1                 | 0.673           | **0.841** | **+16.9pp**   |
| — bare-street                        | 0.770           | 0.950     | +18.0pp       |
| — date-name                          | 0.133           | 0.540     | +40.7pp       |
| — street-particle                    | 0.858           | 0.935     | +7.7pp        |

273 fixes / 3 breaks on the fragment board. **Zero golden regression, +16.9pp on FR fragments.**
Note the framing: the night's "+6.0pp" was measured against the span-head's own seg@1; against the
model production actually runs (argmax), the fragment-street win is +16.9pp — the argmax baseline was
much lower on fragments than the segmentation seg@1 the board used.

## Status + what's next

- `mailwoman/kbest-street-rerank.ts` — `rerankByStreetEvidence(classifier, text, evidence, grammar,
opts)`, PURE composition (injected evidence), byte-stable fallback for span-less models. Unit
  tested; `SQLiteStreetNameLookup` now exported from the resolver-wof-sqlite barrel (a gap #1156 left).
- **Not yet in the runtime pipeline / CLI.** The function is the wired primitive; threading it into
  `createRuntimePipeline` behind a flag (so the CLI + drop-in servers exercise it) is the next step,
  along with the full CLI promote battery (gauntlet, metamorphic) — the golden guard here is the
  headline gate and it passes at 0.000.
- **FR index rebuild (BAN sdk):** `street-centroids-fr.db` predates the contract fold; rebuilding it
  with `foldStreetSurface` + a `street_norm` index closes the last few fragment misses (3 breaks) and
  makes the production lookup fast.
- The rerank changes only the STREET tag, only on atlas-confirmed evidence — the anti-Pelias
  discipline held end to end: one bit of evidence, no score blending, the model owns every uncertain call.
