# Why `75001 Paris` resolves to Paris, Texas — and what a postcode-derived country scope would cost

**Date:** 2026-08-03 · **Branch:** `investigate/postcode-scoping` · **Status:** diagnosis only, no
production behaviour changed. Any fix is a D-rule call the operator makes.

The question: `12 Rue de Rivoli, 75001 Paris` parses correctly, including `postcode: "75001"`, and
the FTS resolver still puts the locality in Texas. Does the postcode reach the locality lookup, why
does Texas win, and can a postcode-derived country scope fix it without breaking the confounds.

Everything below is instrumented. The probes wrapped `WOFSqlitePlaceLookup.findPlace` and
`Resolver.resolveTree` and printed the queries and opts verbatim; nothing is inferred from an
output coordinate.

---

## Summary

1. **The postcode reaches the lookup and is then discarded.** The locality query literally carries
   `postcode: "75001"`. The FTS backend's only consumer of that field is the
   `postcode_area_resolution` strategy, which is inert in this configuration, and the
   name-match fallback that actually runs never reads it.

2. **Texas wins because of `--locale`, not the postcode.** `--locale` defaults to `en-US`, which
   the CLI turns into `ResolveOpts.defaultCountry = "US"`, which becomes a hard `spr.country = 'US'`
   WHERE clause. The candidate pool is all-US before ranking begins; population then picks Paris TX
   (24,969). The coarse placer had already called this address **FR at confidence 0.9999908844** and
   was overruled — `defaultCountry` outranks every other country signal in the codebase, by design
   and in three separate places.

3. **The premise needs correcting: `75001` is not an unambiguously French postcode.** It is a valid
   US ZIP (Addison, Texas). codex agrees — `candidateSystemsForPostcode("75001")` returns
   `["us","de","fr"]` — and the gazetteer holds the string in four countries. No pattern-only
   mechanism can settle this. It needs geometry.

4. **A geometric mechanism does settle it, cleanly.** A prototype "postcode-country coherence" pass
   returns FR for `(75001, Paris)` at 0.8 km and US for `(75001, Addison)` at 0.3 km. Over 800 real
   pairs (400 US ZIP+city, 400 FR CP+commune) it crossed a border **zero** times.

5. **A second-order finding, verified twice:** once the postal shards are attached — which is what
   `mailwoman geocode` does by default — `defaultCountry=US` makes the answer _worse_, not merely
   wrong. `mailwoman geocode "12 Rue de Rivoli, 75001 Paris"` returns **32.960001, -96.838499 —
   Addison, Texas**, because postcode-consistency falls the locality back to the ZIP-75001 point.

---

## 1. Does the resolver see the postcode?

Yes, in `FindPlaceQuery.postcode`, as a bare string. The instrumented locality query for the
reported input, printed verbatim:

```
Q {"text":"Paris","placetype":"locality","limit":5,"country":"US","postcode":"75001"}
  -> #101725293 "Paris" US 33.669,-95.544 pop=24969 exact=true
  -> #101722715 "Paris" US 36.294,-88.307 pop=10343 exact=true
  -> #85947103  "Paris" US 38.201,-84.272 pop=10089 exact=true
```

`resolver/resolve.ts` does its part. `firstPostcodeValue` (line 120) pre-scans the whole tree
because postcode and locality are siblings and the top-down walk would not otherwise let the
locality lookup see it; `#lookupAndPick` (lines 981-983) attaches it to any `locality` query.

It is the **backend** that drops it. `WOFSqlitePlaceLookup.findPlace` dispatches the resolved
convention's strategies in order — `[postcode_area_resolution, fallback_fuzzy_name_match]`:

- `#postcodeAreaResolution` (`lookup.ts:528`) is gated on `this.#postcodeLocalityShard`. The repro
  attaches one database, `admin-global-priority.db`, and it has no `postcode_locality` table.
  Probed directly: `SELECT name FROM sqlite_master WHERE name='postcode_locality'` → **no row**.
  The strategy returns `null` before touching the postcode.
