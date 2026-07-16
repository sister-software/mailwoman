# The digit-ownership defect is cross-lingual, coverage-independent, and length-conditioned

2026-07-16. The measurement that unifies H3, B0, and the one PL failure B1's coverage story could
not explain — and that explains why B4's probe barely moved.

**Finding: the intra-word digit incoherence B0 measured on Norwegian is the same defect on
correctly-parsed Polish streets that are in-corpus and admitted by the filter. It is not coverage, it
is not the street→locality leak, and it is length-conditioned — the model reproduces a real corpus
prior on long digit-run continuations. A targeted fragment shard fights that prior uphill, which is
why B4 (weight 12, 2k steps) moved the target only +1.7pp.**

---

## The one row coverage couldn't explain

B1 showed most Track B failures were the Norway YAML bug (25k rows dropped) — coverage, not a model
defect. But one parity row survived: `aleja Wojska Polskiego 178` → postcode. **PL is in the corpus
and admitted by the filter, and the street parses correctly**, so neither coverage nor the Track A
street→locality leak explains it. It is the single clean digit-ownership failure.

## The piece-level trace (shipped v310, package-shaped)

Every street piece reads `B-street`/`I-street` — the street is fine. The failure is entirely in the
digit run:

```
aleja Wojska Polskiego 178   ▁1 START B-hn=0.397 B-pc=0.487   7 I-pc=0.417   8 I-pc=0.735   -> postcode
ulica Marszałkowska 140      ▁1 START B-hn=0.655 B-pc=0.217   4 I-pc=0.552   0 I-pc=0.800   -> postcode
aleja Jerozolimskie 91       ▁9 START B-hn=0.665 B-pc=0.196   1 I-pc=0.540                  -> postcode
aleja Wojska Polskiego 12    ▁1 START B-hn=0.823 B-pc=0.088   2 I-hn=0.646                  -> house_number ✓
```

This is **exactly B0's Norwegian signature** (`Tindvegen nedre 44B`: B-hn 0.604 on the first piece,
I-pc 0.587/0.765 on the continuations). On `Marszałkowska 140` and `Jerozolimskie 91` the first digit
piece is confidently `B-house_number` (0.655, 0.665) — the model _starts_ the run correctly — and the
continuations flip to `I-postcode`, so Viterbi's legality mask resolves the incoherent
`B-house_number → I-postcode` to the postcode-consistent path. Same mechanism, three languages
(French, Norwegian, Polish).

## It is length-conditioned, and that closes the loop with H3

`aleja Wojska Polskiego 12` (2 digits) reads `house_number` correctly. `aleja Wojska Polskiego 178`
(3 digits, same street) fails. The only variable is run length, and the continuation postcode mass
climbs with it (`I-pc` 0.417 → 0.735 across the two continuations of `178`).

That is precisely what the [H3 piece-prior](./2026-07-16-trackb-digit-ownership-h3-verdict.md)
measured in the _corpus_: `P(I-postcode | digit-run continuation)` rises with length — 0.043 at 2
digits, 0.879 at 5. **The model is not malfunctioning; it is reproducing its corpus prior faithfully,
and that prior says a long digit run's continuations are postcode.** Postcodes are long, house
numbers are short, digits tokenize one piece per character, so length is the signal the model has,
and it uses it.

Three measurements, one mechanism:

|      | what it showed                                                  | unit                         |
| ---- | --------------------------------------------------------------- | ---------------------------- |
| H3   | the corpus teaches `P(I-pc \| continuation)` rising with length | corpus, per piece            |
| B0   | the model reproduces it: B-hn first, I-pc continuations         | model, per piece (Norwegian) |
| this | same on correctly-parsed, in-corpus Polish — not coverage       | model, per piece (Polish)    |

## Why B4 barely moved — this is the reason, not just the ratio

B4's verdict named `--bare-street-prob 0.30` as the likely reason its target moved only +1.7pp. This
probe adds the deeper reason: **a fragment shard is fighting a real, strong, length-conditioned
corpus prior.** At 3+ digits the corpus itself pushes continuations toward postcode with mass up to
0.879. A targeted signal at weight 12 for 2k steps dents that; it does not overturn it. That is why
the guards held (no harm) but the target barely moved — the shard and the prior are pulling against
each other on the same pieces.

**Two implications for B4b, both to be pre-registered not spun tonight:**

1. **Oversample long house numbers.** The defect is worst at 3+ digits, where the postcode prior is
   strongest. A shard drawn from real NO/PL numbers is mostly 2–3 digits; deliberately weighting
   3–4-digit house numbers aims the signal where the prior is hardest to beat.
2. **The representation direction is the real lever.** The #727 research says a lower-fertility vocab
   is upstream of any head, and this is the digit-specific evidence: a 3-digit number is 3 pieces
   with 2 postcode-leaning continuations _because_ digits tokenize one-per-character. A vocab where
   `178` is one piece removes the continuation-postcode mass entirely. That is a bigger change than a
   shard, and it is the operator's call whether Track B justifies re-opening the vocab work.

## What this does NOT change

- **The fix is still a shard OR the vocab — not a validator.** The house rule holds: this is
  positive evidence and representation, never a hard postcode veto. The model's first-piece
  `B-house_number` is usually _right_; the fix is to stop the continuations from overriding it, not
  to forbid postcodes.
- **B4b is still the operator's call.** This sharpens the hypothesis (oversample long numbers; or go
  to vocab) but does not license a solo 3am run.

## Reproduce

```bash
node scratchpad/pl-piece-probe.run.ts
```
