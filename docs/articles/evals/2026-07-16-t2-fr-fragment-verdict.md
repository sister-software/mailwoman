# T2 — the BAN fragment shard: the licence hypothesis holds

**Pre-registered gate (config header + `baselines.json` profile `fragment-fr-v264`, registered against
the shipped model before the run):** targets move, guards hold.

**Verdict: PASS on both boards. Every target moved, every guard held, and the two contextful guards
improved.** The house-number-licence diagnosis (T1c) is confirmed by the fix working.

This is **not** a promote gate — see §5.

|           |                                                                    |
| --------- | ------------------------------------------------------------------ |
| Run       | `ap-onoBImKJriMFy7Pz3i5t0D`, config `v3.1.0-fr-fragment`           |
| Change    | ONE variable vs shipped v264: the `synth-fr-fragment` shard @ 12.0 |
| Shard     | 144,865 rows, BAN (Licence Ouverte), 0 eval surfaces               |
| Training  | 8000/8000 steps, 0 errors, no NaN, `cross_pollution 0.00%`         |
| Precision | int8 candidate vs int8 baselines (asserted, see §4)                |

---

## 1. Board 2 — the fragment board (the read)

| class                        |  v264 | 95% CI         |  **v310** | 95% CI         |           Δ |
| ---------------------------- | ----: | -------------- | --------: | -------------- | ----------: |
| bare-street                  | 0.215 | [0.178, 0.258] | **0.715** | [0.669, 0.757] | **+50.0pp** |
| street-particle              | 0.273 | [0.231, 0.318] | **0.855** | [0.817, 0.886] | **+58.2pp** |
| admin-street-homonym         | 0.087 | [0.064, 0.119] | **0.517** | [0.469, 0.566] | **+43.0pp** |
| date-name                    | 0.055 | [0.037, 0.082] | **0.158** | [0.125, 0.196] | **+10.3pp** |
| street-housenumber _(guard)_ | 0.925 | [0.895, 0.947] | **0.948** | [0.921, 0.965] |  **+2.3pp** |
| alnum-housenumber _(guard)_  | 0.925 | [0.895, 0.947] | **0.960** | [0.936, 0.975] |  **+3.5pp** |
| bare-locality _(guard)_      | 0.980 | [0.961, 0.990] | **0.980** | [0.961, 0.990] |    **±0.0** |
| **OVERALL**                  | 0.494 | [0.476, 0.513] | **0.733** | [0.717, 0.749] |     +23.9pp |

No target's interval overlaps its baseline. These are not readings anyone has to squint at.

**The archetype:**

```
"Rue Montmartre"   v264 -> locality="Rue Montmartre"     v310 -> street ✓
```

## 2. The prediction that mattered: `bare-locality` held

T1c's standing prediction was that **this cell might collapse**. It read 0.980 for the _wrong reason_
— the model called everything without a house number a locality, and on bare localities that was
accidentally right. Teaching bare streets gave it every incentive to flip that default and trade one
broken prior for another.

**It held exactly: 0.980 → 0.980.** Same interval. The model learned the **distinction** rather than a
new default, and the discriminating evidence is the designator, which is the only thing that actually
separates the two classes.

That is what the counter-distribution was for. 20% of the shard is bare communes carrying no street
label; without them, the cheapest way to satisfy every other row is to start calling bare toponyms
streets. The guard is why we can say the model learned rather than swapped.

**The contextful guards did not merely hold — they improved** (+2.3pp, +3.5pp). The shard did not buy
fragments with full addresses.

## 3. Board 1 — the global parity floor (the guard)

| label        |             v264 |             **v310** |          Δ |
| ------------ | ---------------: | -------------------: | ---------: |
| street       |  154/267 = 0.577 | **162/267 = 0.6067** | **+3.0pp** |
| house_number | 117/146 = 0.8014 | **117/146 = 0.8014** |  identical |
| postcode     |   71/72 = 0.9861 |   **71/72 = 0.9861** |  identical |

Nothing regressed; street gained **+8 fixtures** on the broad corpus. The `FAIL` verdicts printed by
`eval parity` are the **v7 campaign floors** (street 0.90 / hn 0.97) — v264 fails them too. They are a
target, not a regression gate.

## 4. What the in-training eval said, and why it is not the verdict

|          |   v264 |  @2000 |  @4000 |  @6000 |     @8000 |
| -------- | -----: | -----: | -----: | -----: | --------: |
| street   | 0.8105 |  0.798 |  0.811 |  0.810 |     0.805 |
| region   | 0.8402 |  0.833 |  0.830 |  0.830 | **0.831** |
| locality | 0.7969 |  0.799 |  0.794 |  0.794 |     0.795 |
| val_loss | 1.1819 | 1.1992 | 1.1990 | 1.1995 |    1.2009 |

**The val split contains no bare streets.** It is base-distribution, so it could only ever price the
cost — never the win. Read alone it says "regression"; the fragment board says +50pp. Both numbers are
correct about different questions.

Two things survive from it:

- **street dipped and re-converged** (0.798 → 0.811) _while carrying the fragment mass_ — the same
  story the boards tell.
- **region found a new lower equilibrium at ~0.830 (−1.0pp) and plateaued** across four evals. It
  looked like the open item — **#1102** is titled _"fragment/twin training mass erodes US
  region+locality recall (~2.5pp) — the promote blocker"_, the same failure shape at a larger
  magnitude, and it blocked a promote before. **It did not reproduce on the canonical gate (§4.1).**

