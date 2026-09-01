# The trailing-region arc: three shard shapes, three failures, one measured cause

**2026-08-23.** Closing out #1748 / #1821. Nothing from this arc shipped, and the reason is worth more
than the model would have been.

## What we were trying to fix

Four Venezuelan board rows (`ve_city_postcode_trailing_state`) land 559–573 km off:

```
Heladería Frappé Manía, Avenida Country Club, Barcelona 6001, Anzoátegui, Venezuela
  → house_number 6001 · street "Avenida Country Club, Barcelona" · locality "Anzoátegui"   573 km
```

`Barcelona 6001` reads as `«street» «house_number»`, so the true locality is swallowed by the street
and the STATE is promoted to locality.

The cause is position, and it is reproducible outside VE. Moving the same digits one slot flips the tag:

| Input                                     | postcode tag     | locality          |
| ----------------------------------------- | ---------------- | ----------------- |
| `… Barcelona 6001, Anzoátegui, Venezuela` | ✗ `house_number` | ✗ `Anzoátegui`    |
| `… 6001 Barcelona, Anzoátegui, Venezuela` | ✓ `postcode`     | ✓ **`Barcelona`** |
| `Sandton 2196, Gauteng, South Africa`     | ✗ `house_number` | ✗ `Gauteng`       |
| `2196 Sandton, Gauteng, South Africa`     | ✓ `postcode`     | ✗ `Gauteng`       |

`postcodeShapeCoherence: true` leaves all eight VE rows **byte-identical**, so no decode-time lever
touches it. Corpus lane, confirmed before spending a GPU.

Cause found: `trailing-region.ts` built every one of its 17,908 structured rows postcode-LEADING
(`const head = … ${postcode} `). Correct for its four source countries — FR, DE, ES, IT all write the
code first — and it silently decided which countries the shard could teach.

## The three runs

All fine-tunes off the v4.4.0 base (60k steps), 8,000 steps, EWC λ=1e4, A100-40GB, ~30 min each.

| run     | shard                 |   rows | share | board verdict                  |
| ------- | --------------------- | -----: | ----: | ------------------------------ |
| v4.7.0  | leading only          | 17,908 | 10.5% | DO-NOT-SHIP, 370/383           |
| v4.8.0  | + `after_region` (IN) | 32,125 |  9.4% | **7 improved / 25 regressed**  |
| v4.9.0  | + dependent locality  | 31,815 |  9.4% | **11 improved / 31 regressed** |
| v4.10.0 | v4.9.0 shard, 1 rep   | 31,815 |  3.1% | **9 improved / 22 regressed**  |
| v4.11.0 | house-venue INTL      | 18,000 |   n/a | **5 improved / 18 regressed**  |

### v4.8.0 — the shard taught "the first named segment is the locality"

Eleven of the twenty-five regressions were venue-led rows, across seven countries:

```
Ye Three Lords, 27 Minories, London EC3N 1DE
  shipped   venue "Ye Three Lords" · locality London · street Minories
  candidate locality "Ye Three Lords"              ← venue AND street gone

Le Colimaçon, 44 Rue Vieille du Temple, 75004 Paris, France
  shipped   venue "Le Colimaçon" · locality Paris
  candidate locality "Le Colimaçon"
```

Every row in that shard began with the locality — `01445 Radebeul, Saxony` and `Sawai, Andaman &
Nicobar Islands 744301` alike — and it contained no venue, no street, no dependent locality. Even the
IN row it targeted regressed, `locality` sliding from `Bengaluru` to `Indiranagar`.

The house-number prefix on every fourth row is **not** a counter-distribution. A NUMBER before the
locality does not teach that a NAME can precede one. `no-fragment.ts`'s header records the same trap
from the other side; it was quoted in v4.8.0's own config header while both of that shard's arms
shared the defect.

### v4.9.0 — a real data fix, a worse board

Underneath v4.8.0 was a plain data error. **GeoNames column 3 is not the city.** It is the
finest-grained named place for the code:

|             | column 3 (`place`)                   | column 5 (`admin2`) | column 4 (`admin1`) |
| ----------- | ------------------------------------ | ------------------- | ------------------- |
| IN 560001   | **`Mahatma Gandhi Road`** — a STREET | `Bengaluru`         | `Karnataka`         |
| MX 06700    | `Roma Norte` — a colonia             | `Cuauhtémoc`        | `Distrito Federal`  |
| PT 2580-001 | `Abrigada`                           | `Alenquer`          | `Lisboa`            |

