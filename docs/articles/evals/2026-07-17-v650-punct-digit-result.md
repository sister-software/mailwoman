# 2026-07-17 — v6.5.0 (v381): the comma-free rooftop fix (#1101) + digit ownership, the first Gauntlet-clean model

v6.5.0 ships `v3.8.1-punct-fix-full` (v381): a fine-tune off v310 (the shipped 6.4.0) with two folded
changes, both one variable at a time on top of the prior recipe — the no-fragment digit-ownership shard
and the `augment_punct_drop_prob` delimiter-free augmentation (#1101). Tokenizer (`v0.9.0-multisplice`,
73,143), every lexicon, the FST, and the architecture are unchanged. It is the first model to pass the
full Gauntlet clean: shipped 6.4.0 fails it.

## What the Gauntlet caught

On the way to shipping the digit-ownership model, the pre-ship Gauntlet's metamorphic layer flagged a
`comma-drop` invariant break that per-tag F1 and the parity boards never surface — it grades the
assembled coordinate, not labels:

```
INV[comma-drop]  "1600 Pennsylvania Ave NW, Washington DC"
              →  "1600 Pennsylvania Ave NW Washington DC"
   tier address_point→admin, coord 38.8977,-77.0365 → 38.9048,-77.0163
```

Dropping the comma moved the result ~2 km — from the rooftop to the DC admin centroid. The model absorbed
`Washington` into the street span (`street="Pennsylvania Ave NW Washington"`, no locality), so the
address-point lookup missed and the result fell back a tier. This is **pre-existing** — shipped 6.4.0
fails it byte-identically; v310 and the digit-ownership model parse it the same way. Whitespace-only
(comma-free) input is 64% of the parity gold, so this is a common shape, not an edge case.

## The fix

The fix was already built and tested but never enabled in the shipped recipe: `augment_punct_drop_prob`
(`corpus-python/src/mailwoman_train/augment.py`, 8 unit tests) emits an extra comma-stripped copy of each
row with the entity spans re-targeted, so the model learns to segment street from locality without leaning
on the comma. Enabling it at 0.3 closes the case:

```
"1600 Pennsylvania Ave NW Washington DC"  (no comma)
   6.4.0:  street="Pennsylvania Ave NW Washington"   (locality absorbed)
   6.5.0:  street="Pennsylvania Ave NW"  locality="Washington"   (identical to the comma form)
```

The Gauntlet's `INV[comma-drop]` goes 8/10 → 9/10 held, and the White House holds on merit (graded against
the original xfail list). Regression, metamorphic, and held-out all pass: **VERDICT: PASS — clear to ship.**

## Digit ownership

The second change is the `synth-no-fragment` shard at its all-length long-number boost — the corpus lever
that teaches the street/number boundary, so a bare `Nordtømmesvegen 178` reads `house_number 178` rather
than a postcode. On the Norwegian digit board, `bare-street-hn` moves 0.693 → 0.733 (+4pp), the `bare-pc`
negative guard holds at 1.000, and the contextful classes hold. The gain is a clean net-positive, not a
trade — the tokenizer-level alternative (a number-piece vocab splice) cleared more on-board but failed the
golden gate on five tags, so it was not shipped.

## The gates

- **Golden gate** (`v6.0.0-shipped-baseline`, package-shaped `--weights-cache`, int8 candidate vs int8
  shipped): PASS. Zero tags regress more than 2 pp below shipped; the only >2 pp mover is
  `us.country_homograph_f1` **+2.3**. `fr.house_number` and the postcode tags hold.
- **Gauntlet**: PASS — the first green run. 6.4.0 fails the same metamorphic comma-drop invariant.

## Known open

The **French** comma-free case (`181 Rue du Chevaleret Paris`) is not fixed and stays a tracked #1101
xfail. It is not French-specific and not a resolver gap: it is the **no-anchor bare-terminal-locality**
case — a locality that is the last token with no trailing state or postcode to anchor it. A trailing state
(`Washington DC`) or a postcode before the locality (`75013 Paris`) anchors the segmentation and resolves
correctly; a bare terminal toponym is genuinely ambiguous against a street continuation, and the punct-drop
augmentation does not disambiguate it. Closing it needs a locality name-index
([#30](https://github.com/sister-software/mailwoman/issues/30)) or a targeted no-anchor augmentation,
tracked separately. It is low-frequency — nearly all real geocoding traffic carries a postcode or region.
