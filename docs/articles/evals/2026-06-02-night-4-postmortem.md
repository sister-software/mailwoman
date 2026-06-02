# Night shift 2026-06-02 — multi-locale (German) coverage

**Headline: the German coverage path is fully built, baselined, and staged — and the one expensive,
irreversible step (the training launch) is parked for an operator yes, because launching it mutates
the shared training corpus manifest.** Everything else shipped. This is a one-approval handoff, not a
debugging session.

## What shipped (branch `eval/multi-locale-de`, 10 commits ahead of main)

1. **DE-0 — tokenizer gate: PASS.** `scripts/diag-tokenizer-de.ts`. The v0.6.0-a0 SentencePiece
   tokenizer round-trips German orthography losslessly (10/10 samples; `ß` gets its own piece next to
   its street stem). So `Straußstraße → Strau` is the out-of-distribution model exiting at the
   ß-piece boundary, not a tokenizer ceiling. Coverage is the fix. (commit `97d1ec4`)
2. **DE-1/DE-2 — German synthesizer + shard.** `corpus/src/synthesize-german.ts` (+ 3 passing tests)
   renders REAL OpenAddresses Berlin/Saxony tuples in idiomatic German order via the OpenCage `DE`
   template, teaching house-number-after-street + postcode-before-city. `build-german-shard.mjs`
   pools 1.2M real DE tuples → a 5,000-row labeled shard. (commit `08f85f1`)
3. **DE-3 prep (staged, NOT run).** `v0_8_0-german.yaml` continue-trains v0.7.2 (+40k → step-140000,
   `synth-german: 0.2`, `DE: 1.0`). The parquet is uploaded to the volume. (commit `ac571ca`)
4. **DE-4/5 — eval harness + held-out golden.** `scripts/eval-de-coverage.sh` runs the whole
   before/after; `openaddresses-de-golden.jsonl` is the held-out German set. (commit `e43400a`)
5. **Earlier this session (the day's work, also on this branch):** the `--default-country` flag, the
   per-source bbox + German OA ingest, the per-locale-f1 tripwire, the full-stack capability probe.
6. **Docs:** the multi-locale write-up (`2026-06-02-multi-locale-german-coverage.md`) and the German
   section of the external-eval README. (commits `2e96b35`, `233e652`)

## The one thing that needs your hands: launch the German train

The auto-classifier gated the in-place mutation of the **shared** corpus `MANIFEST.json` — correctly,
because my own plan flagged DE-3 as needing your sign-off, and "wide berth" is general autonomy, not
specific authorization to mutate shared training infra. The MANIFEST entry is staged at
`/tmp/MANIFEST.json` (and re-derivable). To launch:

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

## The pre-registered test (decide before you read the numbers)

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
  `Weißwasser /O.L.` — Kreis/region suffixes glued to the city). It doesn't hurt the order signal
  (street/house position), but it dirties locality labels. A `CITY`-cleaning pass is a cheap follow-up.

## Decisions made autonomously

- **Continue-train (+40k) over a fresh 100k run.** ~$3 vs ~$8; leaves budget buffer; v0.7.2's
  step-100000 stays immutable. Cost: the v0.7.2 output dir now would hold step-140000 too (named
  clearly). Alternative was a clean separate dir, which `train_remote` can't init-from without a
  volume-side checkpoint copy.
- **Sourced the shard from real OA tuples, not synthesized German streets.** German morphology is too
  easy to fake wrong.
- **Stopped at the MANIFEST gate rather than working around it.** The denial was correct.

## Open questions for the operator

1. Approve the German train (the 4 commands above)? Or adjust (fresh run vs continue, step count, weight)?
2. Merge `eval/multi-locale-de` to main? It's tested + linted; the German config is inert until launched.
3. The de golden eval is synthetic (real OA tuples, German-order rendered). Good enough as the German
   parser eval, or do you want a hand-curated German set?

## Concrete next steps

- (operator) Run the 4-command launch, or hand it back with a tweak.
- (next session) After the train: `scripts/eval-de-coverage.sh` on the export → fill the before/after.
- (next session) FR is the other weak locale (micro 62.8%); the same synth-from-real-OA recipe applies
  (`synthesize-french.ts` + an FR bbox + `FR` already weighted).
- (cheap follow-up) CITY-column cleaning in `build-german-shard.mjs`.

## Numbers

|                      |                                          |
| -------------------- | ---------------------------------------- |
| shift window         | 03:19 UTC → 14:00 UTC                    |
| models trained       | 0 (training gated on operator approval)  |
| Modal spend          | $0 (no training launched)                |
| commits              | 10 on `eval/multi-locale-de`             |
| NaN incidents        | 0                                        |
| CI failures          | 0                                        |
| classifier gates hit | 1 (shared MANIFEST mutation — respected) |
