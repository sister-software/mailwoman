# Postcode-country coherence: overriding `defaultCountry` on geometric evidence

**Date:** 2026-08-04 · **Branch:** `feat/42-postcode-coherence` · **Issue:** #42 · **Status:** implemented
opt-in, default OFF. Default-on is a D-rule call the operator makes; §5 says what evidence is still
missing.

Follow-up to [`2026-08-03-postcode-locality-scoping.md`](./2026-08-03-postcode-locality-scoping.md),
which diagnosed why `12 Rue de Rivoli, 75001 Paris` resolves to Texas and named two blockers. This
record lands the mechanism and measures it.

---

## 1. What shipped

`resolver/postcode-country-coherence.ts` — `ResolveOpts.postcodeCountryCoherence`, default OFF,
surfaced as `--postcode-country-coherence` on `parse` and `geocode` and as an opt-in pin on
`eval oa-resolver`.

**The seam is a pre-walk SCOPE decision, not a post-walk re-pick.** Its three sibling coherence passes
(`applyAdminCoherence` #263, `applyExplicitCountryCoherence` #822, `applyRegionCountryCoherence`) run
after the greedy walk and swap the wrong node pair for the right one. That shape cannot work here.
What needs correcting is the walk's country _scope_, and the scope poisons three things a post-walk
pass cannot reach: the postcode node's own resolution (Addison, not Paris 1er), the
`applyPostcodeConsistency` fallback that then drags the locality onto it, and the hard `country`
filter on every other admin lookup. So the verdict is taken once, before the first lookup, and
replaces `state.defaultCountry` for the whole walk.

**The order is the safety argument.** The caller's `defaultCountry` is tested first:

1. Is the (postcode, locality) pair geographically consistent under `defaultCountry`? If yes, return
   `null` — no override, two lookups spent, byte-identical walk. Every correctly-scoped domestic parse
   exits here. It is never "US loses to FR"; it is "US had no answer".
2. Otherwise, try each other country `candidateSystemsForPostcode` allows (a model-free shape test
   over each codex slice's own postcode pattern — no safelist, no prior).
3. Adopt a country only if EXACTLY one makes the pair consistent. Zero (no evidence) and two-or-more
   (a genuine geographic tie) both abstain.

Consistency = the postcode resolves in that country AND an EXACT-matching same-named locality sits
within `gateKm` (default 25) of it. Non-exact locality hits contribute nothing — a generous FTS match
("Paris" → "Parish") is evidence about the index, not about the country.

Two bounds fall out of the candidate set being codex-shaped. A country with no codex slice can never
be proposed: the gazetteer holds `75001` in PL, and this pass will never return PL. And a shape no
slice recognizes (a bare `27`) yields no candidates at all.

Cost: 2 lookups on the byte-stable path, at most 8 when it fires (a numeric shape matches at most
`us`/`de`/`fr`), and nothing at all unless a `defaultCountry` is in force and the tree carries both a
postcode and a locality.

### The geocode-path wrinkle

Rooftop and street-centroid shards are selected BEFORE the resolve — they are resolver inputs — off
`defaultCountry ?? placedCountry`. A US-scoped call therefore picks no BAN/OSM shard, and a corrected
FR address would sit at its commune centroid with the national register never consulted. So when the
resolver reports an override (the `postcode_country_scope` stamp it writes onto the postcode and
locality nodes), `geocodeAddress` re-selects the shards for the corrected country and resolves once
more. Self-gating: unreachable unless an override fired, and bounded at one extra resolve.

## 2. Blocker 2, verified from this end

The 2026-08-04 rebuild attached the postal shards. Counted directly against
`$MAILWOMAN_DATA_ROOT/wof/candidate.db` (the `candidate.db` symlink → `candidate-global.db`):

| placetype    | rows          |
| ------------ | ------------- |
| locality     | 8,596,442     |
| `postalcode` | **3,694,675** |
| …            | …             |

and the four-way `75001` collision the diagnosis predicted is present verbatim:

| country | lat, lon              | spr_id                      |
| ------- | --------------------- | --------------------------- |
| FR      | 48.86263, 2.336293    | 421307175                   |
| US      | 32.960001, -96.838499 | 554744141                   |
| DE      | 48.843796, 9.367177   | 421285019                   |
| PL      | 54.1903, 16.1879      | 8000048250 (+ a second row) |

**The postal shards are NOT attached everywhere, and the difference is load-bearing** — see §4 and §5.

## 3. The Rivoli case, end to end

Compiled CLI, production defaults (locale `en-US` → `defaultCountry: "US"`), full shard set:

```
$ node mailwoman/out/cli.js geocode "12 Rue de Rivoli, 75001 Paris"
  "lat": 32.960001, "lon": -96.838499, "countryCode": "US",
  "resolution_tier": "admin", "uncertainty_m": null

$ node mailwoman/out/cli.js geocode "12 Rue de Rivoli, 75001 Paris" --postcode-country-coherence
  "lat": 48.855602, "lon": 2.35995, "countryCode": "FR",
  "resolution_tier": "address_point", "uncertainty_m": 1
```

The second is the BAN rooftop for 12 Rue de Rivoli, to the metre — byte-identical to the
`--default-country none` receipt the diagnosis recorded, which is the point: the override buys back
exactly what removing the default bought, without removing the default.

On `parse --resolve` against the candidate gazetteer with the country pinned, the same two nodes move:

```
$ … parse "12 Rue de Rivoli, 75001 Paris" --resolve --default-country US --format xml
  <postcode … src="resolver:postalcode:554744141" lat="32.960001" lon="-96.838499">75001
  <locality … src="resolver:localadmin:404526387" lat="32.960001" lon="-96.838499">Paris

$ … --postcode-country-coherence
  <postcode … src="resolver:postalcode:421307175" lat="48.862630" lon="2.336293">75001
  <locality … src="resolver:localadmin:1159322569" lat="48.856599" lon="2.342841">Paris
```

Note what the before-picture shows: BOTH nodes sitting on 32.960001,-96.838499. That is the
worse-than-wrong case — `applyPostcodeConsistency` finding no Paris within 50 km of ZIP 75001 (the
nearest is 143.8 km) and falling the locality back onto the ZIP point.

## 4. The probe set

22 cases × 2 backends × 2 case-registers, through the compiled CLI. Every row is `en-US` locale.
`OFF`/`ON` are the resolved `countryCode`; the coordinate and tier are in the raw dumps.

### Leg A — production default shard set (`wofShardPaths()`, 5 shards)

| #   | input                                           | expect  | OFF                    | ON                   | verdict                    |
| --- | ----------------------------------------------- | ------- | ---------------------- | -------------------- | -------------------------- |
| P01 | `12 Rue de Rivoli, 75001 Paris`                 | FR      | US (Addison TX)        | **FR** rooftop 1 m   | **FIXED**                  |
| P02 | `20 Avenue de Segur, 75007 Paris`               | FR      | US 33.005,-96.897      | **FR** rooftop 1 m   | **FIXED**                  |
| P03 | `Unter den Linden 77, 10117 Berlin`             | DE      | US 41.611,-72.776 (CT) | **DE** 52.502,13.402 | **FIXED**                  |
| P04 | `Marienplatz 1, 80331 Munchen`                  | DE      | US (Munich ND)         | US (Munich ND)       | abstain (§4.1)             |
| P05 | `10 Downing Street, London SW1A 2AA`            | GB      | US (London OH)         | **GB** 51.501,-0.109 | **FIXED**                  |
| P06 | `221B Baker Street, London NW1 6XE`             | GB      | US (London OH)         | **GB** 51.501,-0.109 | **FIXED**                  |
| P07 | `290 Bremner Blvd, Toronto ON M5V 3L9`          | CA      | US 39.782,-87.496      | US 39.782,-87.496    | abstain (§4.1)             |
| P08 | `1600 Pennsylvania Ave NW, Washington DC 20500` | US      | US rooftop 1 m         | US rooftop 1 m       | unchanged ✓                |
| P09 | `350 5th Ave, New York NY 10001`                | US      | US 40.694,-73.930      | US 40.694,-73.930    | unchanged ✓                |
| P10 | `9641 Sunset Blvd, Beverly Hills CA 90210`      | US      | US 34.079,-118.402     | US 34.079,-118.402   | unchanged ✓                |
| P11 | `4900 Airport Pkwy, Addison TX 75001`           | US      | US rooftop 1 m         | US rooftop 1 m       | **unchanged ✓**            |
| P12 | `2025 Clarksville St, Paris TX 75460`           | US      | US interpolated 73 m   | US interpolated 73 m | **unchanged ✓**            |
| P13 | `45 Main St, Berlin NH 03570`                   | US      | US interpolated 23 m   | US interpolated 23 m | **unchanged ✓**            |
| P14 | `1 Broad St, Athens GA 30601`                   | US      | US 33.951,-83.369      | US 33.951,-83.369    | unchanged ✓                |
| P15 | `Springfield, IL 62701`                         | US      | US 39.801,-89.649      | US 39.801,-89.649    | unchanged ✓                |
| P16 | `75001 Paris` (bare)                            | FR      | US (Addison TX)        | **FR** 48.857,2.343  | **FIXED**                  |
| P17 | `Paris, TX`                                     | US      | US 33.669,-95.544      | US 33.669,-95.544    | inert ✓                    |
| P18 | `Paris, France`                                 | FR      | FR 48.857,2.343        | FR 48.857,2.343      | inert ✓                    |
| P19 | `London, Ontario`                               | CA      | GB (London GB)         | GB (London GB)       | inert, pre-existing defect |
| P20 | `Springfield 75001`                             | ABSTAIN | US (ZIP 75001)         | US (ZIP 75001)       | abstain ✓                  |
| P21 | `Berlin 75001`                                  | ABSTAIN | US (ZIP 75001)         | US (ZIP 75001)       | abstain ✓                  |
| P22 | `Portland, ME 04101`                            | US      | US 43.663,-70.257      | US 43.663,-70.257    | unchanged ✓                |

**6 fixed, 16 unchanged, 0 made worse.**

The four bolded "unchanged" rows are the adversarial ones and the reason to trust the ordering:

- **P11 is the literal collision.** ZIP 75001 IS Addison, Texas. The US default is coherent there
  (0.3 km), so step 1 exits and the pass never proposes FR. The rooftop survives.
- **P12** is the real Paris TX ZIP — 75460, coherent in the US at 5.7 km.
- **P13 Berlin, New Hampshire** is the one that would hurt most: a US city whose name is a German
  capital, carrying a 5-digit code the DE shape also accepts. ZIP 03570 is coherent with Berlin NH, so
  the pass exits before ever asking Germany.
- **P14 Athens, Georgia** is the same trap with a country name; same outcome.

P20/P21 pair a real postcode with the wrong city. No country makes them consistent, so the pass
abstains and leaves the (still wrong, still `postcode_city_mismatch`-flagged) US answer alone. It does
not invent a country to explain a contradiction.

P19 `London, Ontario` carries no postcode, so the mechanism is inert by construction — the defect the
diagnosis flagged (Ontario tagged `locality`, not `region`, so `applyRegionCountryCoherence` never
fires) is untouched and still wants its own ticket.

### Leg A′ — the lowercase register

The same 22 inputs lower-cased. **Every row is identical to Leg A, OFF and ON.** Expected — the pass
keys on gazetteer name matching, not case — but the register is where user queries actually live, so
it gets measured rather than assumed.

### Leg B — candidate gazetteer, `--default-country US` pinned

Isolating the one variable: same panel, `--candidate-db candidate.db --default-country US`.

Identical to Leg A except three rows, all of which resolve to the shard set rather than the mechanism:

- **P04 Munchen → FIXED (DE 48.153,11.547).** See §4.1.
- **P07 Toronto → already CA, OFF and ON.** `applyRegionCountryCoherence` rescues the "ON" region
  token on this backend, so there was nothing left to fix; the pass left it alone.
- **P19 London, Ontario → US (London OH) both ways.** Different wrong answer than Leg A's London GB,
  same pre-existing defect, still untouched by this pass.

**7 fixed, 15 unchanged, 0 made worse.**

### 4.1 Why P04 and P07 abstain on the production shard set

Both are DATA abstentions, not mechanism failures, and each was measured rather than reasoned to:

- **P04 `Munchen`.** On the FTS backend, `findPlace({text:"Munchen", country:"DE"})` returns `München`
  with `exactMatch: FALSE` — the FTS exact-match tier does not fold `ü` → `u`. The pass requires an
  exact match, so it abstains. The candidate backend keys on `name_key = "munchen"` and does fold it,
  which is why Leg B fixes the row. The gap is in the FTS exact-match tiering, not here.
- **P07 `M5V 3L9`.** The production shard set has **zero** CA postcode rows reachable as
  `placetype: "postalcode"`. Nothing to be coherent with. `candidate.db` carries 843,739 of them.

Both fail toward abstention, which is the designed direction.

## 5. Is this ready to be default-on?

**No — not yet, and the missing evidence is specific.**

### What is established

- The confound board holds. 22 cases × 2 backends × 2 registers, and **not one case is made worse**.
  The four adversarial rows that would hurt most (Addison TX, Paris TX, Berlin NH, Athens GA) are all
  untouched, and untouched _by the cheap exit_ — the pass never even asks the foreign country.
- The abstention behaviour is real, not theoretical: P04, P07, P20 and P21 abstain for four different
  reasons (diacritic folding, missing shard, contradictory pair, contradictory pair).
- The cost is bounded and mostly zero: 2 lookups when the default is coherent, ≤8 when it is not,
  none at all without a postcode + locality + `defaultCountry`.

### What is missing

**A tier-1 aggregate on a panel that actually exercises the mechanism.** The first attempt at getting
one produced a trap worth recording, because it looked exactly like a pass.

`mailwoman eval oa-resolver --limit 10000` (10,000 OpenAddresses US rows) returned a per-row dump that
is **byte-identical** between flag OFF and ON — md5 `4a98e68f17daf90605354b15c707f485` on both 1.94 MB
files, and the aggregate table matches to the digit (locality-match 98.2%, region 100.0%, coord p50
3.3 / p90 9.8 / p99 87.9 km).

That number is **vacuous as written.** The eval's default shard set is
`admin-global-priority.db,postcode-locality-intl.db`, and probing it directly for the panel's own ZIPs
returns `pc-MISS` on every one — the intl shard carries GB/NL/JP/FR/DE/ES/IT and no US rows at all. So
the pass abstained on all 10,000 rows for want of a postcode, and the identical dump proves only that
the mechanism costs nothing where there is no postcode coverage. A magnitude never carries its own
absence; this one had to be asked directly.

Re-running the same panel with `--candidate-db candidate.db` puts it in the regime that matters — US
postcodes resolve, and (measured on the panel's first rows) DE and FR rows exist for several of those
same 5-digit codes, so the alternative-country legs genuinely run and are refuted by the locality
test. That leg's result is in §6.

§6 re-runs it in the regime that matters, and adds an FR and a GB panel. Those close the aggregate
question. What remains open is narrower:

1. **The gauntlet has not seen this.** `mailwoman eval gauntlet` carries no resolver-lever pin, so the
   D-rule's standard gate has no leg for it. §6 is an oa-resolver measurement, which is the right
   instrument for a resolver lever but is not the gate the release process runs.
2. **`exactMatch` is load-bearing and backend-dependent.** P04 shows the FTS backend and the candidate
   backend disagree about what an exact match is (`Munchen` → `München` is exact on one, not the
   other). Every §6 number is candidate-backend. A default-on mechanism whose firing rate depends on
   which gazetteer is attached needs that difference measured on the FTS path too, or the diacritic
   gap fixed.
3. **Every number here is Latin-script, three countries.** DE/ES/IT/JP have codex postcode shapes and
   are untested at scale. The confound board covers DE by hand and nothing else.
4. **The 800-pair survey is inherited, not re-run.** The original zero-border-crossing claim comes from
   the 2026-08-03 out-of-tree prototype. §6 supersedes it with 28,000 evaluations against the shipped
   code, so this is bookkeeping rather than a gap — but the two should not be cited as independent
   confirmations of each other. They are the same claim, measured twice, the second time properly.

### Recommendation

**Land opt-in now (done). Propose default-on once the gauntlet has a pin and the FTS-backend leg is
measured** — those are the two real gaps, and both are small pieces of work rather than open questions.

The evidence for default-on is otherwise strong and unusually clean. 28,000 pair evaluations across
US/FR/GB and both mis-scope directions produce **zero false positives**, and — the part that matters
more than the zero — 1,240 domestic rows genuinely fell past the cheap exit and had every alternative
country tried, so the zero is not an artifact of the mechanism never running. The rescue rate lands at
88–99% and equals the resolvable-pair count exactly, so the failure mode is abstention, not error. The
whole confound board is untouched, including the four rows designed to break it (Addison TX, Paris TX,
Berlin NH, Athens GA).

One caution against over-reading the win rate: the rescue leg simulates a _uniformly_ mis-scoped
default, which is the demo/CLI reality (locale `en-US` → `US` on every query) but overstates how often
this fires in production traffic that already carries a correct country. The right way to read §6 is
"when the default is wrong, this fixes ~9 in 10 of them and breaks none", not "this improves 9 in 10
addresses".

**Separately, and worth its own ticket:** this is now the only thing in the tree that can override
`defaultCountry`. The coarse placer's 0.9999908844-confidence FR call on the very same address still
cannot — `hardCountryFor` returns `undefined` whenever a `defaultCountry` is set, and geocode-core's
#928 postcode-format prior is gated on `!opts.defaultCountry`. The diagnosis argued those are the same
decision as this one. This lands the geometric half; the placer half is untouched.

## 6. Scale: 14,000 pairs, three countries, three mis-scope directions

Re-run of the panel on `--candidate-db candidate.db`, plus two more countries. All against the live
2026-08-04 gazetteer, over the public `findPostcodeCountryScope` surface.

**First, the end-to-end eval.** `eval oa-resolver --candidate-db … --limit 10000`, flag OFF vs ON:
per-row dump byte-identical, md5 `2209017211bbbf14c5e3e36f8c38cc1a` on both 1.94 MB files. Aggregate
identical to the digit: locality-match 98.3%, region 100.0%, resolved 100.0%, coord p50 2.4 / p90 10.6
/ p99 24.5 km, and every per-state cell matches.

**And the regime it ran in**, because that is what makes the number mean something. Each row classified
by whether the US default was itself coherent (step 1 exits, no other country asked) or fell through
(every candidate country actually tried — the false-positive path):

### Domestic leg — the address's own country as the default. Any override is a regression.

| panel                                  |      n | coherent-default | fell through | overrides | false positives |
| -------------------------------------- | -----: | ---------------: | -----------: | --------: | --------------: |
| OpenAddresses US, `defaultCountry: US` | 10,000 |            8,918 |    **1,082** |     **0** |           **0** |
| OpenAddresses FR, `defaultCountry: FR` |  3,000 |            2,963 |       **37** |     **0** |           **0** |
| OSM GB, `defaultCountry: GB`           |  1,000 |              879 |      **121** |     **0** |           **0** |

The fell-through column is the point. 1,082 US rows, 37 FR rows and 121 GB rows did NOT take the cheap
exit — for each of them the pass asked every other country the postcode shape allows, and every one
came back refuted by the locality test. **Zero border crossings on 1,240 genuinely at-risk domestic
rows.** Without that column the byte-identical dump would prove nothing; a magnitude never carries its
own absence.

### Rescue leg — a deliberately mis-scoped default. An override to the panel's country is the win.

| panel                       |      n | fell through | rescued correctly | false positives |
| --------------------------- | -----: | -----------: | ----------------: | --------------: |
| OpenAddresses FR under `US` |  3,000 |        3,000 | **2,963 (98.8%)** |           **0** |
| OSM GB under `US`           |  1,000 |        1,000 |   **879 (87.9%)** |           **0** |
| OpenAddresses US under `FR` | 10,000 |       10,000 | **8,918 (89.2%)** |           **0** |

The rescue rate equals the domestic coherent-default count exactly, in all three panels (2,963 / 879 /
8,918). That is not a coincidence and it is the mechanism's cleanest property: it rescues precisely the
set of pairs whose geometry is resolvable at all, and abstains on the rest. Its recall ceiling is the
gazetteer's, not a tuning parameter's.

**Across all six legs — 28,000 pair evaluations, three countries, both mis-scope directions — the
false-positive count is 0.**

### Caveat on the regime classifier

The "coherent-default" split is derived by re-running the pass with an impossible default (`ZZ`), which
forces step 1 to fail and reports what the alternatives alone would decide. A pair coherent in TWO
countries reads as "fell through" under that probe even though the real leg would also have abstained,
so the fell-through column is if anything an over-count. It errs toward claiming MORE at-risk rows than
there were, which is the safe direction for this argument.

## 7. Test summary

`resolver/postcode-country-coherence.test.ts` — 24 tests, all passing; full resolver suite 167/167.
Fixtures are the real four-way `75001` collision with the gazetteer's own coordinates, and the fake
backend models the two behaviours that cause the bug (a hard `country` filter and population-first
within-tier ranking), so the "before" assertion genuinely lands on Paris, Texas and on the
`postcode_city_mismatch` fallback to Addison.

The safety properties have direct tests: coherent-default-wins, abstain-on-zero, abstain-on-tie,
abstain-without-a-locality, abstain-on-an-unrecognized-shape, never-propose-a-country-without-a-codex-
slice (the PL row), exact-match-only, gate-respected, backend-throw-degrades-to-no-override, and a
byte-identical flag-on-vs-off assertion on the domestic control.

Repo-wide: unit suite 4,637 passed / 1 failed (`geocode.test.ts` "missing address argument" — a 15 s
timeout under parallel load; the file passes 7/7 in isolation, and the argument-validation path is
untouched by this change). Integration suite 175 passed / 1 expected-fail / 13 skipped.
