# Track B — H3 is dead, and the corpus is exonerated

2026-07-16. The digit-ownership investigation's first measured verdict.

**Verdict: the corpus teaches the right thing, the model learned it, and the failing rows are not a
prior problem.** H3 ("the corpus prior favours postcode over house_number") is refuted at every unit
it can be posed at. So is the length-marginal theory that replaced it, and that theory was mine.

The defect is real — parity precision reads `postcode 25/249 = 0.100` emitted where the gold has
none — but it is a **tail**, not a centre, and nothing in the training distribution explains it.

---

## 1. What H3 claimed, and why the first count was worthless

The claim: the model calls `39A` a postcode because its corpus says digit-bearing tokens are
postcodes.

The first count said the opposite (`P(house_number | bare digit) = 0.810` vs `postcode 0.101`) and
was **unusable anyway**: it read one synthetic shard (`fragment-v8`) off disk, unweighted. Training
draws from a weighted multinomial over ~700 shard refs (`source_weights`), after a country filter, a
coarse filter, and five augmentations.

`digit_prior` re-counts through `iter_rows` — the same entry point `train.py` calls, with the
config's own weights. Reimplementing the sampler is how the first count went wrong, so this one
doesn't.

|                                | house_number |   postcode |
| ------------------------------ | -----------: | ---------: |
| the old single-shard count     |        0.810 |      0.101 |
| **the real weighted marginal** |   **0.4765** | **0.4453** |

The real aggregate is a coin flip. It is also **meaningless** — the signal is entirely in the shape
conditional, and averaging over shapes destroys it. (The house rule: [the aggregate is not the
verdict][verify].)

## 2. The token-level count: postcode is not rare, it is absent

Cut by country and token shape — 400k rows, 563,197 bare digit tokens:

| country | shape |      n | P(house_number) | P(postcode) |
| ------- | ----- | -----: | --------------: | ----------: |
| pl      | 2d    |    313 |          0.9840 |  **0.0000** |
| nl      | 2d    |  2,197 |          0.9882 |  **0.0000** |
| nl      | 3d    |    875 |          1.0000 |  **0.0000** |
| de      | 2d    | 14,698 |          0.9970 |  **0.0000** |
| de      | 3d    |  2,151 |          0.9800 |  **0.0000** |
| fr      | 3d    |  8,523 |          0.9578 |  **0.0000** |
| us      | 3d    | 46,287 |          0.7224 |  **0.0000** |
| nl      | 4d    |  4,714 |          0.0119 |      0.9875 |
| de      | 5d    | 27,214 |          0.0000 |      1.0000 |

`P(postcode | a 2- or 3-digit token)` is **zero** — not rare — in every country with data, across
100k+ samples. The model emits postcode on `121`, `178`, `104`, `14` regardless.

**This looked decisive and it was the wrong unit.** The model has never seen a token.

## 3. The unit error, and the story it made plausible

The model reads SentencePiece **pieces** and emits one label per piece. Digits tokenize about one
piece per character — the fertility check confirms it (2 digits → 2 pieces 0.94; 5 digits → 5 pieces
0.92) — so a 5-digit postcode `[9|0|2|1|0]` mints **four** `I-postcode` labels while a 2-digit house
number `[1|4]` mints **one** `I-house_number`. Postcodes are long, and long runs mint proportionally
more continuation labels: **4.2× per instance**.

`piece_prior` counts at that unit, through `iter_encoded` — again the real call, so the tokenizer and
the BIO expansion are the shipped ones (200k rows, 818,430 continuation pieces):

| digit run                 | P(cont → house_number) | P(cont → postcode) |
| ------------------------- | ---------------------: | -----------------: |
| 2 digits                  |                 0.7711 |             0.0427 |
| 3 digits                  |                 0.6858 |             0.0477 |
| 5 digits                  |                 0.0926 |             0.8792 |
| **marginal, all lengths** |                 0.2609 |         **0.6623** |

5-digit runs supply **55.6%** of all continuations, so the marginal inverts the conditional —
mechanically, by length.

That produced a tempting story: **the model learned the marginal (0.66) rather than the conditional
(0.04)**. A per-piece probe on two failing rows fit it almost exactly — `Tindvegen nedre 44B` emits
`I-postcode` at 0.587/0.765, `Epleskogen 39A` at 0.657/0.643, against a marginal of 0.6623. The
arithmetic worked, the mechanism was plausible, and it explained the tokenizer's role.

It is wrong.

## 4. The control that killed it

`piece-position-probe.run.ts` bins the model's **own** per-piece posterior over the parity corpus by
(run length, position in run), split by whether the row emits a postcode the gold lacks. Its
pre-registered read sits in its header, written before the numbers existed; it fired `REFUTE`.

