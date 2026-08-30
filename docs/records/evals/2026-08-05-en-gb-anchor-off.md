# en-GB ships anchor-off — the interim mitigation (2026-08-05)

**Issue:** #1467 · **Status:** shipped as an interim mitigation; the retrain that would undo it has its
prescription filed separately.

`@mailwoman/neural-weights-en-gb` no longer ships `postcode-gb.bin`. The postcode-anchor channel now
resolves OFF for `en-gb` loads, the same posture `@mailwoman/neural-weights-en-nz` has always had. The
placetype-pair prior (`pair-index-gb.bin`) is untouched, and so is every other locale.

This page is the receipt. The diagnosis it implements is elsewhere; what follows is the measurement
taken against the change as it actually landed.

## Why

The shared encoder's anchor input reserves one slot per country —
`LOCALE_ORDER = [US, FR, DE, CA, GB, JP, ES, IT, NL]` in `neural/anchor-inference.ts`. GB is slot 4, and
slot 4 never received a training gradient.

Every recipe under `corpus-python/src/mailwoman_train/configs/` sets the same `anchor_lookup_path`:

```
$ grep -rh anchor_lookup_path corpus-python/src/mailwoman_train/configs/ | sort -u
  anchor_lookup_path: /data/anchor/pilot-anchor-lookup.json
```

One distinct value across every config in the tree. That file holds 67,708 keys, **zero** of them
letter-bearing, and its country posteriors name exactly three countries: US (42,312 keys), DE (29,694),
FR (27,119). A GB outward code is letter-bearing by construction, so no training example ever put a
non-zero value in slot 4.

`postcode-gb.bin` is the only artifact that does — and it is not a rare event. Replaying
`buildAnchorFeatures`'s own recognizer (alphanumeric run → `lookup.get(UPPER)`) over the golden board:

```
locale en-gb · anchorLookupPath neural-weights-en-gb/postcode-gb.bin
anchor lookup keys: 2951
anchor fired on 106/120 rows
```

106 of 120 is every row on that board carrying a postcode. Shipping the binary pushed essentially every
GB parse along an input direction the encoder has no learned response to.

The general rule this inverts is worth stating, because the overlay's own README used to state the other
half of it: zeroing a **trained** channel is out-of-distribution, which is why `createScorer` fails
closed. The GB slot was never trained, so there is no distribution to leave. Zero is what the encoder
saw for every GB example it has ever been shown; a value is the out-of-distribution case.

## The boards

Model `model-v401-base-step-060000-int8.onnx`; `pair-index-gb.bin` 30,825 pairs, δ=10, β=5,
parentDelta=5. Production runtime pipeline (`createRuntimePipeline` with the classifier only — what
`mailwoman parse` builds with no `--resolve` and no `MAILWOMAN_WOF_DB`), locale `en-gb`. Three registers
per row: as-written, lowercase, UPPERCASE. Grading is exact match on the tag's concatenated span, folded
to uppercase with whitespace stripped.

`mailwoman/eval-harness/fixtures/gb-golden.jsonl`, 120 rows — 106 carry a postcode, 69 carry a
`dependent_locality`.

| board                                   |   n | anchor ON (before) | anchor OFF (shipped) |
| --------------------------------------- | --: | -----------------: | -------------------: |
| exact `postcode`, 3 registers           | 318 |            294/318 |          **318/318** |
| exact `dependent_locality`, 3 registers | 207 |            207/207 |          **207/207** |
| the same, comma-STRIPPED                | 207 |            201/207 |              198/207 |

Per register, anchor OFF: postcode 106/106 · 106/106 · 106/106; `dependent_locality` 69/69 · 69/69 ·
69/69. The postcode gain is uniform across registers — it is not a casing artifact.

**The comma-stripped row is the cost, and it is one row.** `Goulbourne Road St Georges Telford TF2 9LE`
loses `St Georges` to a clipped `St`, in all three registers; the other two misses (`Sonning Common`,
`Woodlesford`) miss in both arms. Twenty-four exact postcodes for one comma-free dependent locality is
the trade, taken deliberately. It is also the one number that contradicts the 2026-07-24 re-anchor note
in the country-evidence runbook, which recorded the GB anchors helping comma-free recall (50→55 emit);
that note was right, and this change gives some of that back. The correction is now in the runbook.

## Everything else

**US, byte-stable.** The 100 US rows of `parity-corpus.jsonl` × 3 registers, full span serialization
hashed:

```
before  sha256: c79ba30359e4c80c71858e0b2db2120703b9de16afd426688908009adae5e5fd  (300 parses)
after   sha256: c79ba30359e4c80c71858e0b2db2120703b9de16afd426688908009adae5e5fd  (300 parses)
```

