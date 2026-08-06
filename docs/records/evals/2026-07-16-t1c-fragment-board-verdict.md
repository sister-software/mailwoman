# T1c — the FR fragment board: the house number is a licence, not a hint

**Deliverable (2026-07-16 review, Tier 1c):** replace the n=63 Paris anecdote with a BAN-sampled board
carrying confidence intervals per phenomenon class, and make it the grading set for the T2 shard.

**Built, and its first read reframes the arc.** With a house number the shipped model scores **92.5%**;
without one, **21.5%** on the same streets. The gap is not a difficulty gradient. The model has learned
that **a house number licenses a street reading at all** — remove it and a designator-led phrase parses
as a _locality, designator included_.

|         |                                                                         |
| ------- | ----------------------------------------------------------------------- |
| Board   | `mailwoman eval fragment-board` (`eval-harness/fragment-board.ts`)      |
| Fixture | `fixtures/ban-fragments-fr.jsonl` — 2,800 rows, 7 classes, BAN (Tier A) |
| Builder | `scratchpad/build-ban-fragment-board.py` (seeded, deterministic)        |
| Model   | v264 (v6.3.0, shipped), production config                               |

---

## 1. The board

| class                             |    n |      rate | 95% Wilson     |
| --------------------------------- | ---: | --------: | -------------- |
| street-housenumber                |  400 | **0.925** | [0.895, 0.947] |
| alnum-housenumber                 |  400 | **0.925** | [0.895, 0.947] |
| bare-street                       |  400 | **0.215** | [0.178, 0.258] |
| street-particle                   |  400 | **0.273** | [0.231, 0.318] |
| admin-street-homonym              |  400 | **0.087** | [0.064, 0.119] |
| date-name                         |  400 | **0.055** | [0.037, 0.082] |
| bare-locality _(emits no street)_ |  400 | **0.980** | [0.961, 0.990] |
| **OVERALL**                       | 2800 |     0.494 | [0.476, 0.513] |

Nothing here needs squinting at: the numbered classes and the bare classes are separated by ~70pp with
intervals nowhere near touching. Contrast the Paris board's 3/15 cell, whose interval is [0.07, 0.45] —
this is the difference between a measurement and an anecdote with a decimal point.

## 2. What the model actually says

The rates undersell it. The parses:

```
"Rue Montmartre"          -> locality="Rue Montmartre"
"Allee Poque"             -> locality="Allee Poque"
"Allee Bienville"         -> locality="Allee Bienville"
"Allee Capitaine Moret"   -> locality="Allee Capitaine"   region="Moret"
```

**The designator is swallowed into the locality.** `Rue` is the most deterministic street signal in
French — it can only mean street — and without a house number it is absorbed into a locality span. The
arc's §2 framing ("the prior on bare toponyms is wrong") is confirmed and is understated: the model is
not mislabelling an ambiguous toponym, it is mislabelling `Rue`.

And the date-name class, which is the tell:

```
"Allee du 11 Novembre"       -> street="Allee du"  house_number="11"  street="Novembre"
"Allee du 11 Septembre 1944" -> street="Allee du Septembre"           (11 and 1944 deleted)
"Allee du 8 Mai"             -> locality="Allee"   street="du"        house_number="8 Mai"
"Allee de l'An 2000"         -> "l"
```

Here the model **does** emit street — because a digit is present. It then **steals the digit as a house
number** and fragments the street around the hole. 5.5% correct, the worst class on the board.

## 3. One mechanism explains every cell

> **The house number is not a hint. It is the licence.** The model has learned "digits ⇒ this is a
> street address"; the street reading is conditioned on that licence, not on the designator.

| class                | licence?          | consequence                                   | rate  |
| -------------------- | ----------------- | --------------------------------------------- | ----- |
| street-housenumber   | yes, clean        | parses correctly                              | 0.925 |
| alnum-housenumber    | yes, clean        | parses correctly                              | 0.925 |
| bare-street          | none              | designator-led phrase → locality              | 0.215 |
| street-particle      | none              | same                                          | 0.273 |
| admin-street-homonym | none              | same, and the toponym _is_ a place → stronger | 0.087 |
| date-name            | yes, but spurious | licence granted, digits stolen, street split  | 0.055 |
| bare-locality        | none              | → locality — **correct**                      | 0.980 |

**The negative class passes for the wrong reason.** `bare-locality` scores 0.980 not because the model
recognises a commune, but because it calls _everything_ without a house number a locality, and on
bare localities that is accidentally right. That is a standing prediction for T2: **teaching bare
streets may regress `bare-locality`**, because the class currently free-rides on the same broken
default. This is precisely why the negative class is a guard and not a trophy.

It also unifies the digit findings that looked like two bugs. T1a: the span decode pulls a digit **into**
the street (`"korunní"` → `"korunní 8"`). T1c: the BIO decode pushes digits **out** of the street
(`"Allee du 11 Novembre"` → `"Allee du Novembre"`). One confusion — the model cannot tell a digit that
belongs to a street name from a digit that is a house number — surfacing from both sides.

## 4. Pre-registered targets for T2

The board is the grading set. Registered as baselines; the shard is graded against these exact cells.

**Must move** (the thesis): `bare-street` 0.215 · `street-particle` 0.273 · `admin-street-homonym`
0.087 · `date-name` 0.055.

**Must not regress** (the guards):

- `street-housenumber` 0.925 and `alnum-housenumber` 0.925 — the contextful guard. A shard that fixes
  fragments by degrading normal addresses has moved the failure, not fixed it.
- `bare-locality` 0.980 — **the one to watch**, per §3. If it falls while the bare classes rise, the
  shard traded one default for another rather than teaching the distinction.
- The global parity floor (`eval parity`) must hold. Board 2 moving is not a verdict alone.

**Split discipline:** the board reserves its 2,400 street surfaces in `ban-fragments-fr.surfaces.txt`.
The T2 shard MUST exclude every one — source-disjoint by normalized **surface**, never by record row.
Row-disjoint leaks the surface across the boundary and measures memorization of `Rue de Rivoli` while
claiming generalization to unseen streets.

## 5. Known limitation

BAN's sharded DBs retain only `locality_norm` / `locality_base`, so the negative class is
accent-stripped (`Amelie-les-Bains-Palalda`). French title-casing is reconstructed; the accents cannot
be. This makes `bare-locality` mildly out-of-distribution and may inflate its absolute difficulty — it
does not affect the comparison the board exists for, since every model sees the identical input. Source
commune surfaces from a register that keeps them if the absolute number ever matters.

Note the two negative-class rates are **not** comparable across fixtures: the shipped model hallucinates
on 2% of these clean BAN communes but 22% of parity's 54 street-free rows, which include venues, `BOOM`,
and `New York, NY`. Different populations, both real.

---

**Reproduce:** `mailwoman eval fragment-board --weights-cache <dir>` (add `--klass bare-street` for a
fast loop). Rebuild the fixture with `python3 scratchpad/build-ban-fragment-board.py` — seeded, so it
reproduces byte-identically.