| digit run          | rows it gets right | rows w/ spurious postcode | corpus conditional |
| ------------------ | -----------------: | ------------------------: | -----------------: |
| 2d cont → postcode |         **0.0270** |                **0.5238** |             0.0427 |
| 3d cont → postcode |         **0.1566** |                **1.0000** |             0.0477 |
| 4d cont → postcode |             0.5208 |                    1.0000 |             0.5079 |
| 5d cont → postcode |             0.9444 |                    1.0000 |             0.8792 |

Two things fall out.

**The model conditions on run length correctly.** On the rows it gets right it reproduces the
length-conditioned corpus almost exactly (2d: 0.0270 vs 0.0427; 5d: 0.9444 vs 0.8792), monotonically,
crossing over at 4 digits. That crossover is **deepparse's measured ≥4 boundary** — the thing we were
told it had and we lacked. We have it. It is in the emissions.

**The failing rows sit at the same run length with 19× the postcode rate.** Length cannot be the
variable, because length is held fixed across the split.

So the marginal story dies: a model that had learned the marginal would read 0.66 everywhere, not
0.027 on 351 rows and 0.52 on 25.

## 5. What is actually eliminated

| hypothesis                                        | status                  | evidence                                                       |
| ------------------------------------------------- | ----------------------- | -------------------------------------------------------------- |
| the corpus prior favours postcode (H3)            | **dead**                | zero postcodes on 2-3 digit tokens, every country              |
| the model contradicts its corpus                  | **dead**                | it matches the length conditional on 351/376 rows              |
| the model learned the length-marginal             | **dead**                | 0.027 vs 0.524 at identical length                             |
| the tokenizer's length-weighting is the mechanism | **dead as a mechanism** | the imbalance is real (4.2×) and the model is not fooled by it |
| postcode-anchor channel teaches it                | dead                    | true runtime ablation, delta 0                                 |
| `postcodeRepair` regex adds it                    | dead                    | 25/249 both arms                                               |
| class weights                                     | dead                    | identical (B/I = 1.5) in v264's config                         |
| deepparse schema/field-order prior                | dead                    | it tags bare `39A` as StreetNumber with no street field        |

Eight hypotheses, eight refutations. **Three of them were mine**, and the two in this document died to
the same control that killed the five stories the span-head arc lost: split the population and look.

## 6. What survives — the lead, stated as a lead

The one variable that moves with the failures is the **street token**, and the evidence is mixed:

- Recognized streets (`Main St`, `Broad St`) → house_number **14/16**. Unrecognized (`Epleskogen`,
  `Kájovská`) → **1/16**.
- But it is not a clean law: `Tindvegen 44B` → house_number while `Tindvegen nedre 44B` → postcode.
  Adding one word flipped it.
- Position is refuted: `14 Main St` → hn and `Main St 14` → hn, but `14 Epleskogen` → pc while
  `Epleskogen 14` → hn — opposite directions.

Every failing row is Norwegian, Polish, Dutch, or New Zealand. **Norway does not appear in the
country census at all** at the ≥30-sample threshold. For those rows the question may not be "what did
the corpus teach" but "the corpus has nothing to teach from" — which is coverage, not prior, and a
different fix. That census read is unfinished and is the next measurement, not a conclusion.

### The symmetry worth noticing

The house-number **licence** — the defect v310 just fixed — was: _a digit licenses the street
reading_, so a street with no number read as a locality. The Track B lead is its mirror: _a known
street licenses the house_number reading_, so a number after an unknown street reads as a postcode.

Both are the model refusing to read one component without its co-occurring partner. If that holds,
they are one defect seen twice, and the fix that worked on the first half — a phenomenon shard
teaching the component **without** its partner, plus a counter-distribution so the model learns the
distinction instead of flipping its default — is the same shape as the fix for the second.

That is a hypothesis with a strong prior and no measurement. It gets tested, not assumed. The
registry tiers say the shard would be BAN/BAG-sourced (tier A) with OSM (tier D) only as an
experiment, and it stays **positive evidence only** — no validator, no veto.

## 7. What this does not touch

The Dutch minimal pairs (`1234SA`, `1234SS`, `0123AB`) are a **different problem**. NL 4-digit runs
→ postcode at 0.9875, so the model is _following_ its corpus correctly there; what is missing is the
validity rule (the `SS`/`SD`/`SA` exclusion and the 1000 floor), which nothing in the system encodes
and which deepparse does not have either. That is not digit ownership and should not be bundled with
it.

## Reproduce

```bash
modal run corpus-python/modal/train_remote.py::digit_prior --rows 400000
modal run corpus-python/modal/train_remote.py::piece_prior --rows 200000
node scratchpad/piece-position-probe.run.ts
```

[verify]: ./2026-07-16-t1c-fragment-board-verdict.md