**`postcode-us.bin` still resolves and still fires**, which is the assertion that keeps the byte-stability
above from being vacuous:

```
locale en-us · anchorLookupPath neural-weights-en-us/postcode-us.bin
anchor lookup keys: 42317
anchor fired on 20/100 rows
```

Removing it moves the hash (`8505fdee…` over the same 300 parses), so the channel is required for
`en-us` and this change did not touch it.

**FR, byte-stable too.** Same instrument, the 46 FR rows × 3 registers, graded with `postcode-gb.bin`
present and then absent — the direct test of whether the en-gb edit leaks sideways:

```
anchor ON   sha256: fe71facf1908d2dec3ff8a8439ac5e5d120f1b072d8b9a52e542e09f7b30efb7  (138 parses)
anchor OFF  sha256: fe71facf1908d2dec3ff8a8439ac5e5d120f1b072d8b9a52e542e09f7b30efb7  (138 parses)
```

`fr-fr` resolves its own `postcode-fr.bin` in both. Nothing at runtime reads `release.config.json`, so
the `postcodeDBByCountry` edit is release-time only.

## Gauntlet

Standard gate, no flags, both arms on the same worktree with only `postcode-gb.bin` differing.

Before (anchor ON):

```
=== Gauntlet · regression (62/70 gated cases pass, 66 tracked) ===
verdict: FAIL
=== Gauntlet · metamorphic ===
  INV  (label-preserving, ≤1m):  63/63 held, 0 known-xfail
  DIR  (drop-postcode, ≤5km):    3/3 held
  BAND (corrupting, ≤5km):       18/21 held, 3 known-xfail
verdict: PASS (with 3 tracked xfails)
VERDICT: FAIL — do not ship
```

After (anchor OFF, shipped):

```
=== Gauntlet · regression (62/70 gated cases pass, 64 tracked) ===
verdict: FAIL
=== Gauntlet · metamorphic ===
  INV  (label-preserving, ≤1m):  63/63 held, 0 known-xfail
  DIR  (drop-postcode, ≤5km):    3/3 held
  BAND (corrupting, ≤5km):       18/21 held, 3 known-xfail
verdict: PASS (with 3 tracked xfails)
VERDICT: FAIL — do not ship
```

**Gated: 62/70 in both arms, and the eight failures are the same eight rows verbatim** (`si-sentinel-apace`,
`de-r9-nippes-koeln`, `in-r10-indiranagar-bengaluru`, `es-r11-aravaca-madrid`, `it-r11-trastevere-roma`,
`us-subvenue-googleplex-building`, `fr-rivoli-us-scoped`, `de-linden-us-scoped`). None is GB. The overall
FAIL predates this work and is unchanged by it. Zero newly-failing gated cases.

The tracked (`improvement_target`, non-blocking) population moves 66 → 64: `gb-venue-north-face-covent`
and `gb-op2-via-emilia` now pass outright. Within the rows that still fail, most GB entries lose their
`postcode "null" ≠ …` mismatch — the same recovery the golden board measures. Three get worse in other
fields (`gb-op2-24n-fitness`, `gb-subvenue-st-thomas-wing`, `gb-op2-east-west-kingsland`) and two get
better (`gb-op2-bar-with-shapes`, `gb-op2-china-red`); all five were already failing in both arms. The
metamorphic layer is byte-identical.

## What holds the line

Re-adding the binary is silent — nothing errors, GB just gets worse — so the guards are assertions
rather than documentation:

- `neural/test/weights.test.ts` pins `resolveWeights({locale: "en-gb"}).anchorLookupPath` **undefined**,
  and separately pins that the package's `files` array names no `postcode-*` entry. The two can
  disagree (a tarball ships `files`; a dev worktree resolves the directory), so both are asserted.
- `neural-weights-en-gb/scripts/link-dev-weights.ts` deletes any `postcode-gb.bin` it finds, loudly. A
  checkout predating this change would otherwise keep one around and quietly grade against it.
- `release.config.json`'s `softFeed.postcodeDBByCountry` has no `gb` key, so `copy-weights.ts` skips it
  at release time; the publish workflow no longer fetches `postcode-gb.bin` from the bucket.

The artifact stays buildable. `$MAILWOMAN_DATA_ROOT/wof/postalcode-gb.db` is untouched and
`mailwoman gazetteer postcode-binary --out neural-weights-en-gb --locale GB:<shard>` still produces the
binary in seconds — the retrain needs it.
