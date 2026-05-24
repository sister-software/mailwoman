---
sidebar_position: 16
title: A walkthrough — NY-NY Steakhouse, Houston, TX
---

# Joint decoding — a walkthrough

[The knowledge ladder](../understanding/the-knowledge-ladder.md) explains _why_ the v0.5.0 pipeline grew two new information layers (Stage 2.7 phrase grouper, expanded Stage 5 reconcile). This article walks through _what they actually do_ on one concrete input, end-to-end.

We use the operator's canonical kryptonite case:

> `NY-NY Steakhouse, Houston, TX`

This string breaks every previous version of Mailwoman. The token `NY` looks exactly like the abbreviation for New York (which is what a per-token classifier reads it as on its own), but the only interpretation that makes sense for the whole string is that `NY-NY` is part of a venue name, the city is Houston, and the region is Texas. No single layer can reach that conclusion alone. Joint decoding is the layer that can.

If you have not read [The staged pipeline](../understanding/the-staged-pipeline.md), do that first — this article assumes you know the six stages by name.

## Stage 1 + 2 + 2.5 (warm-up)

Stage 1 normalises the bytes. Nothing interesting happens here for our input — no NFC fix-ups, no abbreviation expansion. The string passes through unchanged.

Stage 2 is the locale gate. For Latin-only input like this, the default is `en-US` with a moderate confidence. The downstream resolver weights will tilt toward US gazetteer hits.

Stage 2.5 is the kind classifier. It looks at the shape of the string (commas, capitalisation, the trailing two-letter token after a final comma) and decides this is a `structured_address` — not a bare postcode, not a single locality. The full pipeline runs.

These three stages are not the interesting part for this example. Skip ahead.

## Stage 2.7 — phrase grouper proposes spans

The phrase grouper is the new layer at the top. Its job is **boundary discovery only** — it does not decide what type each span is, only "which tokens belong together". It emits a list of proposals with confidence scores.

