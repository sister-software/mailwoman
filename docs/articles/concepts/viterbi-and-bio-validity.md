---
sidebar_position: 29
title: Viterbi and BIO validity
tags:
  - concepts
  - neural
  - viterbi
  - crf
  - architecture
---

# Viterbi and BIO validity

After the encoder produces per-token emission logits and the FST priors
add their additive biases, there's still a problem: **the per-token
argmax produces structurally invalid sequences**.

Concretely: BIO labels follow a grammar. An `I-X` label has to come
after a `B-X` (begin of the same tag) or another `I-X`. The sequence
`O B-street O I-street` is invalid — the second `street` token starts
in the middle of a span with no begin.

The Viterbi decoder enforces this grammar globally. This article
explains how, why it matters, and how learned CRF transitions
(coming in v0.6.4) extend the picture.

## The BIO label space

Mailwoman's Stage 3 schema has 33 BIO labels:

```
O
B-country  I-country
B-region  I-region
B-locality  I-locality
B-dependent_locality  I-dependent_locality
B-postcode  I-postcode
B-subregion  I-subregion
B-cedex  I-cedex
B-venue  I-venue
B-street  I-street
B-house_number  I-house_number
B-street_prefix  I-street_prefix
B-street_suffix  I-street_suffix
B-unit  I-unit
B-po_box  I-po_box
B-intersection_a  I-intersection_a
B-intersection_b  I-intersection_b
```

`O` means "no tag" (a comma, whitespace token, or word that doesn't
contribute to any component). Every other label is paired — a `B-X`
starts a span of type X, and `I-X` continues that span.

## What "valid" means

A label sequence is valid under BIO grammar iff:

- The first non-O label is a `B-X` (not `I-X`).
- Every `I-X` is preceded by `B-X` or `I-X` (same tag).
- No `I-X` follows `B-Y` or `I-Y` where `X ≠ Y`.
- `O` can appear anywhere.

So `[O, B-street, I-street, O, B-locality, B-region]` is valid.
`[B-street, I-locality]` is invalid (mid-tag switch).

If you just take per-token argmax, you get whatever each token's
highest-probability label is — regardless of validity. That can produce
nonsense like `[B-street, I-locality, O]` if the encoder's emissions
push the second token toward `I-locality` and the first toward
`B-street`.

## What Viterbi does

Viterbi searches for the **highest-scoring label SEQUENCE**, not
per-token argmaxes:

```
best_path = argmax over all valid sequences s of (
  sum over t of emission_score(token_t, label_t)
  + sum over (t, t+1) of transition_score(label_t, label_{t+1})
)
```

The emission scores come from the encoder + priors. The transition
scores come from:

1. **The structural BIO mask** (always present): `-∞` for invalid
   transitions, 0 for valid ones. Hard constraint.
2. **Learned CRF transitions** (optional, when shipped): a learned
   matrix of `transition_logit[from_label][to_label]`. Soft preference
   for common label-pair transitions vs rare ones.

In v0.6.x today, only the structural mask is active (the
[fp32-CRF diagnostic](../evals/2026-05-28-fp32-crf-diagnostic.md)
confirmed the bf16-CRF NaN issue; v0.6.4 will enable learned CRF
transitions with the fp32 fix).

The output is a valid label sequence that maximizes the total score.
Per-token argmaxes that violate BIO are replaced with the
globally-best valid choice.

## A concrete example

`123 Main St`:

| Position | Token  | Per-token argmax        | Argmax score | Viterbi pick                 |
| -------- | ------ | ----------------------- | ------------ | ---------------------------- |
| 0        | `123`  | `B-house_number` (0.95) | 0.95         | `B-house_number`             |
| 1        | `Main` | `I-locality` (0.4)      | 0.4          | `B-street` (next-best, 0.35) |
| 2        | `St`   | `I-street` (0.85)       | 0.85         | `I-street`                   |

The per-token argmax for `Main` was `I-locality` — but that violates
BIO because `I-locality` can't follow `B-house_number`. Viterbi rejects
that sequence and picks the next-best valid option: `B-street` with
score 0.35. The total `B-house_number + B-street + I-street` sequence
scores higher than any alternative valid sequence.

