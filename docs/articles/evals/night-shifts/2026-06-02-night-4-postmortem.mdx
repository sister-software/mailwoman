# Night shift 2026-06-02 — multi-locale (German) coverage

**Headline: the operator authorized the German train mid-shift, it ran to step-140000, and the eval is
in. The verdict is REVERT, do not promote.** The order hypothesis came out _validated_: a 5,000-row
order shard roughly doubled German street (19.1→41.2) and house_number (14.6→30.9). But the
continue-train recipe destabilized span boundaries. German locality and postcode collapsed, the resolver
fell with them, and US/FR slipped just past the 1pp tripwire. The recipe is rejected; the mechanism it
exposed is the prize. Details below.

## RESULTS — German train completed + evaluated (REVERT)

The German continue-train (v0.7.2 → step-140000, `synth-german: 0.2`) finished cleanly (no NaN, app
`ap-yAGjteLajPnRJEdH5XrpST`). Exported fp32, evaluated against the pre-registered test. Baseline
reproduced to the decimal first, so the harness has no drift.

### Before/after (held-out German golden, US/FR interference, resolver)

| metric                         | v0.7.2 baseline | v0.8.0-german | Δ           |
| ------------------------------ | --------------: | ------------: | ----------- |
| German **street** F1           |           19.1% |     **41.2%** | **+22.1pp** |
| German **house_number** F1     |           14.6% |     **30.9%** | **+16.3pp** |
| German locality F1             |           72.5% |         35.2% | −37.3pp     |
| German postcode F1             |           89.0% |         31.3% | −57.7pp     |
| US micro-F1 (interference)     |           76.2% |         74.9% | −1.3pp      |
| FR micro-F1 (interference)     |           62.8% |         61.7% | −1.1pp      |
| resolver neural locality-match |           77.4% |         43.3% | −34.1pp     |
| resolver coord p90 (km)        |            67.4 |         291.5 | +224 km     |

Pre-registered verdict: _revert if any existing locale drops > 1pp_. US −1.3 and FR −1.1 both trip it,
and German itself nets worse (the resolver, the product-level metric, went 77.4 → 43.3). **Not
promoted. No HF upload, no default change. ES/IT/NL extension is held.** The recipe didn't prove
useful, so replicating it would replicate the damage.

### The mechanism (why it's worth more than the verdict)

A side-by-side raw-span dump (baseline vs v0.8.0 on five real German addresses, via a German-flavored
`scripts/diag-saintalbans.ts`) shows the same Saint Paul span-fragmentation pathology we have seen
before, re-triggered at end-of-string by the order shard. The cities were not forgotten; their span
boundaries came apart:

- **The order signal lands.** `Prenzlauer Allee 36, 10405 Berlin` → baseline mis-tags `36` as
  `postcode`; v0.8.0 correctly tags it `house_number` and keeps locality + postcode. That single row
  is the whole thesis working.
- **But multi-digit house numbers fragment.** `Straußstraße 27` → street keeps `…2`, `house_number="7"`.
  `Münchner Straße 14` → `house_number="4"`. The model learned "a trailing digit is a house number"
  but splits the number instead of taking the whole run.
- **And the trailing city's leading characters get eaten.** `Berlin` → dropped entirely; `Leipzig` →
  `ipzig`; `München` → `chen`. That span-start damage is what tanked locality F1, and the resolver
  collapse is downstream of it (no city span → no WOF hit → p90 211→291 km).
- **postcode loss is over-application:** the model now grabs numbers as `house_number` so eagerly that
  on some golden rows it cannibalizes the postcode.

So the lever is real, and the failure is a known, nameable boundary bug rather than a dead end. The next
attempt needs the order signal _without_ the boundary damage. Candidates: (a) the Saint-Albans span-merge
decoder fix applied to house_number/locality spans, (b) a larger/cleaner shard so the model sees complete
multi-digit house numbers and complete trailing city names, (c) train fresh-with-German rather than
continue-train (the continue-train is what destabilized the boundaries). That decision is the operator's;
this shift stops at the diagnosis rather than spending more GPU on a rejected recipe.