v4.8.0 therefore trained street names and colonias **as cities**. v4.9.0 maps `admin2`→locality,
`admin1`→region, column 3→`dependent_locality` — correct labels, and it supplies the missing left
context: 62% of rows now carry a name before the locality, against 0%.

It worked on its target: **IN went 2 improved / 0 regressed.** The board still got worse, and how it
got worse is the finding. Venue regressions went **12 → 15**, and a new class appeared:

```
bare_street_boundary ×7   Calle de Alcalá · Corso Vittorio Emanuele II · Madison Square West
```

Adding a dependent locality moved the "first named segment" binding from `locality` to
`dependent_locality`. Bare street names started reading as dependent localities, and venues did not
recover.

### v4.10.0 — dose is a lever, not a fix

Same shard as v4.9.0, byte-identical, at a third the exposure. One variable.

| run         |    share | improved | regressed |     net | venue-led regressions |
| ----------- | -------: | -------: | --------: | ------: | --------------------: |
| v4.8.0      |     9.4% |        7 |        25 |     −18 |                    12 |
| v4.9.0      |     9.4% |       11 |        31 |     −20 |                    15 |
| **v4.10.0** | **3.1%** |        9 |        22 | **−13** |                     9 |

The damage scales with dose and does not vanish with it. A 3× cut bought back 7 net rows and 6 venue
rows, and the arm is still net −13, still FR −3 / GB −5 / IE −3. Regressions fall sub-linearly (25 → 22
for a 3× cut) because what remains is not over-exposure — it is that the shard's signal is wrong for
the classes it does not contain, at any exposure that teaches anything.

**All four runs are DO-NOT-SHIP. Nothing was promoted or published.**

### v4.11.0 — the composition hypothesis, tested and eliminated

The conclusion below was that an admin-only shard damages the classes it does not contain. v4.11.0
tested it directly by putting the same surface into rows that DO contain them.

`house-venue` was already emitting the target tail — `Springfield, IL 02101` and `Bengaluru,
Karnataka 560038` are the same locality-region-postcode shape — and every row it emits carries a
venue, a street AND a house number. 18,000 IN/PT/MX rows with real
postcodes were emitted under the EXISTING `synth-house-venue` source, so they took a share of a bucket
that has shipped at weight 2.0 rather than claiming a new dose. Measured on the shard: venue 100%,
street 100%, house_number 100%.

    Bob's Pizza, 9 Lake Dr, Srikakulam, Andhra Pradesh 532001
    8457 Maple Blvd, Brasserie du Marché, Aguascalientes, Aguascalientes 20000

**5 improved / 18 regressed, net −13. FR −3, GB −5, IE −3. Nine venue-led regressions.**

No new source, no new dose, the alternatives present in every row — and the same countries lost the
same classes. So the cause is NOT the shard's internal composition, and it is not exposure:

| run         | new source? | own dose? | venue/street present? |     net | venue-led |
| ----------- | ----------- | --------- | --------------------- | ------: | --------: |
| v4.8.0      | yes         | 9.4%      | no                    |     −18 |        12 |
| v4.9.0      | yes         | 9.4%      | no                    |     −20 |        15 |
| v4.10.0     | yes         | 3.1%      | no                    |     −13 |         9 |
| **v4.11.0** | **no**      | **no**    | **yes**               | **−13** |     **9** |

What every run shares is the DATA: non-US/FR admin tails entering a model whose tail expectations were
set by US and FR. Adding them shifts those expectations for the countries it already knows, and FR/GB/
IE venue rows are where that shows. Composition and dose modulate the size of the shift; neither
removes it.

### v4.12.0 — the brake is not the lever either, and a FLOOR appears

One variable against v4.11.0: `ewc_lambda` 1e4 -> 1e5. Same corpus, source, weight, steps, seed.

**7 improved / 19 regressed, net -12. Venue-led still 9. FR -3, GB -5, IE -3.** A ten-fold stronger
brake moved the net by one row and the venue class by none.

| run     | lever changed                                  | net | venue-led |
| ------- | ---------------------------------------------- | --: | --------: |
| v4.8.0  | admin shard @ 9.4%                             | -18 |        12 |
| v4.9.0  | + dependent locality                           | -20 |        15 |
| v4.10.0 | dose -> 3.1%                                   | -13 |     **9** |
| v4.11.0 | venue-bearing rows, no new source, no new dose | -13 |     **9** |
| v4.12.0 | EWC brake x10                                  | -12 |     **9** |

Three unrelated levers — exposure, composition, regularization — reach the same floor with the SAME
NINE venue-led rows. A floor that three independent levers cannot move is not a property of any of
them.

### The control, RUN — and it splits the ledger

