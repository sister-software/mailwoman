# Punctuation-stress + paired-delimiter eval — the span proposer doesn't earn its revival (2026-06-14)

_Closes the measurement half of #518. The question was narrow and gated: our eval surfaces (OA/NAD/golden)
are government data, punctuation-poor by construction, so neither engine had ever been graded on the
quadrant where real user input lives — quoted venue names, parenthetical annotations, `c/o` lines,
unbalanced delimiters. #518 said: measure the class first, and only revive the abandoned Stage 2.7
paired-delimiter span proposer if the numbers say it earns its keep. They don't._

## What was measured

`data/eval/external/punctuation-stress.jsonl` — 200 hand-curated + arena-mined rows across 11 classes
(quoted venue, parenthetical annotation, parenthetical component, bracketed, `c/o`, dotted abbreviations,
hyphenated names, slash/fraction, apostrophe, "mixed-hard", and unbalanced delimiters). Gold convention:
delimiters are **excluded** from component values unless postal-meaningful (the `#` in a unit, the dots in
`P.O.`); apostrophes and hyphens _inside_ a token are kept (`O'Brien`, `Winston-Salem`). Conventions in
`data/eval/external/punctuation-stress.README.md`.

Scored by `scripts/eval/score-punctuation-stress.ts` (per-component exact match, case-insensitive, on each
engine's own vocabulary view of identical gold). Each row also measures **parse survival** — a thrown parse
fails every component, which is exactly what the unbalanced-delimiter rows exist to catch.

- **v0** — the legacy rule parser (`createAddressParser`), deterministic, no model.
- **neural** — the shipped int8 model (`model-v140-step-40000-int8`, package v4.6.0; tokenizer `v0.6.0-a0`),
  full ship config (anchor + gazetteer + convention auto + punctuation-gap bridge). Graded on the **folded
  gold view** (affixes joined into `street`) for an apples-to-apples head-to-head with v0.
- **neural + span proposer** — the Stage 2.7 paired-delimiter proposer (`--span-proposer`, default-off, NOT
  ship config), at three bias settings.

## Results

| class               |       v0 |   neural | +SP (default) | +SP (bias 2) | +SP (bias 4 / ann 4) |
| ------------------- | -------: | -------: | ------------: | -----------: | -------------------: |
| apostrophe          |     89.0 |     80.8 |          80.8 |         80.8 |                 80.8 |
| bracketed \*        |     80.3 |     85.6 |          85.6 |         85.6 |             **76.5** |
| care-of             |     60.8 |     72.5 |          72.5 |         72.5 |                 72.5 |
| dotted              |     82.3 |     74.0 |          74.0 |         74.0 |                 74.0 |
| hyphen              |     86.9 |     80.8 |          80.8 |         80.8 |                 80.8 |
| mixed-hard          |     58.2 |     72.7 |          72.7 |         70.0 |                 66.4 |
| paren-annotation \* |     78.4 |     87.5 |          87.5 |         87.5 |             **68.2** |
| paren-component \*  |     76.5 |     82.4 |          82.4 |         82.4 |                 82.4 |
| quoted-venue \*     |     75.3 |     74.1 |          74.1 |         74.1 |                 72.8 |
| slash               |     71.8 |     61.5 |          61.5 |         58.1 |                 59.8 |
| unbalanced \*       |     68.3 |     82.5 |          82.5 |         82.5 |                 84.1 |
| **overall**         | **75.7** | **77.3** |      **77.3** |     **76.6** |             **73.4** |
| **parse deaths**    |    **2** |    **0** |         **0** |        **0** |                **0** |

`*` = paired-delimiter classes (the proposer's target). Component accuracy %, 200 rows, folded gold.

## Verdict: the span proposer does not earn its revival (as implemented)

At **every** bias tested, the Stage 2.7 span proposer is a no-op or a regression on the paired-delimiter
classes it was built for:

- **Default (no bias): exactly zero effect** — `+0.0pp` on every class. As wired, the proposer contributes
  no bias unless `--sp-bias` is set, so the shipped default does literally nothing.
- **Gentle (bias 2): −0.7pp overall, no help** — the four paired-delimiter classes are unchanged; the only
  movement is slash and mixed-hard going _down_.
- **Strong (bias 4 / annotation 4): −3.9pp overall, actively harmful** — paren-annotation collapses 87.5 →
  68.2 and bracketed 85.6 → 76.5, because the annotation bias pushes the **wrong direction**: it _merges_
  the delimited content into the adjacent span (`Wallaby Way (rear entrance`, `Water St [SE corner`) instead
  of stripping it.

So the abandoned Chevrotain-style proposer isn't a drop-in win waiting to be switched on. Its annotation
semantics need a **fix** (the bias has the wrong sign — it should suppress, not absorb), not a parameter
sweep. Reviving it as-is would regress the very class it targets. **Recommendation: do not revive on these
numbers; if pursued, treat it as new design work, not a flag flip.** (Caveat: three bias configs are not an
exhaustive sweep — but a feature that's a no-op at default and net-negative at the two non-trivial settings
has not cleared the bar #518 set.)

## The finding that matters more: neural already wins, and its failure mode isn't v0's

The head-to-head is the real takeaway:

- **Neural beats v0 overall (77.3 vs 75.7) and is categorically more robust — 0 parse deaths vs 2.** On the
  unbalanced-delimiter rows that exist to test "degrade, don't die," neural degrades gracefully (82.5%) while
  v0 throws on the malformed input.
- **The two engines fail differently.** v0 **shatters on quotes and poisons neighbors**: `"Big Company HQ"`
  loses the venue entirely (the quote is a hard field wall — the `fieldsFuncBoundary` TODO admits it), and
  `1600 Pennsylvania Ave NW (The White House), Washington` poisons the locality to `White` and shifts the
  region to `Washington`. Neural instead **over-extends spans**: it absorbs the next component or the
  delimiter run into the current span — `Sydney NSW` (locality eats the region), `Oxford OX1 4DB` (locality
  eats the postcode), `Rue du Bac (escalier B` (street eats the unbalanced paren).
- **v0 still wins the within-token classes** — apostrophe (89.0 vs 80.8), dotted (82.3 vs 74.0), hyphen
  (86.9 vs 80.8), slash (71.8 vs 61.5). Its rules handle `123 1/2`, `O'Brien`, `St.` precisely; neural
  wobbles on fractional house numbers and absorbs trailing tokens.

The implication for the roadmap: the highest-leverage punctuation-stress lever is **not** a new span
proposer — it's reducing neural's span **over-extension at delimiters** (a boundary/decode problem, kin to
the Saint-Albans fragmentation and the #555 `locateSpan` over-run). That's where the paired-delimiter rows
actually break, and it's a sharper, cheaper target than reviving Stage 2.7.

## Reproduce

```bash
# v0 (deterministic, no model)
node --experimental-strip-types scripts/eval/score-punctuation-stress.ts --engine v0
# neural ship config (folded gold, head-to-head)
node --experimental-strip-types scripts/eval/score-punctuation-stress.ts \
  --engine neural --model neural-weights-en-us/model.onnx --fold-gold
# + span proposer (the revival question)
… --span-proposer                       # default: no-op
… --span-proposer --sp-bias 2           # gentle: −0.7pp
… --span-proposer --sp-bias 4 --sp-ann-bias 4   # strong: −3.9pp, merges annotations
```

## Caveats

- Folded-gold view (affixes → `street`) for the head-to-head; per-engine vocabularies graded on their own
  view of identical gold (stated in the scorer header).
- Neural numbers are the shipped int8 v140 / `v0.6.0-a0` tokenizer. Don't compare these absolute figures
  across tokenizer versions — the head-to-head and the span-proposer deltas are what matter here.
- Three span-proposer bias configs, not an exhaustive sweep. The verdict is "doesn't clear the #518 bar as
  implemented," not "no parameterization could ever help."