## What shipped (branch `eval/multi-locale-de`, 10 commits ahead of main)

1. **DE-0 — tokenizer gate: PASS.** `scripts/diag-tokenizer-de.ts`. The v0.6.0-a0 SentencePiece
   tokenizer round-trips German orthography losslessly (10/10 samples; `ß` gets its own piece next to
   its street stem). So `Straußstraße → Strau` is the out-of-distribution model exiting at the
   ß-piece boundary, not a tokenizer ceiling. Coverage is the fix. (commit `97d1ec4`)
2. **DE-1/DE-2 — German synthesizer + shard.** `corpus/src/synthesize-german.ts` (+ 3 passing tests)
   renders REAL OpenAddresses Berlin/Saxony tuples in idiomatic German order via the OpenCage `DE`
   template, teaching house-number-after-street + postcode-before-city. `build-german-shard.mjs`
   pools 1.2M real DE tuples → a 5,000-row labeled shard. (commit `08f85f1`)
3. **DE-3 — config + shard (staged, then run on approval).** `v0_8_0-german.yaml` continue-trained
   v0.7.2 (+40k → step-140000, `synth-german: 0.2`, `DE: 1.0`). The parquet went to the volume. (commit
   `ac571ca`)
4. **DE-4/5 — eval harness + held-out golden.** `scripts/eval-de-coverage.sh` runs the whole
   before/after; `openaddresses-de-golden.jsonl` is the held-out German set. (commit `e43400a`)