**v4.13.0: the v0.22.0 base corpus, no added shard, same 4,000 steps, same seed, same brake.**

    5 improved / 10 regressed, net -5. Five of the ten venue-led.

A plain fine-tune of this base costs ten rows before any new data is involved. And every one of those
ten also appears in v4.11.0's eighteen and v4.12.0's nineteen, so the cost separates exactly:

| run          | regressed | fine-tune tax | attributable to the DATA |
| ------------ | --------: | ------------: | -----------------------: |
| v4.13.0 null |        10 |            10 |                        — |
| v4.11.0      |        18 |            10 |                    **8** |
| v4.12.0      |        19 |            10 |                    **9** |

Both readings matter and neither was available before:

1. **The arc over-attributed.** A third of every "regression" charged to these shards was the price of
   fine-tuning at all. Five runs of shard-blame were measuring a mixture.
2. **The arc was not wrong.** Eight to nine rows ARE the data's doing, and they are the right ones —
   `gb-venue-ye-three-lords`, `gb-lex-cafe-st-marys`, `gb-op2-four-seasons-cjk` appear only in the
   treated arms. The venue diagnosis holds for that subset.

**The floor of nine venue-led regressions was a mixture too**: five are the tax, four are the data.
That is why exposure, composition and the brake could not move it — three of those levers act only on
the four.

### What this changes for anything shipped from here

The baseline for grading a candidate is the NULL RUN, not the shipped model. A candidate that costs
ten rows has cost nothing; one that costs eighteen has cost eight. Every gate in this arc used the
wrong denominator.

It also sets a floor on what a fine-tune can deliver: **it must buy back five net rows before it breaks
even**, because that is what 4,000 steps against this base costs on its own. None of the six came
close, and no shard-side change can, since the tax is charged before the shard is read.

That is the real argument for a from-scratch base over a fine-tune, and it is now a measured one
rather than a preference.

### The control as originally specified (kept — the reasoning stands)

If the same nine rows regress under every intervention, the next question is whether they regress
under NO intervention: **fine-tune the base corpus with no added shard at all, same steps, same seed.**

- If those nine still move, the arc's entire premise is wrong. The regressions are an artifact of
  fine-tuning this base for 4,000 steps, not of the data, and every conclusion above about shards is
  measuring the wrong thing.
- If they hold, the data is implicated after all and the floor is a real interaction.

It is one 4,000-step run, ~13 minutes and ~$1. **Run it before any further shard work.** Nothing in
this arc should be trusted until it is answered, including the sections above.

### v4.14.0 — steps is not the lever, and the tax is IMMEDIATE

The null control suggested the last untested variable: if 4,000 steps costs ten rows, fewer steps
should cost fewer. One variable against v4.11.0, `max_steps` 4000 -> 1000.

**4 improved / 10 regressed, net -6.**

Regressions fell 18 -> 10. But ten IS the null's tax, so the shard now costs nothing beyond it — and
buys nothing either, the improvements falling 5 -> 4. `gb-venue-ye-three-lords` holds at this
distance; `gb-lex-cafe-st-marys` and `gb-op2-four-seasons-cjk` do not.

The finding is in the shape of the tax, not the net. **It is paid in the first 1,000 steps and barely
grows to 4,000** — 10 rows at both. It is not proportional to how far the weights travel; it is a
fixed cost of touching this base at all. No shorter run avoids it.

### The fine-tune route is closed, on measurement

Eight runs. Every lever that exists for an additive fine-tune, each isolated:

| run         | lever                                | net vs shipped | regressed |
| ----------- | ------------------------------------ | -------------: | --------: |
| v4.8.0      | admin shard @ 9.4%                   |            -18 |        25 |
| v4.9.0      | + dependent locality                 |            -20 |        31 |
| v4.10.0     | dose -> 3.1%                         |            -13 |        22 |
| v4.11.0     | venue-bearing, no new source or dose |            -13 |        18 |
| v4.12.0     | EWC brake x10                        |            -12 |        19 |
| v4.14.0     | steps -> 1,000                       |             -6 |        10 |
| **v4.13.0** | **NULL — no added data at all**      |         **-5** |    **10** |

The null is the best of them. Every arm that adds data is worse than adding none, and the arm that adds
data most cautiously converges on the null rather than beating it.

**No fine-tune of this base can ship an additive surface.** The tax is fixed, immediate, and larger
than anything an additive shard has been able to buy back. That is not a judgement about these shards;
it is a property of the starting point, and it holds across exposure, composition, regularization and
distance.

The next attempt is a from-scratch base that sees every tail convention at once, so the surface is
learned rather than grafted. That is a different order of commitment and should be scoped as one.

