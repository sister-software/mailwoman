---
sidebar_position: 32
title: Negative space — why training every component sharpens each one
tags:
  - concepts
  - corpus
  - training
---

# Negative space — why training every component sharpens each one

A useful intuition guides Mailwoman's corpus-coverage work: as we add training
signal for the address components we've been *missing* (`unit`, `country`, the
street affixes), the model gets better at the components we already handle — not
just the new ones. The reason is that a sequence labeller learns a tag by its
**boundaries**, so teaching it what a token *isn't* is how it learns what the
neighbours *are*.

This has names at three altitudes:

- **Philosophy** calls it *via negativa* — defining a thing by what it is not.
- **Art** calls it **negative space** — you draw the vase by drawing the gap.
- **Linguistics** is Saussure's whole thesis: a sign has no meaning in isolation,
  only *value through difference*. "Street" means street partly because it isn't
  "unit" or "locality."
- **Machine learning** calls it **discriminative learning** — the model fits the
  *decision boundary* between classes, not a description of each class in isolation.

## The catch-all failure it cures

The softmax at each token position is a competition: every tag's probability is
normalised against all the others, and the mass has to land *somewhere*. When a
real category has no training signal, the model never learns a detector for it —
so tokens that genuinely belong to that category get dumped into the nearest tag
it *did* learn. That tag becomes a **catch-all** (or "dumping-ground") label.

This is not hypothetical for us. The v0-parity assessment caught it directly:

- `123 Main St Apt 456 Oakland CA` → the model tags `Apt 456` as **street**,
  because `unit` was never a class it could reach for.
- `1 Main St Pittsburg PA` → **street** absorbs the city, because the model has
  never been shown a clean example of what legitimately comes *after* a street, so
  it doesn't know where `street` ends.

`street` is acting as a garbage collector for everything on the road line. The
moment `unit` becomes a trained category, those tokens have a home: their
probability mass moves off `street` and onto `unit`, and `street` gets sharper as
a *side effect* — we improved a tag by teaching its neighbours.

## The honest caveat

This is usually net-positive but not guaranteed monotonic. Adding a class is free
when it's a genuine category the old label was wrongly swallowing (our case). It
can backfire when two categories are genuinely ambiguous (you trade one confusion
for another), or through capacity and label-noise effects — Mailwoman has scar
tissue here, where adding a locale *interfered* with an existing one on some
retrains. So negative space is a strong **hypothesis**, not a theorem.

Which is exactly why coverage work is gated on **measurability first**. Before
generating corpus rows for a starved tag, the eval set must carry enough held-out
examples of it that its F1 is real signal, not noise from a handful of rows (see
[eval discipline](./eval-discipline.md) and the val-set stratification work). The
coverage eval is the apparatus that lets the numbers say whether negative space
held for our model — whether covering `unit`/`country` lifted `street`/`locality`
precision, and whether anything regressed — rather than assuming it.
