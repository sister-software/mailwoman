---
sidebar_position: 18
title: Synthetic corpus — alignment validation is load-bearing
---

# Synthetic corpus — alignment validation is load-bearing

Both v0.5.0 corpus threads (B kryptonite and B2 transliteration) used an LLM (DeepSeek) to generate annotated training rows. Both surfaced the same lesson: **the substring-match alignment check is not a quality filter you can drop later — it is structural infrastructure.** This article explains why.

## What alignment validation does

After the LLM generates a row, the validator confirms that every annotated component literally appears in the surface string. For example, if the LLM returns:

```json
{
  "surface": "350 5th Avenue, New York, NY 10118",
  "house_number": "350",
  "street": "5th Avenue",
  "locality": "New York",
  "region": "NY",
  "postcode": "10118"
}
```

the validator checks: does `350` substring-match the surface? Does `5th Avenue`? Does `New York`? Does `NY`? Does `10118`? If any one fails, the row is rejected before it reaches the training corpus.

The implementation is unglamorous (`generate_deepseek_corpus.py::align_or_reject` if you want to read it) but the contract it enforces is what makes the corpus trustworthy.

## What goes wrong without it

LLMs hallucinate around component boundaries. The B and B2 reject logs catalogue the common failure modes:

- **Component embedded in another component**. `house_number=350, street=350 5th Avenue` — the street contains the house number. A naïve trainer would see `350` as both a house number and as the first token of a street, and learn an incoherent BIO labelling.
- **Hallucinated transliteration fragments**. For B2's Cyrillic / Japanese / Hangul output, the LLM sometimes added a transliterated suffix or prefix that does not appear in the source surface. The annotated component would substring-match against itself but not against the surface — silently misaligned data.
- **Component missing from surface**. The LLM produced a `venue` field for a string that had no venue in it (model imagined one). No substring match → reject.
- **Off-by-one in the annotation**. `house_number=35` for a surface starting `350 5th Avenue` — close but wrong. Substring match fails because `35` does appear, but the validator can be made stricter to demand the full token (and was).

Reject rates from the two runs:

| Run | Total generated | Rejected | Rate |
|---|---|---|---|
| B (kryptonite) | 4,872 | 101 | 2.1% |
| B2 (transliteration) | 74,140 | 821 | 1.1% |

Neither approaches zero. The 1–2% range is the **floor** for DeepSeek-as-corpus at the prompt quality we shipped with. Better prompting drops it further but does not eliminate it. The validator is permanent infrastructure.

## Why this matters more for synthetic data than for real data

For corpora harvested from real sources (NPPES, NAD, WOF, BAN), alignment problems are bugs in the harvester or in the source — rare, deterministic, fixable by a one-line ETL patch. A 0.01% reject rate is plausible.

For LLM-generated corpora, alignment problems are inherent to the generation process. The model is producing both the surface and the annotation in the same forward pass; nothing forces internal consistency. Even with temperature=0 and `reasoning_effort=low`, the 1–2% rate persists.

This shifts the validator from "quality filter" to "trust boundary". Without it, you are training on data the LLM only thinks it generated correctly. With it, every row in the corpus is provably consistent with its annotation.

## What the validator does not catch

The substring check enforces structural consistency but not semantic correctness. A row where the LLM annotated `street=Main` for the surface `123 Main Street` will pass — `Main` substring-matches. But the correct annotation is `street=Main Street`. The check confirms _what is annotated_ exists in the surface; it does not confirm _what should be annotated_ matches what _is_ annotated.

Three things bridge the gap:

1. **Prompt engineering** — the prompts for B and B2 included explicit examples showing full-token annotations. This moves the LLM toward the right behaviour at generation time.
2. **`corpus-audit`** — runs over the assembled corpus and checks distributional invariants (component balance, surface length distribution, character-set coverage). It catches "annotations are technically consistent but pathological" classes of bug.
3. **Held-out eval** — the golden eval set (`v0.1.2`) catches the model learning bad patterns from systematically-skewed synthetic data, even when each row is individually consistent.

The validator is the first line of defence. Audit and eval are the second and third.

## Pattern to carry forward

Any future synthetic-corpus pipeline should ship with:

1. **A substring-match validator** that runs per-row before the row reaches the corpus. Reject reasons logged with structured tags so the reject-rate breakdown is greppable (`reject:not-in-raw:street` etc., the shape B and B2 use).
2. **A reject-rate floor expectation** in the pipeline's README. If you see reject rate drop to zero, that is a bug in the validator, not a quality breakthrough.
3. **A `corpus-audit` pass before declaring done** — the validator is necessary but not sufficient.

The cost is low (a few hundred lines of Python). The value is high (the corpus you train on is the corpus you think you have).

## See also

- [`CORPUS_V0_4_0_GENERATION.md`](../plan/reference/CORPUS_V0_4_0_GENERATION.md) — the operational record for the v0.5.0 corpus generation, including the actual prompts used
- [v0.5.0 — as shipped](../plan/v0-5-0-shipped.md) — context for where corpus-v0.4.0 fits
- [The knowledge ladder](./the-knowledge-ladder.md) — why we keep generation honest at this layer rather than trying to fix it downstream
