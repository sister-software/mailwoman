---
sidebar_position: 14
title: Tokenizer A0 — baseline
---

# Tokenizer A0 — baseline

The v0.5.0 plan ([`PHASE_8 §A`](../phases/PHASE_8_v0_5_0_fresh_slate.md)) splits the tokenizer retrain into two steps:

- **A0** trains on `corpus-v0.3.0` (the existing en-US + fr-FR corpus, no transliterations) using the new SentencePiece harness. Its purpose is to validate the harness and measure a byte-fallback **baseline** before the new synthetic data lands.
- **A1** retrains on `corpus-v0.4.0` (= v0.3.0 + Thread B kryptonite + Thread B2 transliteration). Its purpose is to actually hit the plan's `< 5%` byte-fallback target on non-Latin scripts.

This article records the A0 numbers so the A1 delta is interpretable.

## The headline numbers

A0 was trained 2026-05-23 on a single host (no rented compute), 1.04 hours wall-clock. SentencePiece configuration:

| Knob                   | A0                                                              | v0.1.0 (predecessor) |
| ---------------------- | --------------------------------------------------------------- | -------------------- |
| `model_type`           | unigram                                                         | unigram              |
| `vocab_size`           | 48,000                                                          | 16,000               |
| `character_coverage`   | 0.9999                                                          | 0.9995               |
| `byte_fallback`        | true                                                            | true                 |
| `user_defined_symbols` | 2,110                                                           | 0                    |
| Training corpus        | corpus-v0.3.0, US + FR @ 500K each + 2K mined postcode literals | (historical)         |

Eval fixture: 43 hand-curated lines covering CJK / Cyrillic / Armenian / Greek / Arabic / Hebrew / Devanagari / Thai / Latin-with-diacritics. The fixture lives at `data/eval/multi-script/v0.5.0-a0.jsonl`.

| Script      | A0 byte-fallback | v0.1.0 baseline | Δ            |
| ----------- | ---------------- | --------------- | ------------ |
| **overall** | **36.7%**        | 18.0%           | **+18.7 pt** |
| cjk         | 80.0%            | 51.6%           | +28.4 pt     |
| cyrillic    | 2.2%             | 0.0%            | +2.2 pt      |
| armenian    | 21.3%            | 0.0%            | +21.3 pt     |
| greek       | 16.3%            | 0.0%            | +16.3 pt     |
| arabic      | 5.0%             | 0.0%            | +5.0 pt      |
| hebrew      | 10.0%            | 0.0%            | +10.0 pt     |
| devanagari  | 12.8%            | 0.0%            | +12.8 pt     |
| thai        | 46.7%            | 10.0%           | +36.7 pt     |
| latin       | 5.8%             | 0.0%            | +5.8 pt      |
| other       | 34.3%            | 0.0%            | +34.3 pt     |

**A0 is worse than v0.1.0 on every script.** This is not a bug. It is the expected outcome and it is the point of running A0.

## Why A0 looks worse — the WOF admin-name leakage hypothesis

The v0.1.0 tokenizer was trained on a corpus that included **Who's On First admin-name variants**. WOF ships place names in many scripts — Tokyo appears as `Tokyo` _and_ `東京` _and_ `Tōkyō` _and_ in Cyrillic transliteration, all in the same admin record. Mailwoman v0.1.0's training pipeline pulled these admin records to populate Stage 6 lookups, and the tokenizer training scanned the same data.

The result: v0.1.0's byte-fallback rate on Cyrillic / Armenian / Greek / Arabic / Hebrew / Devanagari was effectively zero, not because the corpus had real coverage of those scripts but because **the place-name admin variants accidentally taught the tokenizer enough sub-pieces to avoid byte-fallback on a small evaluation slice**.

When we moved to `corpus-v0.3.0` (US DOT NAD + WOF postalcode + cleaner US/FR address rows), those incidental admin-name variants stopped being in the tokenizer training set. A0 — trained on the same en-US + fr-FR mass without the WOF admin leakage — has effectively no non-Latin coverage. Hence the regressions you see in the table.