## Why structural validity matters downstream

The
[tree builder](https://github.com/sister-software/mailwoman/blob/main/core/decoder/build-tree.ts)
that turns BIO sequences into `AddressTree`s assumes valid BIO. It
walks the sequence, opens a new node on `B-X`, extends the current
node on `I-X`, closes on transition to a different tag or O. If the
BIO is invalid, the tree builder either drops tokens (orphan `I-X`
becomes part of the previous span's value) or produces structurally
wrong output.

Viterbi prevents this. The tree builder always sees a valid sequence,
and the resulting `AddressTree` is structurally correct (even when the
labels themselves might be wrong about the address content).

## When the structural mask is insufficient

The mask says "this transition is structurally allowed." It doesn't
say "this transition is statistically likely."

Consider: `B-region → B-locality` is structurally valid. So is
`B-region → B-postcode`. But in real addresses, `region` is almost
always followed by `postcode` (`MA 02101`), not another locality. The
structural mask treats both as equally allowed.

Learned CRF transitions encode the statistical preference. After
training, the transition matrix would have higher score for
`B-region → B-postcode` than for `B-region → B-locality`. The Viterbi
pass would then prefer the more common sequence.

Without learned CRF, Viterbi just falls back on emission scores —
which is what we ship today. It works because the encoder emissions
already encode most of the sequencing signal via attention. The CRF
would be additive improvement, not a replacement for the encoder.

## Why learned CRF was disabled in v0.6.x

The
[2026-05-28 night-shift postmortem](../evals/2026-05-28-night-2-postmortem.md)
captured the story: enabling learned CRF transitions in Stage 3 (33×33
transition matrix with masked `-∞` entries) caused NaN gradients
twice during training. The
[fp32-CRF diagnostic](../evals/2026-05-28-fp32-crf-diagnostic.md)
identified the root cause: bf16 precision is insufficient for the
masked `logsumexp` over `-∞` entries. The fix is to run just the CRF
forward in fp32 while the rest of the model stays bf16 — `crf_fp32:
true` in the v0.6.4 yaml.

v0.6.3 ships without learned CRF (CE-only). v0.6.4 will turn it on.

## What CRF buys (and what it doesn't)

CRF buys soft transition preferences that the encoder didn't pick up
strongly from training data. Examples:

- `B-house_number` is almost always followed by `B-street` or `O,
B-street`. CRF can encode this preference.
- `B-postcode` rarely precedes anything (it's usually the last
  component). CRF can encode "B-postcode → O" preference.
- `B-street_prefix → B-street` is common; `B-street_prefix →
B-locality` is rare. CRF can rank these.

CRF doesn't buy:

- Better encoder representations. The encoder is the upstream learner;
  CRF is downstream.
- Handling of novel patterns. If a sequence isn't represented well in
  training, CRF has no opinion.
- Inference speed. CRF Viterbi over learned transitions is slightly
  slower than the structural-mask-only version (matrix lookups per
  transition).

## Decoder modes

The `parse()` API accepts a `decode` option:

- `"viterbi"` (default): full Viterbi with BIO mask + (optional) CRF
  transitions. Produces structurally valid sequences.
- `"argmax"`: per-token argmax with no sequence consideration. Faster
  but produces invalid sequences. Used in ablation studies to measure
  how much Viterbi contributes vs how much is in the encoder.

The `"argmax"` mode is kept for diagnostic purposes. Production always
uses `"viterbi"`.

## See also

- [How the model reasons](./how-the-model-reasons.md) — the central
  pipeline doc
- [Attention and bidirectional context](./attention-and-bidirectional-context.md) — what's UPSTREAM of Viterbi
- [FST priors as shallow fusion](./fst-priors-as-shallow-fusion.md) —
  the additive biases on the emissions Viterbi consumes
- [fp32-CRF diagnostic](../evals/2026-05-28-fp32-crf-diagnostic.md) —
  why learned CRF was disabled in v0.6.x and how v0.6.4 brings it back
- [BIO labels](./bio-labels.md) — the per-tag label space (existing
  reference)