- `#fuzzyNameMatch` then runs and terminates the chain. Read its 400 lines: `query.postcode` is
  never referenced. The field is carried into the backend and thrown away.

**The country filter starves that evidence a second time, even when the shard is present.** Attach
`postcode-locality-intl.db` and the coordinate-first SQL is
`WHERE postcode = ? AND country = ?` (`lookup.ts:1034`). That shard covers `IT,JP,FR,ES,DE,NL,GB`
and holds `75001` for DE (×5) and FR (×5) — but the query asks for `country = 'US'`, gets zero rows,
returns `null`, and falls through to the same name-match. Measured, same shard attached:

| query                                                   | top candidates                                             |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| `{text: Paris, locality, country: US, postcode: 75001}` | `#101725293 Paris US 33.669,-95.544`                       |
| `{text: Paris, locality, country: FR, postcode: 75001}` | `#101751119 Paris FR 48.857,2.343` · `Levallois-Perret FR` |
| `{text: Paris, locality, postcode: 75001}` (no country) | `#101751119 Paris FR 48.857,2.343`                         |

The coordinate-first path works. It is switched off by the same `defaultCountry` that causes the
bug.

## 2. Why Texas wins

The chain, each link measured:

1. `--locale` defaults to `en-US`. `localeToCountry` (`commands/parse.tsx:271`) takes the region
   subtag; `resolverDefaultCountry` returns `"US"`.
2. `ResolveOpts.defaultCountry = "US"` reaches `resolveTree`.
3. In `#lookupAndPick` the precedence is
   `parentResolved?.country ?? countryHint ?? state.defaultCountry ?? state.hardCountry`
   (`resolve.ts:968-972`). **`defaultCountry` sits above `hardCountry`.**
4. `#fuzzyNameMatch` turns that into `where.push("spr.country = ?")` (`lookup.ts:632`). Hard filter,
   not a boost.
5. Within the surviving exact tier, #905 makes population the primary key. Paris TX (24,969) beats
   Paris TN (10,343) and Paris KY (10,089).