## The cause, stated once

**PROVISIONAL, pending the null-run control described above.** Adding non-US/FR admin tails to this
model regresses FR/GB/IE venue parsing, and neither composition, dose, nor the EWC brake removes it. Five runs: three admin-only shards at three doses, one dose cut on
a byte-identical shard, and one that carried venue+street+house_number in every row inside an
already-shipping bucket. All five net-negative, all five losing the same classes in the same
countries. Composition and dose modulate the size of the shift; the shift itself tracks the data.

That points past the corpus at the model: a 39.3M-param encoder fine-tuned with an EWC brake against a
US/FR base may not have capacity to hold a new tail convention without moving an old one. The next
experiment is therefore NOT another shard — it is the same data against a different training shape
(no EWC brake, or a longer run, or a from-scratch base that sees all the tails at once). That is a
larger commitment than a fine-tune and should be scoped as one.

## What this does and does not license

- **Dose is not the remedy, and that is now measured rather than argued.** v4.10.0 held the shard
  byte-identical and cut exposure 3×; net went −20 → −13 and stopped there. Extrapolating the observed
  sub-linear fall, the dose that stops hurting is below the dose that teaches.
- **It does license the corpus-authoring task**: this shard needs rows where a venue or a street
  precedes the locality before it can carry a meaningful dose. That is authoring, not tuning.
- **VE remains unmoved and unmovable from here.** GeoNames does not publish Venezuela and nothing on
  disk carries a VE postcode. IN's `after_region` rows were the proxy and they did not generalize to
  VE's `after_locality` in any of the three runs.

## The VE data question, closed

"Get the data we're missing" deserves a definite answer for the country this arc was about. Every open
source this project consumes was checked on 2026-08-23:

| source                                                                               | VE postcodes                                       |
| ------------------------------------------------------------------------------------ | -------------------------------------------------- |
| WOF — every `postalcode-*.db` shard in the data root                                 | none                                               |
| GeoNames postal (`download.geonames.org/export/zip/VE.zip`)                          | **HTTP 404** — not published                       |
| OpenAddresses (`results.openaddresses.io/latest/run/ve/{countrywide,statewide}.zip`) | **HTTP 404**                                       |
| Overture, local snapshot                                                             | `places` theme only; no addresses theme downloaded |

So VE postcodes are not an acquisition someone forgot to run. They are absent from the open corpus this
project is built on. The one avenue NOT checked is Overture's upstream `addresses` theme, which is not
mirrored locally — worth one query before concluding it is unobtainable, not worth assuming it helps.

That makes the VE question a product decision rather than a data-fetching task: either a synthetic
4-digit code paired with a REAL (locality, region) pair from the WOF admin DB, or VE stays unfixed. The
`house-venue` synthesizer now carries VE's tail ordering, so the shape has a home either way — see
`packages/corpus/lib/synthesizers/house-venue.ts`.

## The control that licenses all of the above

Every comparison in this arc reported `p = 0.86-1.00` — statistically indistinguishable at n = 649.
Ten rows of 649 moving is exactly the size of thing that could be int8 quantization jitter near a
decision boundary rather than learning damage, and if it were, every number here would be measuring
the instrument.

So the shipped model was staged through the identical candidate path — same directory shape, same
dereferenced lexicons, same loader — and graded against itself.

    0 of 649 inputs differed. supportsAbsenceClaim: true, upper bound 0.5%.

Identical bytes give identical results, exactly. The harness is deterministic and the staging path
adds nothing. **Every regression reported in this document is real.**

Worth keeping as a habit rather than a one-off: a self-comparison costs one board run and is the only
thing that separates "the candidate is worse" from "my rig is noisy". It should precede the first
candidate of any arc, not follow the eighth.

## Method notes worth keeping

- **Grade the board, not the val loss.** All three runs reported `macro_f1` between 0.9203 and 0.9212
  and `cross_pollution=0.00%`. Every one of them was a do-not-ship. The val split cannot see the venue
  class the board is built to see.
- **A smoke run proves the config loads, not that the shard is reached.** The mixed shard's leading
  arm keeps the zero-rows guard from firing even when the whole trailing arm is dropped. The check
  that mattered was reading the shard through the loader's own gate before launching.
- **A false negative in the measuring tool looks exactly like a real absence.** Corpus `labels` is a
  nested Arrow column (`{list:[{element:…}]}`); `Array.isArray` on it is false, so a street-label
  count silently returns zero for every country. It produced a confident wrong claim that GB has no
  street data. `mailwoman data coverage` unwraps it, and its test pins the behaviour.