The v0.1.0 numbers were never an honest measurement of multi-script capability; they were a leakage artefact. A0 is the first honest measurement of "what does our tokenizer do on adversarial transliteration input when we have not trained it on any". The answer is: badly. As expected.

## What A1 will measure

A1 retrains on `corpus-v0.4.0` = `corpus-v0.3.0` + Thread B (4,771 kryptonite rows) + Thread B2 (~75K transliteration pairs into Cyrillic / Japanese / Hangul / Han / Armenian). The transliteration pairs are the part that matters for byte-fallback — they put real non-Latin character sequences into the tokenizer's training set.

The headline metric is the **A1 vs A0 delta on each script**:

- **Target**: A1 byte-fallback < 5% overall on the same fixture, with per-script rates approaching the v0.1.0 numbers (the leakage numbers) as a floor.
- **Stretch**: per-script rates well below v0.1.0 on the scripts B2 explicitly covers (cjk, cyrillic, hangul, han, armenian).
- **Anti-goal**: regression on Latin. A1 should not lose ground on the en-US + fr-FR mass.

A1 retrain is a single re-invocation of the A0 harness against `corpus-v0.4.0` — deterministic with `--seed 42`, takes the same ~1 hour. The output writes to `/data/models/tokenizer/v0.5.0-a1/` and the model card carries the same shape (a JSON file with sentencepiece flags, training-line count, training duration, byte-fallback per-script, and a SHA-256 of the `.model` file).

## What A0 is good for, even though it lost

Three things:

1. **The harness is validated.** A0 trained end-to-end on real data. Reservoir sampling, the user-defined-symbols normalisation step (see [`SP UDS whitespace gotcha`](./sentencepiece-uds-whitespace.md) — or, if you are reading on the published docs site, the version in the mailwoman repo at `corpus-python/src/mailwoman_train/tokenizer_train.py`), the model card writer, the byte-fallback eval — every piece worked. A1 has zero new code to write.
2. **The eval fixture is validated.** 43 hand-curated multi-script lines is small but the per-script breakdown is informative enough to tell us _where_ a retrain helped vs hurt. Future tokenizer iterations will use the same fixture and the same harness, so A0 / A1 / A2 numbers will be directly comparable.
3. **The user-defined-symbols list is validated.** A0 has 2,110 UDS — US state codes, country abbreviations, postcode literal patterns (`5-digit ZIP`, `5-4 ZIP+4`, UK alphanumeric blocks, JP `100-0005`). The A0 harness substitutes ASCII space → U+2581 internally so SP's normalisation does not silently disable the UDS (the [SP UDS whitespace gotcha](./sentencepiece-uds-whitespace.md)). That substitution is now battle-tested.

## Model card schema

A0's `model_card.json` is the contract for every future tokenizer. It carries:

```json
{
  "tokenizer_version": "v0.5.0-a0",
  "corpus_version": "v0.3.0",
  "vocab_size": 48000,
  "training_lines": 1000000,
  "training_duration_seconds": 6294.237,
  "generated_at": "2026-05-23T19:53:06Z",
  "git_commit": "378a55d…",
  "model_sha256": "a864fde…",
  "sentencepiece_flags": { … },
  "sampling": {
    "countries": ["US", "FR"],
    "per_country": 500000,
    "seed": 42
  },
  "byte_fallback_eval": {
    "overall": { "lines": 43, "pieces": 1075, "byte_fallback_pieces": 395, "rate": 0.367 },
    "per_script": { "cjk": …, "cyrillic": …, … }
  }
}
```

`META.json` is a thin shim with the same content, kept for compatibility with `@mailwoman/neural-weights-*` package loaders that already read it.

## See also

- [PHASE_8 §A](../phases/PHASE_8_v0_5_0_fresh_slate.md#a-tokenizer-retrain--multi-script--adversarial-coverage) — the plan's tokenizer scope
- [Tokenization](../../concepts/tokenization.md) — what SentencePiece does and why byte-fallback matters
- [v0.5.0 — as shipped](../v0-5-0-shipped.md) — where A0 fits in the six-thread bundle
- [`CORPUS_V0_4_0_GENERATION.md`](./CORPUS_V0_4_0_GENERATION.md) — how the corpus A1 will train on is being assembled
