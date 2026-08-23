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

## The cause, stated once

**Adding non-US/FR admin tails to this model regresses FR/GB/IE venue parsing, and neither
composition nor dose removes it.** Five runs: three admin-only shards at three doses, one dose cut on
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
`packages/corpus/src/synthesizers/house-venue.ts`.

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