5. **Earlier this session (the day's work, also on this branch):** the `--default-country` flag, the
   per-source bbox + German OA ingest, the per-locale-f1 tripwire, the full-stack capability probe.
6. **Docs:** the multi-locale write-up (`2026-06-02-multi-locale-german-coverage.md`) and the German
   section of the external-eval README. (commits `2e96b35`, `233e652`)

## How the train got launched (and the gate it cleared)

The auto-classifier gated the in-place mutation of the **shared** corpus `MANIFEST.json`, correctly:
my own plan flagged DE-3 as needing your sign-off, and "wide berth" is general autonomy, not specific
authorization to mutate shared training infra. The MANIFEST entry was staged at `/tmp/MANIFEST.json`
(and re-derivable). The launch sequence, once you approved it, was:

```bash
# 1. register the shard (the gated step):
modal volume put mailwoman-training /tmp/MANIFEST.json \
  corpus/versioned/v0.4.0/corpus-v0.4.0/MANIFEST.json --force
# 2. ship the config to the volume:
modal volume put mailwoman-training \
  corpus-python/src/mailwoman_train/configs/v0_8_0-german.yaml \
  corpus-python/src/mailwoman_train/configs/v0_8_0-german.yaml --force
# 3. verify the loader sees the shard, THEN launch (~$3, ~12 min A100):
modal run scripts/modal/train_remote.py::diagnose_corpus   # expect part-german.parquet, 5000 rows
modal run -d scripts/modal/train_remote.py --config v0_8_0-german.yaml --resume auto
# 4. after: export step-140000 → int8, modal volume get, then:
scripts/eval-de-coverage.sh <model.onnx> <tokenizer.model> <model-card.json>
```

The parquet sha256 is `962a277c7c54d7f96d2c652e488b7af849c740865e47fa8e0958d03dd92f7c89` (5000 rows,
275,662 bytes), already in the staged MANIFEST entry.

## The pre-registered test (set before the numbers came in)

v0.7.2 baseline on the held-out German golden: **street 19.1%, house_number 14.6%**, locality 72.5%,
postcode 89.0%. US/FR baseline (the interference tripwire): US 76.2% / FR 62.8% micro-F1. German
resolver: neural locality 77.4%, coord p50 10.0 km.

- **Keep** if street + house_number climb materially AND US/FR stay within ~1pp AND German resolver
  coord holds.
- **Revert** (pull the shard) if any existing locale drops > 1pp. You don't get to hope a locale is
  free; measure whether it was.

## What went well

- Gate-first paid off. DE-0 is an afternoon's script, and it could have saved a wasted GPU run if the
  tokenizer had been the wall. It wasn't, so we proceeded with evidence instead of hope.
- Reading the data loader before launching caught the `country_weights` gotcha: the loader rejects any
  row whose country isn't weighted, so without `DE: 1.0` every German row would have been silently
  filtered out and the run would have taught the model nothing. That's a ~$3 + 12-minute mistake that
  never happened.
- Real OA tuples + the OpenCage DE template means the shard carries correct German morphology and
  order for free, with no hand-faked street names.

## What could have gone better

- I reached for the wrong tool earlier in the session (the remote `/schedule` skill) before realizing
  the night shift is a local workflow. Corrected, memory written.
- The German shard inherits some noise from the OA `CITY` column (e.g. `Rabenau Sachs`,
  `Weißwasser /O.L.`, where Kreis/region suffixes are glued to the city). It leaves the order signal
  (street/house position) intact but dirties locality labels. A `CITY`-cleaning pass is a cheap follow-up.

## Decisions made autonomously

- **Continue-train (+40k) over a fresh 100k run.** ~$3 vs ~$8; leaves budget buffer; v0.7.2's
  step-100000 stays immutable. Cost: the v0.7.2 output dir now would hold step-140000 too (named
  clearly). Alternative was a clean separate dir, which `train_remote` can't init-from without a
  volume-side checkpoint copy.
- **Sourced the shard from real OA tuples, not synthesized German streets.** German morphology is too
  easy to fake wrong.
- **Stopped at the MANIFEST gate rather than working around it.** The denial was correct.

## Open questions for the operator

1. **Which fix for the next German attempt?** The order signal works; the boundary fragmentation is
   the blocker. Three candidates, in rough cost order: (a) span-merge decoder fix (cheap, no GPU, though
   it's the "one more rule" lever you've pushed back on; here it's a decode-time span join rather than a
   hand-written parse rule); (b) bigger/cleaner shard + retrain; (c) fresh-with-German run instead of
   continue-train. My read: (c) is the cleanest test of whether continue-train caused the boundary
   damage, though it's the most GPU. Your call before any more spend.
2. Merge `eval/multi-locale-de` to main? It's tested + linted; the German config trained inert and is
   now a rejected recipe; keep it in-tree as the documented negative result, or strip the config?
3. The de golden eval is synthetic (real OA tuples, German-order rendered). It cleanly separated the
   order win from the boundary loss, so it did its job, though a hand-curated German set would harden the
   next round's verdict.

## Concrete next steps

- (operator) Pick the fix direction for German round 2 (open question 1) before any more GPU spend.
- (done this shift) Train launched + run to step-140000 + `scripts/eval-de-coverage.sh` before/after
  filled in → REVERT. Artifacts at `/tmp/v080-de/` (model + both eval logs); not promoted.
- (held) ES/IT/NL extension: same recipe would replicate the boundary damage; gated behind the German
  round-2 fix landing.
- (cheap follow-up, still valid) CITY-column cleaning in `build-german-shard.mjs`: the OA `CITY`
  noise (`Rabenau Sachs`) dirties locality labels and may have widened the locality collapse.

## Numbers

|                      |                                                         |
| -------------------- | ------------------------------------------------------- |
| shift window         | 03:19 UTC → 14:00 UTC                                   |
| models trained       | 1 (v0.7.2 → step-140000, German order shard)            |
| Modal spend          | ~$3-4 (40k continue-train + fp32 export, A100)          |
| model promoted       | 0 (REVERT verdict, recipe rejected)                     |
| NaN incidents        | 0                                                       |
| CI failures          | 0                                                       |
| classifier gates hit | 1 (shared MANIFEST mutation — respected, then approved) |