**The precision confound, caught in the act.** The first read graded an **fp32** export against
**int8** baselines — the shipped weights package ships int8 (39.4 MB), a fresh `export_onnx` is fp32
(157 MB). The gate specs cap int8-vs-fp32 at 1.5pp, larger than several cells above. The read script's
md5 check passed it happily, because "differs from the baseline model" is trivially true of a precision
change: **an md5 difference proves the file changed, not that it is comparable.** Fixed (`5e5f9c2a`) —
the pipeline is export → quantize → grade, and the script now asserts the precision class matches.
Every number on this page is int8-vs-int8.

### 4.1 The golden per-tag battery — the 2pp pre-publish gate

The canonical instrument the promote rule names (`eval error-analysis`, strict `createScorer`, full
ship config, int8 both sides):

| tag          |  v264 |  **v310** |          Δ |
| ------------ | ----: | --------: | ---------: |
| region       | 78.8% | **78.6%** | **−0.2pp** |
| locality     | 48.8% |     48.7% |     −0.1pp |
| postcode     | 97.3% |     97.2% |     −0.1pp |
| house_number | 97.1% |     97.0% |     −0.1pp |
| venue        | 37.1% |     37.1% |         ±0 |
| street       | 15.8% | **16.3%** | **+0.5pp** |
| country      | 89.0% | **90.2%** | **+1.2pp** |
| exact match  | 25.5% | **25.7%** |     +0.2pp |

**Every tag is inside the 2pp bar. Two improve. The pre-publish gate PASSES.**

So the val split's −1.0pp region was a **false positive**, not a preview. Worth stating plainly
because it inverts the arc's usual failure: the other instruments here missed problems that were
real; this one reported a problem that was not. Same root — a metric on a distribution nobody asked
about — and the same rule: read the instrument the gate names.

That does not make `region` uninteresting. It is the tag the fragment mass pulls on, #1102 is real,
and a heavier weight or a second locale's shard could push −0.2pp into −2pp. It is a thing to watch,
not a thing to ignore, and it is cheap to watch: this table is one command.

### 4.2 The pre-registered "ALSO" — which did NOT come out as predicted

The gate carried a third clause: _"`hallucination_rate@v301-span` 0.352 should FALL if T1c's diagnosis
holds."_ Measured on the 54 street-free parity rows — the MESSY population (venues, all-caps junk,
French zone names), as distinct from the fragment board's clean BAN communes:

|                    |          rate | 95% Wilson     |
| ------------------ | ------------: | -------------- |
| v264 (shipped)     | 12/54 = 0.222 | [0.132, 0.349] |
| v310 (fr-fragment) | 17/54 = 0.315 | [0.207, 0.447] |

**It rose.** 6 introduced, 1 removed. The intervals overlap heavily and McNemar on the paired
discordants (6 vs 1) gives p ≈ 0.125, so the rate change is **not established** — but the direction is
against the prediction, and two of the six have a mechanism worth naming:

```
✗ "ZAC sous la Combe Lavancia-Epercy" -> street="Combe Lavancia-Epercy"
✗ "ZA Entraigues Embrun"              -> street="ZA"
```

`ZAC` / `ZA` are French **zone** designators (_zone d'aménagement concerté_), and `sous la` is exactly
the particle pattern the shard teaches. This is **on-thesis over-generalization**: the grammar the
shard installs — "French designator + particle + name = street" — is slightly too wide, and French
zone names sit just inside its edge. The other four (`BOOM` → `Boom`, `new south wales aus`,
`philadelphia museum of art`) are pre-existing non-French confusions that shifted.

The two populations do not contradict each other; they partition:

- **Clean French communes** (board, n=400): `bare-locality` **held at 0.980**. The counter-distribution
  worked exactly where it was aimed.
- **French zone names**: a **new, narrow class** the counter-distribution does not cover, because it
  mints only communes.
- **Non-French junk**: noise.

The fix is a sibling of what is already there — extend the counter-distribution to French zone
designators (`ZAC`, `ZA`, `Lotissement`, `Résidence` as NOT-street). Not a new idea, a wider one.
It is a shard change, so it belongs to the next run, not to this verdict.

**This is what pre-registration is for.** Two of the three gate clauses passed decisively; the third
went the other way and is on the page at the same size as the wins.

## 5. What this does and does not establish

**Establishes:** the failure was the training distribution, exactly as T1c diagnosed. A model that read
`Rue Montmartre` as a locality now reads it as a street, and does so without giving up the contextful
case or starting to hallucinate streets on bare communes. The BAN registry as a **soft prior +
synthetic coverage** source — the doctrine's whole claim — works on its first real test.

**Does not establish:**

- **Promotion.** The 2pp pre-publish gate passes (§4.1), which clears the largest single hurdle — but
  that is one leg, not the battery. A promote still wants `mailwoman eval gate --gate <spec>` (the
  per-locale floors, the int8↔fp32 delta cap, the cascade smoke, the mask-regression lock) and an
  operator GO. Nothing ships on this page.
- **The v7 floors.** street 0.6067 vs a 0.90 floor. +3.0pp is real and it is not 32pp.
- **`date-name`.** 0.158 is +10.3pp and still 84% wrong. BAN holds only ~1,418 date-name streets and
  the extractor already takes every one; the shard has 655 rows of it. The lever there is **shard
  weight**, not more data — and, per T1c, the underlying confusion (a digit inside a street name vs a
  house number) is the same one the span decode shows from the other side.
- **Other locales.** FR only. Generalization goes **by tier** (BAN → BAG → TIGER-with-scope), never
  folded into one step.
- **Hallucination.** §4.2: it did not fall, and on the messy population it rose (n.s.). The FR-zone
  class is real, narrow, and uncovered. Anyone reading the +50pp should read that too.

---

**Reproduce:** `bash scratchpad/read-v310-gate.sh 008000` (export → quantize → both boards, with the
precision assertion).
