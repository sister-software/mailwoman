# PIX1 biases the child on an unchecked assumption about the parent (2026-08-04)

**TL;DR.** `brooklyn, new york, ny` produces a tree with a `dependent_locality` and **no locality at
all**, and the pre-prior model was right. The PIX1 placetype-pair prior demotes the child span on the
stated assumption that "the parent keeps the model's own — typically strong `locality` — read"
(`neural/placetype-pair-prior.ts:159`). Here the parent's own read is `B-region` by 4.21 nats,
because the trailing `ny` re-anchors "New York" to the state. The prior is logit-blind by
construction — `buildPlacetypePairPriors(opts, pieces, labels)` never receives the emissions — so
nothing checks whether the assumption it rests on actually held.

## This is not a suppression problem

Recording it because the session that found it started from the opposite premise. There is **no
`dependent_locality` suppression** anywhere in the runtime; R5
(`docs/superpowers/plans/2026-08-01-r5-us-deploc-preregistration.md`) went looking for one and
overturned the doc that asserted it. The tag is dead **in the model, uniformly**, from a training-side
class weight of 0.3 on `B/I-dependent_locality` carried v0.5.1 → v0.8.0 to "penalize hallucination of
rare tags" — corrected to 1.0 but never retrained into the shipped lineage. PIX1 exists precisely to
clear that ~7.0-logit deficit, which is the same enrichment direction as the venue / terminal / wing /
sub-venue work, not against it.

So the finding below is not an argument for firing PIX1 less. It is that one of its firings inverts
its own purpose: it removes an admin level instead of adding one.

## The measurement

Raw pre-prior argmax per piece, shipped en-US weights (`model-v401-base-step-060000-int8.onnx`),
`traceParse`:

| input                    | piece    | raw argmax             |     margin over runner-up |
| ------------------------ | -------- | ---------------------- | ------------------------: |
| `brooklyn, new york, ny` | brooklyn | **B-locality (0.942)** |  5.31 nats over B-country |
|                          | new york | **B-region (0.895)**   | 4.21 nats over B-locality |
|                          | ny       | B-region (0.924)       |                 5.09 nats |
| `Brooklyn, NY`           | brooklyn | B-locality (0.952)     |                 5.48 nats |

`priors` on the three-segment input: `{"kind":"placetypePair","applied":true,"probePath":"segment"}`.
On `Brooklyn, NY` it does not fire. Post-prior labels:

```
brooklyn, new york, ny  ->  B-dependent_locality  I-dependent_locality  B-region I-region  O O  B-region
Brooklyn, NY            ->  B-locality            O O                   B-region
```

Resolved (candidate backend), showing the coordinate consequence:

```
dependent_locality = Brooklyn    40.644536, -73.947928   <- the correct place
region             = New York    42.921227, -75.596537
region             = NY          42.921227, -75.596537
```

Brooklyn itself resolves correctly. But a consumer asking "what locality?" gets nothing, and
coordinate grading that walks the admin tiers falls through to the region — **288 km out**. The
pre-prior tree (`locality=Brooklyn`) would have graded at 0 km.

## Why the assumption is normally safe

Every case R5 pre-registered has a parent that reads `locality` on its own, because something to its
right pins it there:

| input                                                     | intended                                     | what pins the parent      |
| --------------------------------------------------------- | -------------------------------------------- | ------------------------- |
| `31-01 Ditmars Blvd, Astoria, Queens, New York, NY 11105` | dep_loc="Astoria, Queens", locality=New York | trailing `NY 11105`       |
| `350 5th Ave, Manhattan, New York, NY 10118`              | dep_loc=Manhattan, locality=New York         | trailing `NY 10118`       |
| `123 Main St, Park Slope, Brooklyn, NY 11215`             | dep_loc=Park Slope, locality=Brooklyn        | `Brooklyn` is unambiguous |

The GB population is the same shape — the parent sits in the post-town position, left of a postcode.
`brooklyn, new york, ny` is the tail case: a bare three-segment query, no postcode, and a parent whose
surface is a state name. The trailing `ny` pushes the parent AWAY from locality at the exact moment
the pair prior assumes it landed there.

## Two fixes, different philosophies

1. **Gate the child bias on the parent's reading.** Thread the emissions into
   `buildPlacetypePairPriors` and skip the hit when the parent window's argmax is not in the
   locality family. Restriction-only: byte-identical wherever the assumption already holds, which is
   every pre-registered case above. Leaves `brooklyn, new york, ny` at the pre-prior tree
   (`locality=Brooklyn`), which grades at 0 km — correct, but it does not recover `New York` as the
   locality.
2. **Bias the parent toward locality too, when a pair fires.** The pair index asserts a
   (child, parent) admin relation; asserting only half of it is what produces the zero-locality tree.
   Reaches the R5-intended shape (`dep_loc=Brooklyn, locality=New York`) rather than merely avoiding
   the bad one. Larger surface: it can now move a span the model was confident about, so it needs its
   own δ and its own confound board — a region genuinely named the same as a city ("New York",
   "Washington", "Québec") is the confound class, and it is not small.

Both are default-on changes on a tier-1 locale, so either needs the full gauntlet plus the GB/NZ pair
boards to show byte-stability where the assumption holds, per the D-rule.

## Reproduce

```bash
node scripts/scratchpad/tag-margins.ts    # per-piece raw argmax + margins
node scripts/scratchpad/prior-trace.ts    # which prior fired, and the post-prior labels
```
