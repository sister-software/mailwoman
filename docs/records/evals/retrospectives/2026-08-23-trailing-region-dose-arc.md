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
| v4.10.0 | v4.9.0 shard, 1 rep   | 31,815 |  3.1% | see below                      |

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

## The cause, stated once

**A shard containing only admin segments cannot be dosed at ~9% of the stream without damaging
whichever class occupies the position it teaches — because it cannot teach the alternatives.** Three
shapes demonstrated it. Moving the taught position moved the damage; it did not remove it.

## What this does and does not license

- **It does not license a dose sweep as a general remedy.** v4.10.0 tests dose as the one variable
  those three runs held constant, on a byte-identical shard. If regressions persist at a third the
  exposure, dose is not the lever.
- **It does license the corpus-authoring task**: this shard needs rows where a venue or a street
  precedes the locality before it can carry a meaningful dose. That is authoring, not tuning.
- **VE remains unmoved and unmovable from here.** GeoNames does not publish Venezuela and nothing on
  disk carries a VE postcode. IN's `after_region` rows were the proxy and they did not generalize to
  VE's `after_locality` in any of the three runs.

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