For our input it produces (the actual scores come from [`phrase-grouper/kryptonite.test.ts`](https://github.com/sister-software/mailwoman/blob/main/phrase-grouper/kryptonite.test.ts)):

| Span   | Body               | Hypothesis            | Confidence |
| ------ | ------------------ | --------------------- | ---------- |
| 0..5   | `NY-NY`            | `HYPHENATED_COMPOUND` | 0.85       |
| 0..16  | `NY-NY Steakhouse` | `VENUE_PHRASE`        | 0.85       |
| 18..25 | `Houston`          | `LOCALITY_PHRASE`     | 0.65       |
| 27..29 | `TX`               | `REGION_ABBREVIATION` | 0.95       |

Three things to notice here:

1. **`NY-NY` and `NY-NY Steakhouse` both appear**, with overlapping start positions. The grouper does not pick — it proposes both and lets Stage 5 decide. A `HYPHENATED_COMPOUND` is one structural unit; a `VENUE_PHRASE` ending in a known venue marker (`Steakhouse`) is another. Both are coherent ways to read the same prefix.
2. **`Houston` gets a lower confidence (0.65) than `TX` (0.95)**. The grouper sees `TX` at the very tail after a comma, which is a strong structural signal for a region abbreviation. `Houston` is a capitalised word that _could_ be a locality but the grouper has no dictionary — it only knows it looks like a `LOCALITY_PHRASE` structurally.
3. **No span covers `,` or whitespace.** The grouper proposes only over real input tokens. The character offsets in the body column refer to the original input string.

What the grouper does _not_ know: that `NY` is the abbreviation for New York, that Houston is in Texas, that "Steakhouse" suggests a venue. All of those are world knowledge, and the grouper deliberately stays away. It supplies structural priors only — this is the [bitter-lesson safety](../understanding/the-knowledge-ladder.md#why-this-decomposition-is-bitter-lesson-aligned) we want at this layer.

## Stage 3 — classifier emits top-k tag sequences

Stage 3 is the neural classifier. Before v0.5.0 it returned a single best tag for each token (the argmax). After v0.5.0 it returns **top-k** — a ranked list of plausible interpretations per span, with calibrated scores.

For the spans the phrase grouper proposed, Stage 3 returns:

| Span   | Body               | Tag        | Score            |
| ------ | ------------------ | ---------- | ---------------- |
| 0..5   | `NY-NY`            | `region`   | **0.70** (top-1) |
| 0..5   | `NY-NY`            | `venue`    | 0.60 (top-2)     |
| 0..16  | `NY-NY Steakhouse` | `venue`    | 0.55             |
| 18..25 | `Houston`          | `locality` | 0.85             |
| 27..29 | `TX`               | `region`   | 0.95             |

This is the moment where everything goes wrong if we stop here. The classifier's **argmax** for `NY-NY` is `region` (score 0.70) — because in the training data, `NY` is overwhelmingly the abbreviation for the New York region. The `venue` reading is second-best (0.60). A pre-v0.5.0 system would emit `region: NY-NY, region: TX` and the resolver would have no idea what to do.

Notice though that the `venue` interpretation is _not_ far behind. The classifier knows it could be a venue; it just thinks region is slightly more likely _in isolation_. The top-k output preserves that information so Stage 5 can use it.

## Stage 4 — sequence corrector

Stage 4 is the CRF decoder. It enforces the BIO grammar (no orphan `I-*` without a preceding `B-*`) on the tag sequence. For our top-k input, the CRF passes the candidates through unchanged — there are no orphan BIO labels to fix in this example. (See [CRF decoder](./crf-decoder.md) for a case where Stage 4 _does_ change the output, e.g. `Saint Petersburg` → `Petersburg`.)

## Stage 5 — reconcile picks the joint-coherent interpretation

This is where the new joint decoder earns its keep. Stage 5 receives:

- **Phrase proposals from Stage 2.7** (the table from §3 above).
- **Top-k tags from Stage 3** (the table from §4 above).
- **Resolver candidates from Stage 6**, queried per-span — we will see them in a moment.

Stage 5's job is to pick **one** parse tree that maximises joint coherence — not the per-span argmax, but the combination that is internally consistent.

### What "joint-coherent" means

For our input there are two candidate interpretations on the table:

**Interpretation X** — take every span's argmax:

```
NY-NY     →  region   (0.70 × ?)
Houston   →  locality (0.85 × ?)
TX        →  region   (0.95 × ?)
```

This is what every Mailwoman version before v0.5.0 returned. Two regions in one address (`NY` and `TX`), one locality. The resolver tries to satisfy this and fails — it cannot find a `parent_id` chain where Houston is a locality in both New York and Texas. The output is incoherent.

**Interpretation Y** — take the `venue` reading for `NY-NY`:

```
NY-NY Steakhouse → venue    (0.55 × ?)
Houston          → locality (0.85 × ?)
TX               → region   (0.95 × ?)
```

This has one venue, one locality, one region. The resolver _can_ satisfy this: `parent_id(Houston) = Texas`, and the venue does not need to be in the gazetteer because venues are user-supplied free text.

Interpretation Y is **joint-coherent**. Interpretation X is not. The classifier alone cannot tell them apart, because the classifier sees each span in isolation. Stage 5 sees the whole picture.

### How the scoring works

Stage 5 does a beam search over `(span × tag × resolver candidate)` and scores each combination with:

```
score = phrase_confidence × classifier_confidence × resolver_score × concordance_bonus
```

The `concordance_bonus` is the new piece. For each candidate parse tree, Stage 5 looks up the `parent_id` chain in the Who's On First gazetteer (see [Resolver and WOF](./resolver-and-wof.md)) and asks: does the chain agree? Concretely:

- Interpretation X says `region: NY` and `locality: Houston`. WOF says `Houston → Texas`, not `Houston → New York`. The chain disagrees. The bonus drops to ~0 (a near-fatal penalty).
- Interpretation Y says `venue: NY-NY Steakhouse, locality: Houston, region: TX`. The chain `Houston → Texas → United States` is intact. Bonus is ~1.0.

The product favours Y by a wide margin, even though individual span scores are lower. The internal-consistency check dominates because incoherent parses are useless to downstream consumers.

### The empty-parse trap

One subtlety. The first version of the reconciler used a pure multiplicative score and discovered, empirically, that the score is _maximised_ by emitting **no spans at all** — because every factor is in `[0, 1]`, fewer factors means a higher product. The "empty parse" wins every comparison. Stage 5 fixes this by adding a fixed log-bonus for each accepted slot, so accepting a high-confidence span is net-positive. See [`reconcile-empty-parse-bonus.md`](./reconcile-empty-parse-bonus.md) for the full gotcha — this is the only non-obvious knob in the joint decoder.

## Stage 6 — resolver looks up coordinates

Stage 6 takes the winning parse tree from Stage 5 and converts each typed span into a place row in WOF. For Interpretation Y:

| Span               | Tag      | WOF lookup                            | Result                                 |
| ------------------ | -------- | ------------------------------------- | -------------------------------------- |
| `NY-NY Steakhouse` | venue    | (no lookup — venues are pass-through) | preserved as venue text                |
| `Houston`          | locality | locality + region:TX hint             | Houston, Texas (lat 29.76, lon -95.37) |
| `TX`               | region   | region in US                          | Texas (lat 31, lon -100)               |

The country is inferred from the region's parent chain (`Texas → United States`).

## Output

The full v0.5.0 output for `NY-NY Steakhouse, Houston, TX` is:

```json
{
	"venue": "NY-NY Steakhouse",
	"locality": "Houston",
	"region": "TX",
	"country": "US",
	"coordinates": [29.76, -95.37],
	"confidence": 0.42
}
```

The confidence is the product of the winning interpretation's per-stage scores. It is modest (0.42) because the underlying signals are modest — `Houston` only had 0.65 from the phrase grouper, the venue tag was a second-best from the classifier, etc. But the parse is _correct_, which is the headline win for v0.5.0.

## Why this was impossible before v0.5.0

The previous pipeline (v0.4.0 and earlier) had:

- No phrase grouper. Stage 3 had to guess boundaries _and_ types simultaneously from BIO labels.
- An argmax classifier — no top-k.
- A Stage 5 that only sorted spans by position and emitted them in order.

Given those three constraints, `NY-NY Steakhouse, Houston, TX` returned `region: NY, locality: Houston, region: TX` and downstream code crashed trying to make sense of two regions. The fix had to live at the reconciler layer because none of the upstream stages can see the joint picture by design — they each look at their own slice.

This is the [knowledge-ladder](../understanding/the-knowledge-ladder.md) point made concrete. Each stage knows its own kind of information; the joint decoder is what composes them. Removing the joint decoder is what makes geocoders fail on adversarial inputs. Adding it back is most of what v0.5.0 set out to do.

## See also

- [The knowledge ladder](../understanding/the-knowledge-ladder.md) — the conceptual frame for why these layers exist
- [The staged pipeline](../understanding/the-staged-pipeline.md) — the six-stage runtime composition
- [`STAGES.md`](../plan/reference/STAGES.md) — formal per-stage type contracts
- [`reconcile-empty-parse-bonus.md`](./reconcile-empty-parse-bonus.md) — the multiplicative-score gotcha (link will resolve once Doc D lands)
- [v0.5.0 — as shipped](../plan/v0-5-0-shipped.md) — what landed and when