The `anchorPosterior` re-rank (#369) cannot help, and this is the part worth being precise about.
It re-sorts the pool the backend returned. Instrumented on the geocode path, the coarse placer
emits:

```
[placer] {"country":"FR","confidence":0.9999908844099502, "posterior":{"US":1.03e-6,"FR":0.99999,…}}
```

and the resolver receives that posterior. But the pool it re-ranks contains five US Parises and
nothing else, so a 0.99999 FR pin has nothing to promote. A soft re-rank downstream of a hard
filter is inert by construction.

The placer's _hard_ signal is suppressed explicitly. `hardCountryFor`
(`core/pipeline/runtime-pipeline.ts:155-171`) ends with:

```ts
if (existing.hardCountry || existing.defaultCountry) return undefined
```

So a locale-derived `defaultCountry` demotes a 0.99999-confidence FR placement to a soft posterior.
The same subordination appears a third time in `geocode-core.ts:640-645`, where the #928
postcode-format prior is gated on `!opts.defaultCountry`.

**Proof by removal.** Same CLI, same database, one flag:

```
$ mailwoman parse "12 Rue de Rivoli, 75001 Paris" --resolve --resolve-db $WOF --default-country none
  <locality … src="resolver:localadmin:1159322569" lat="48.856599" lon="2.342841">Paris

$ mailwoman geocode "12 Rue de Rivoli, 75001 Paris" --default-country none
  "lat": 48.855602, "lon": 2.35995, "resolution_tier": "address_point", "uncertainty_m": 1
```

The second is the BAN rooftop for 12 Rue de Rivoli, to the metre. All the machinery needed to get
this right is already wired; one locale-derived default is standing on it.

### The worse-than-wrong case

`mailwoman geocode` loads the full shard set via `wofShardPaths`, so the postcode resolves. Under
`defaultCountry=US` it resolves to the _US_ row — ZIP 75001, Addison TX, 32.960,-96.838. Then
`applyPostcodeConsistency` (default-ON since 2026-07-04) measures the gap to the chosen locality and
finds no reconciling alternative inside the 50 km gate:

| Paris candidate     | distance from ZIP 75001 (Addison TX) |
| ------------------- | ------------------------------------ |
| #101725293 Paris TX | **143.8 km**                         |
| #101722715 Paris TN | 863.7 km                             |
| #85947103 Paris KY  | 1275.6 km                            |
| #85939747 Paris IL  | 1103.4 km                            |
| #404475019 Paris ME | 2594.6 km                            |

so it falls the locality coordinate back to the postcode point and stamps
`postcode_city_mismatch` + `coordinate_source: postcode_fallback`. Today, on current main:

```
$ mailwoman geocode "12 Rue de Rivoli, 75001 Paris"
  "lat": 32.960001, "lon": -96.838499, "countryCode": "US"
```

Verified twice — once by recomputing the gate arithmetic from raw gazetteer rows, once by running
the production CLI. The consistency pass is behaving exactly as specified; it is being fed a
country it should never have been given. Credit where due: the falsehood flag _does_ fire, which is
the one thing that went right here.

## 3. The premise: `75001` is not unambiguously French

This is the load-bearing correction, and it kills the obvious fix.

**codex already says so.** `candidateSystemsForPostcode("75001")` → `["us","de","fr"]`. The module's
own docstring (`codex/postcode-systems.ts:17-21`) states the case plainly: a bare `68161` matches
the US, German and French 5-digit shapes, and "the shape alone cannot split the numeric-postcode
systems."

**The gazetteer says so.** The literal string `75001`, per shard:

| shard                         | row                                                            |
| ----------------------------- | -------------------------------------------------------------- |
| `postalcode-us.db`            | `#554744141 US 32.960,-96.838` — ZIP 75001, **Addison, Texas** |
| `postalcode-intl.db`          | `#421307175 FR 48.863,2.336` — Paris 1er                       |
| `postalcode-intl.db`          | `#421285019 DE 48.844,9.367`                                   |
| `postalcode-geonames-tail.db` | `#8000048250 PL 54.190,16.188`                                 |

**The existing lever declines on purpose.** `countryFromPostcodeFormat` (#928, default-ON since
2026-07-06) is the one postcode→country mechanism in the tree. It covers GB, CA and IE — the
letter-bearing formats — and its docstring is explicit that these "never match a US ZIP / NL / FR
code." It returns `null` for every 5-digit code. Extending it to 5-digit shapes is not a fix; it is
a coin-flip between four countries.

Note also that it lives in `mailwoman/geocode-core.ts`, on the `geocode` path only. The
`parse --resolve` path runs `core/pipeline/runtime-pipeline.ts`, which has no postcode→country
mechanism at all. Two production paths, one lever.

## 4. The mechanism that does work: postcode-country coherence

The shape is ambiguous. The **geometry** is not. Addison and Paris are 8,000 km apart, and only one
of them has a same-named town next to its 75001.

This is the same joint-consistency move the resolver already makes three times — `applyAdminCoherence`
(#263), `applyExplicitCountryCoherence` (#822), `applyRegionCountryCoherence` — just keyed on the
postcode instead of a region or country token:

1. Country candidates from codex's postcode **shape**. Model-free, no safelist, no prior.
2. For each candidate country: does the postcode resolve there, and is there a same-named locality
   within `gateKm` of it?
3. The country whose (postcode, locality) pair is geographically consistent wins. Abstain on zero
   hits.

Prototyped out-of-tree against the live gazetteer, over the public `findPlace` surface. No file in
`resolver/` was touched.

### Confound board

Verdicts were identical at 15, 25 and 50 km gates — the mechanism is not gate-tuned.

| postcode | locality      | verdict                            | distance | note                            |
| -------- | ------------- | ---------------------------------- | -------: | ------------------------------- |
| 75001    | Paris         | **FR** `#1159322569` 48.857,2.343  |   0.8 km | the case under investigation    |
| 75001    | Addison       | **US** `#101725671` 32.959,-96.836 |   0.3 km | the literal collision           |
| 75460    | Paris         | **US** `#101725293` 33.669,-95.544 |   5.7 km | the real Paris TX ZIP           |
| 62701    | Springfield   | **US** `#85940429` 39.771,-89.654  |   3.3 km | the brief's ZIP confound        |
| 10115    | Berlin        | **DE** `#101909779` 52.502,13.402  |   3.6 km | another 5-digit collision       |
| 10117    | Berlin        | **DE** `#101909779`                |   2.0 km |                                 |
| 10001    | New York      | **US** `#85977539`                 |   8.4 km |                                 |
| 90210    | Beverly Hills | **US** `#85923701`                 |   2.8 km |                                 |
| 75008    | Paris         | **FR** `#1159322569`               |   2.8 km | another arrondissement          |
| 75001    | Springfield   | ABSTAIN                            |        — | wrong-for-the-city postcode     |
| 75001    | Berlin        | ABSTAIN                            |        — | wrong-for-the-city postcode     |
| 06260    | Saint-Pierre  | ABSTAIN                            |        — | recall miss, not a wrong answer |

**No pair was consistent in more than one country.** Not one needed a tiebreak.

### Scale

Real pairs, sampled deterministically from the shipped artifacts:

| population           | source                                       | verdicts                             |
| -------------------- | -------------------------------------------- | ------------------------------------ |
| 400 US (ZIP, city)   | `postalcode-us.db` + admin parent names      | US **378**, non-US **0**, abstain 22 |
| 400 FR (CP, commune) | `postcode-locality-fr.db`, `is_containing=1` | FR **400**, other **0**, abstain 0   |

800 pairs, zero border crossings, at both the 15 and 25 km gates. The 22 US abstentions are pairs
where the ZIP's parent name is not an exact-matching locality in the admin gazetteer — a recall
gap, and abstention is the safe outcome there.

### The four required cases, end to end

| case                            | today                 | with the pass         | why                                     |
| ------------------------------- | --------------------- | --------------------- | --------------------------------------- |
| `12 Rue de Rivoli, 75001 Paris` | Paris **TX**          | Paris **FR** (0.8 km) | fixed                                   |
| `Paris, TX`                     | Texas + Paris TX ✓    | **unchanged**         | no postcode node ⇒ the pass never fires |
| `Paris, France`                 | Paris FR ✓ (via #822) | **unchanged**         | no postcode node ⇒ inert                |
| `Springfield, IL 62701`         | see below             | **unchanged**         | no locality node ⇒ inert                |
| `London, Ontario` (bonus)       | see below             | **unchanged**         | no postcode node ⇒ inert                |

The mechanism requires **both** a postcode and a locality in the tree, which makes it inert on three
of the four confounds by construction rather than by tuning.

Two of those rows hide separate defects that this investigation surfaced and did not fix:

- **`Springfield, IL 62701` does not produce a locality node at all.** Measured tree:
  `region="IL"`, `postcode="62701"`, **`street="Springfield"`**. The parser tags Springfield as a
  street. Any locality-side mechanism is inert here for that reason, not because the scoping is
  right. As a bare `(62701, Springfield)` pair the pass returns US at 3.3 km.
- **`London, Ontario` is already wrong on both settings.** Under `defaultCountry=US` it resolves
  `locality=Ontario` → Ontario, **California** (pop 182,457) and `locality=London` → London,
  **Ohio**. Under `--default-country none` it goes to London, **GB** (pop 8.8 M). "Ontario" is
  tagged `locality`, not `region`, so `applyRegionCountryCoherence` — which exists precisely to
  rescue "Montreal QC" — never fires. Worth its own ticket.

## 5. Is it feasible?

Yes, and it is cheap. Cost is at most `|candidateSystems|` (≤3 for a 5-digit code) postcode lookups
plus the same number of locality lookups, and only for trees carrying both a postcode and a
locality. It reuses #920 country-aware shard routing, so each country-scoped query already lands on
the right shard — no cross-shard BM25 union, which `sharding.ts` forbids for good reason.

Two things make it a decision rather than a patch:

**(a) It has to be allowed to override `defaultCountry`, and today nothing is.** The subordination
is deliberate and appears three times: `hardCountryFor`'s
`if (existing.hardCountry || existing.defaultCountry) return undefined`; the `#lookupAndPick`
precedence chain; `geocode-core`'s `!opts.defaultCountry` gate on the #928 prior. Changing that
precedence is the real decision, and it is the _same_ decision the coarse placer already lost with
a 0.99999-confidence FR call. Whatever rule is written should cover both.

**(b) It needs the postal shards attached.** `parse --resolve --resolve-db <one.db>` attaches only
the admin database, where the postcode resolves to nothing whatsoever — no evidence to be coherent
with. `mailwoman geocode` and `mailwoman serve` load the full set via `wofShardPaths`. A pass gated
on postcode evidence is silently inert in the single-shard configuration, which is exactly the
configuration the bug was reported against. The gate needs to say so out loud rather than no-op.

### A cheaper intermediate, for comparison

Stop deriving `defaultCountry` from the locale's region subtag when the tree carries a postcode or
the placer is confident. **This precedent already exists**: #912 lever 3 (`commands/geocode.tsx:287`,
`inferredScopeOK`) skips the locale-inferred default for a bare-locality tree, with the comment
"Paris under the en-US locale must not be hard-scoped to Paris, Texas". The gate is one predicate
short of covering this case.

Measured effect of removing the default entirely (`--default-country none`): all four target cases
correct, including the BAN rooftop at 1 m. The cost is that `London, Ontario` and bare `Paris` fall
to population-first-global ranking, which is the regression class the locale default exists to
prevent. So the honest framing is a narrowing of the default's scope, not its removal — and the
narrowing predicate wants measuring on the resolver gauntlet before anyone believes a number in it.

---

## Reproduction

```bash
WOF=/mnt/playpen/mailwoman-data/wof/admin-global-priority.db

# the reported behaviour
node mailwoman/out/cli.js parse "12 Rue de Rivoli, 75001 Paris" \
  --resolve --resolve-db "$WOF" --format xml
#   lat="33.668553" lon="-95.544350"   ← Paris, TX

# one flag, same database
node mailwoman/out/cli.js parse "12 Rue de Rivoli, 75001 Paris" \
  --resolve --resolve-db "$WOF" --default-country none --format xml
#   lat="48.856599" lon="2.342841"     ← Paris, FR

# the worse-than-wrong case (full shard set, postcode resolves)
node mailwoman/out/cli.js geocode "12 Rue de Rivoli, 75001 Paris"
#   "lat": 32.960001, "lon": -96.838499  ← Addison, TX (postcode_fallback)

node mailwoman/out/cli.js geocode "12 Rue de Rivoli, 75001 Paris" --default-country none
#   "lat": 48.855602, "lon": 2.35995, "resolution_tier": "address_point", "uncertainty_m": 1
```

The probe scripts were scratch instrumentation and are not committed. Each wrapped
`WOFSqlitePlaceLookup.findPlace` and `Resolver.resolveTree` to print queries and opts verbatim,
loaded the classifier once, and looped in-process (a CLI spawn costs ~5.6 s).

## Files

- `resolver/resolve.ts` — `firstPostcodeValue` (120), `#lookupAndPick` country precedence (968-972),
  postcode attachment (981-983), `applyPostcodeConsistency` (261).
- `resolver-wof-sqlite/lookup.ts` — strategy dispatch (351-410), `#postcodeAreaResolution` (528),
  `#fuzzyNameMatch` country filter (632), `#findLocalityCoordFirst` country filter (1034).
- `core/pipeline/runtime-pipeline.ts` — `hardCountryFor` (155-171).
- `mailwoman/geocode-core.ts` — `countryFromPostcodeFormat` (314), the #928 gate (640-667).
- `mailwoman/commands/parse.tsx` — `localeToCountry` (271), `resolverDefaultCountry` (290).
- `mailwoman/commands/geocode.tsx` — `inferredScopeOK` (287).
- `codex/postcode-systems.ts` — `candidateSystemsForPostcode`, and the docstring that says the
  numeric shapes cannot be split.
