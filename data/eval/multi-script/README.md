# Multi-script tokenizer eval fixtures

Held-out lines used to measure SentencePiece **byte-fallback rate** per script. Consumed
by `python -m mailwoman_train tokenizer --eval-fixture …`, which records the rate (overall
and per-script) in the trained tokenizer's `model_card.json`.

These are **not** parser-output gold (no `components` field) — they exercise the tokenizer
only. Lines are hand-curated rather than corpus-sampled so the per-script slices stay
balanced and so the file is small enough to keep in git.

## File

- `v0.5.0-a0.jsonl` — the fixture used to grade `tokenizer-v0.5.0-a0`. Lines cover CJK
  (Japanese / Chinese / Korean), Cyrillic (Russian / Ukrainian / Bulgarian / Serbian /
  Belarusian / Georgian-via-Russian), Armenian, Greek, Arabic, Hebrew, Devanagari, Thai,
  and a Latin baseline including Polish / Czech / Hungarian / Turkish / Icelandic /
  Faroese diacritics. Plus one Georgian-script row that the script detector tags `other`,
  as a sanity check on the fallthrough path.

## Schema (one JSON object per line)

```json
{
  "raw":     "<address text>",
  "script":  "latin|cjk|cyrillic|armenian|greek|arabic|hebrew|devanagari|thai|other",
  "country": "<ISO 3166-1 alpha-2>",
  "notes":   "<free-form annotation>"
}
```

`script` is informational — the harness independently re-detects script per line via
`tokenizer_train.detect_script` and buckets the byte-fallback rate accordingly. The
authored value is for human readability.

## Rationale

A0 trains on `corpus-v0.3.0`, which is en-US + fr-FR mass with effectively zero non-Latin
content. **Byte-fallback on this fixture is expected to be high** — that's the *point*:
the rate measured here is the A0 baseline, and the A1 retrain on `corpus-v0.4.0` (with
Thread B's synthetic transliterations) should drive it down. The A0→A1 delta is the
headline tokenizer KPI for v0.5.0.

Target: <5% byte-fallback overall on the fixture **after** A1 lands. If A0 misses 5%, that
is expected; A0's job is to establish the baseline + validate the harness.
