# Postcode-country coherence: the default-on evidence

**Date:** 2026-08-05 · **Issue:** #42 · **Follows:**
[`2026-08-04-postcode-country-coherence.md`](./2026-08-04-postcode-country-coherence.md) · **Status:** evidence
complete; the flip is the operator's call.

The landing record shipped `postcodeCountryCoherence` opt-in and named two gaps that stood between it and default-on:

1. **The gauntlet had no resolver-lever pin.** The D-rule's standard instrument could swap the model under test but not
   the resolver configuration, so a resolver lever could only ever be argued from bespoke probes.
2. **Every scale number was candidate-backend**, while the FTS backend's exact-match tier demonstrably differs (it does
   not fold `ü`→`u` — the `München` row).

This record closes both, adds the coverage bound the landing record flagged in passing, and reports two defects the
work turned up on the way.

---

## 1. Gap (a): the gauntlet pin

### 1.1 What landed

`mailwoman eval gauntlet --postcode-country-coherence`, threaded through all three layers.

The pin mirrors the model-swap idiom rather than inventing a parallel one. `GauntletResolverLevers` (`harness.ts`) sits
beside `modelPath`/`tokenizerPath`/`weightsCacheRoot` in the same `buildGauntletDeps` options object; each field maps
1:1 onto a `geocodeAddress` dep of the same name, exactly as `eval oa-resolver`'s `adminCoherence` /
`postcodeCountryCoherence` pins do. `layerDepsOptions` (`regression.ts`) builds that object once for every layer — the
metamorphic layer had been carrying its own copy of the model-selection ladder, which is the shape that drifts.

Three properties are deliberate:

- **An unset flag stays unset.** Pastel hands the schema's `false` default to the command, and forwarding it verbatim
  would pin the lever OFF forever — so the day the library default flips to ON, the standard gate would silently keep
  grading the old configuration. Only the ON pin is forwarded; "no flag" means "grade whatever production does".
- **Every run states its configuration**, pinned or not: `resolver levers: (none pinned — production defaults)` or
  `resolver levers: postcodeCountryCoherence=ON`, on the combined verdict block and in each layer's build banner. Two
  gate logs that differ only in a flag someone typed are not evidence about that flag unless each log says what it
  graded.
- **The pass reports its own firing count.** `GeocodeResult.postcode_country_scope` carries the country the walk was
  re-scoped to (null whenever nothing was overridden), and the regression layer prints
  `postcode-country coherence fired on N/M cases`.

Tests: `mailwoman/eval-harness/gauntlet/lever-pin.test.ts`, 16 assertions over the mapping
`run options → layer options → geocode deps`, including every model-selection ladder and the unpinned control. They
assert a mapping on purpose — the gate itself needs the shard set and a loaded ONNX, and the failure this surface
exists to prevent is silent: a dropped pin does not throw, it produces a gate log identical to the unpinned one.

### 1.2 The first run, and why the pin alone was not enough

Pinned against the corpus as it stood:

```
postcode-country coherence fired on 0/116 cases
```

The two runs were otherwise byte-identical. That is the 2026-08-04 oa-resolver trap wearing a different hat — an
unchanged verdict from a mechanism that never ran is not evidence of anything.

The cause is structural, not incidental. The pass is inert without a `defaultCountry`, and the curated corpus carried
**exactly one** case with one (`fr-lyonnais-3-bare-country-bias`, an FR address under `FR`, where the pass exits at
step 1 by design). The corpus had no case in which a country prior is in tension with the address it is applied to —
which is precisely the defect #42 exists to fix, so the gate could not have seen the lever no matter how it was pinned.

### 1.3 The corpus extension

Seven cases, all measured through the compiled CLI on 2026-08-05 against the 2026-08-04 gazetteer:

| id                     | input                                 | default | status              | why it is here                                           |
| ---------------------- | ------------------------------------- | ------- | ------------------- | -------------------------------------------------------- |
| `us-addison-zip-75001` | `4900 Airport Pkwy, Addison TX 75001` | US      | pass                | ZIP 75001 IS Addison TX — the literal collision          |
| `us-paris-tx-75460`    | `2025 Clarksville St, Paris TX 75460` | US      | pass                | the real Paris, Texas, with its real ZIP                 |
| `us-berlin-nh-03570`   | `45 Main St, Berlin NH 03570`         | US      | pass                | US town, German capital's name, DE-shaped 5-digit code   |
| `us-athens-ga-30601`   | `1 Broad St, Athens GA 30601`         | US      | pass                | same trap with a country's capital for a name            |
| `fr-rivoli-us-scoped`  | `12 Rue de Rivoli, 75001 Paris`       | US      | improvement\_target | the case the mechanism was built for                     |
| `gb-downing-us-scoped` | `10 Downing Street, London SW1A 2AA`  | US      | improvement\_target | London, Ohio under a US default                          |
| `de-linden-us-scoped`  | `Unter den Linden 77, 10117 Berlin`   | US      | improvement\_target | Berlin, Connecticut — pairs against `us-berlin-nh-03570` |

The four adversarial rows are gated (`status: pass`): they must hold with the lever pinned either way, and they are the
"zero newly-failing cases" bar with teeth. The three rescue rows are `improvement_target`: they fail today, which is the
point — they ARE the defect — and under the pin they pass, which the runner's anti-rot loop reports as
"now PASSES — promote to status=pass". That is what a default-on flip should look like from inside the gate.

`us-berlin-nh-03570` and `de-linden-us-scoped` are the pair worth reading together: same city name, same 5-digit shape,
same US default, opposite correct answers. Nothing about the name or the shape separates them. The geometry does.

### 1.4 The verdicts

Both legs, same corpus (137 cases, 68 gated), same model (`model.onnx` md5 `c968c24a`), same backend (the candidate
table, which is what `createResolverBackend` picks when one is present).

**Lever unpinned — `mailwoman eval gauntlet`:**

```
=== Gauntlet · regression (65/68 gated cases pass, 68 tracked) ===
  ✗ si-sentinel-apace "Apače 108, 2324 Apače": coord 1040.49km off (tol 25000m); locality "null" ≠ "Apače"
  ✗ de-r9-nippes-koeln "Neusser Str. 12, Nippes, 50733 Köln": street "Neusser Str" ≠ "Neusser Str."
  ✗ us-subvenue-googleplex-building "Building 43, Googleplex, 1600 Amphitheatre Parkway, Mountain View, CA 94043": street "Amphitheatre Parkway" ≠ "Amphitheatre"

verdict: FAIL

=== Gauntlet · metamorphic ===
  INV  (label-preserving, ≤1m):  63/63 held, 0 known-xfail
  DIR  (drop-postcode, ≤5km):    3/3 held
  BAND (corrupting, ≤5km):       18/21 held, 3 known-xfail

verdict: PASS (with 3 tracked xfails)

════════════════ GAUNTLET ════════════════
  resolver levers: (none pinned — production defaults)
  ✗ FAIL  regression
  ✓ PASS  metamorphic

VERDICT: FAIL — do not ship
```

**Lever pinned — `mailwoman eval gauntlet --postcode-country-coherence`:**

```
=== Gauntlet · regression (65/68 gated cases pass, 66 tracked) ===
  ✗ si-sentinel-apace "Apače 108, 2324 Apače": coord 1040.49km off (tol 25000m); locality "null" ≠ "Apače"
  ✗ de-r9-nippes-koeln "Neusser Str. 12, Nippes, 50733 Köln": street "Neusser Str" ≠ "Neusser Str."
  ✗ us-subvenue-googleplex-building "Building 43, Googleplex, 1600 Amphitheatre Parkway, Mountain View, CA 94043": street "Amphitheatre Parkway" ≠ "Amphitheatre"

postcode-country coherence fired on 2/137 cases:
  · fr-rivoli-us-scoped "12 Rue de Rivoli, 75001 Paris" → country scoped to FR (case default US)
  · de-linden-us-scoped "Unter den Linden 77, 10117 Berlin" → country scoped to DE (case default US)

⚠ tracked cases that now PASS — promote to status=pass:
  + fr-rivoli-us-scoped [improvement_target #42] now PASSES — promote to status=pass
  + de-linden-us-scoped [improvement_target #42] now PASSES — promote to status=pass

verdict: FAIL

=== Gauntlet · metamorphic ===
  INV  (label-preserving, ≤1m):  63/63 held, 0 known-xfail
  DIR  (drop-postcode, ≤5km):    3/3 held
  BAND (corrupting, ≤5km):       18/21 held, 3 known-xfail

verdict: PASS (with 3 tracked xfails)

════════════════ GAUNTLET ════════════════
  resolver levers: postcodeCountryCoherence=ON
  ✗ FAIL  regression
  ✓ PASS  metamorphic

VERDICT: FAIL — do not ship
```

**Both legs FAIL, on the same three cases, for reasons that have nothing to do with this lever.** That is the baseline
of a freshly-rebuilt corpus on today's `main`, and it is stated first so the rest is readable:

- `si-sentinel-apace` was already failing before any of this work (it failed in the first pinned/unpinned pair too,
  against the stale artifact). Standing watch item.
- `de-r9-nippes-koeln` and `us-subvenue-googleplex-building` are cases that had **never been graded**: they live in the
  seed but not in the built artifact, and rebuilding surfaced them. Both are one-token street-span mismatches
  (`Neusser Str` vs `Neusser Str.`, `Amphitheatre Parkway` vs `Amphitheatre`), not resolution failures.

### The case-level diff, in full

The complete difference between the two runs, `diff` on stdout, is five lines of content:

| case                   | unpinned                                          | pinned               | reading                                         |
| ---------------------- | ------------------------------------------------- | -------------------- | ----------------------------------------------- |
| `fr-rivoli-us-scoped`  | coord 7922.55 km off, tier admin ≠ address\_point | **PASSES**           | rescued — the Rivoli case, scoped to FR         |
| `de-linden-us-scoped`  | coord 6240.20 km off, tier admin ≠ address\_point | **PASSES**           | rescued — scoped to DE, reaches the OSM rooftop |
| `gb-downing-us-scoped` | coord 6240.45 km off                              | coord 6240.45 km off | UNCHANGED — see below                           |
| every other case       | —                                                 | identical            | 134 cases, byte-identical                       |

**Newly-failing cases: zero.** All four adversarial rows pass in both legs, and pass by the cheap exit — the pass never
proposes a foreign country for Addison TX, Paris TX, Berlin NH or Athens GA, which is visible in the firing list
containing only the two rescues.

**`gb-downing-us-scoped` does not move, and the reason is a finding.** Under the **en-GB weights overlay** — which the
gate selects for GB cases, and which production's locale gate also routes to — `10 Downing Street, London SW1A 2AA`
parses as `region: SW1A` + `unit: 2AA`. There is no postcode node, so the coherence pass is inert by construction. The
landing record's hand-probe showed this row FIXED because the CLI probe ran the base en-US classifier, which parses the
same string's postcode correctly. Measured both ways on 2026-08-05:

```
en-GB overlay, --postcode-country-coherence:  39.893623,-83.437532  (London, Ohio)   postcode: null   unit: "2AA"
base en-US,    --postcode-country-coherence:  51.500526,-0.109401   (London, GB)     postcode: "SW1A 2AA"
```

So the GB half of the defect has a second blocker — a GB postcode parse under the overlay — that #42 cannot reach.
This is exactly the class of thing a bespoke probe hides and the standard instrument surfaces, which is the argument
for the pin existing at all.

---

## 2. Gap (b): the FTS-backend scale legs

Same panels as the landing record (OpenAddresses US 10,000 · OpenAddresses FR 3,000 · OSM GB 1,000), same two regimes,
same regime classifier, re-run through one probe pointed at either backend so the two tables are comparable line for
line: `mailwoman/dev-tools/postcode-coherence-scale.run.ts <panel> <fts|candidate>`.

The FTS leg uses the PRODUCTION shard set — `wofShardPaths()`, the five shards a shipped default would see — not a
hand-picked list.

### 2.1 Domestic leg — the address's own country as the default. Any override is a border crossing.

| panel                       |      n | fell through (FTS) | overrides (FTS) | FP (FTS) | fell through (cand.) | overrides (cand.) | FP (cand.) |
| --------------------------- | -----: | -----------------: | --------------: | -------: | -------------------: | ----------------: | ---------: |
| OpenAddresses US under `US` | 10,000 |          **1,014** |           **0** |    **0** |                1,082 |                 0 |          0 |
| OpenAddresses FR under `FR` |  3,000 |             **68** |           **0** |    **0** |                   37 |                 0 |          0 |
| OSM GB under `GB`           |  1,000 |            **128** |           **0** |    **0** |                  121 |                 0 |          0 |

### 2.2 Rescue leg — a deliberately mis-scoped default. An override back to the panel's country is the win.

| panel                       |      n | rescued (FTS)     | FP (FTS) | rescued (cand.) | FP (cand.) |
| --------------------------- | -----: | ----------------- | -------: | --------------- | ---------: |
| OpenAddresses FR under `US` |  3,000 | **2,932 (97.7%)** |    **0** | 2,963 (98.8%)   |          0 |
| OSM GB under `US`           |  1,000 | **872 (87.2%)**   |    **0** | 879 (87.9%)     |          0 |
| OpenAddresses US under `FR` | 10,000 | **8,986 (89.9%)** |    **0** | 8,918 (89.2%)   |          0 |

**Across all six FTS legs — 28,000 pair evaluations, three countries, both mis-scope directions — the false-positive
count is 0. The per-case list is empty; there is no case to report.**

### 2.3 Reading the two tables together

- **The candidate-backend column reproduces the landing record to the row** (1,082 / 37 / 121 fell through; 8,918 /
  2,963 / 879 rescued). The two measurements were taken by different code four days apart, so the probe is measuring
  what the earlier one measured.
- **The backend difference is real but small, and it does not point one way.** FTS is STRICTER on FR (68 fell through
  vs 37) and GB (128 vs 121) — its exact-match tier admits fewer same-named localities, so more domestic pairs miss the
  cheap exit — and LOOSER on US (1,014 vs 1,082). The `München` asymmetry the landing record found by hand is the FR/GB
  direction of this, visible at scale.
- **Fall-through moves the recall, never the precision.** In all six FTS legs, rescued equals the domestic
  coherent-default count exactly (2,932 / 872 / 8,986), the same identity the candidate legs showed. The mechanism
  rescues precisely the set of pairs whose geometry is resolvable at all and abstains on the rest, on both backends.
  Its ceiling is the gazetteer's; its error rate is zero in 56,000 pair evaluations across the two backends.
- **The fell-through column is what makes the zero mean something.** 1,210 domestic FTS rows did NOT take the cheap
  exit; for each, every other country the postcode shape allows was tried and refuted by the locality test.

### 2.4 What the regime classifier over-counts

Unchanged from the landing record, restated because both tables depend on it: the coherent-default split is derived by
re-running the pass with an impossible default (`ZZ`), which forces step 1 to fail and reports what the alternatives
alone decide. A pair coherent in TWO countries reads as "fell through" under that probe although the real leg would
have exited cheaply. The column therefore claims MORE at-risk rows than there were — the safe direction for the
argument it supports.

---

## 3. The coverage bound

Where can default-on matter at all? Two numbers per country, because either alone misleads: rows present, and rows
REACHABLE through the lookups the pass itself makes. Measured with
`mailwoman/dev-tools/postcode-coherence-coverage.run.ts <fts|candidate>`.

The candidate set is bounded by codex, not by the gazetteer — `candidateSystemsForPostcode` knows eight systems, so a
country with no codex slice can never be proposed however many rows it holds. These eight are therefore the whole
universe:

| system | country | postcode rows (FTS) | reachable (FTS) | postcode rows (cand.) | reachable (cand.) |
| ------ | ------- | ------------------: | --------------- | --------------------: | ----------------- |
| us     | US      |              42,318 | yes — 0.3 km    |                39,640 | yes — 0.3 km      |
| de     | DE      |              29,713 | yes — 2.0 km    |                24,452 | yes — 2.0 km      |
| fr     | FR      |              27,119 | yes — 0.8 km    |                24,575 | yes — 0.8 km      |
| gb     | GB      |           1,839,678 | yes — 1.3 km    |             1,839,630 | yes — 1.3 km      |
| ca     | CA      |               **0** | **no**          |               843,739 | yes — 2.2 km      |
| au     | AU      |               **0** | **no**          |                 3,171 | yes — 0.7 km      |
| jp     | JP      |               **0** | **no**          |                 **0** | **no**            |
| nz     | NZ      |               **0** | **no**          |                 **0** | **no**            |

"Reachable" is the pass's own verdict on a real pair for that country (`75001`/Addison, `10117`/Berlin, `75001`/Paris,
`SW1A 2AA`/London, `M5V 3L9`/Toronto, `2000`/Sydney, `100-0001`/Chiyoda, `6011`/Wellington), with the distance it
measured.

**So the mechanism can speak for four countries on the production shard set and six on the candidate table.** The
M5V 3L9 abstention the landing record recorded is the CA row here, and it is a shard-set fact: the FTS set carries zero
CA postcode rows while the candidate table carries 843,739. JP and NZ are unreachable on both — a codex slice with no
postcode data behind it.

Two consequences worth stating plainly:

- Default-on changes nothing outside those countries. Everywhere else the pass finds no candidate country and abstains,
  at the cost of the lookups it already spends.
- The two backends do not have the same reach, so a default-on flip has a different footprint depending on which
  gazetteer is attached. `createResolverBackend` prefers the candidate table whenever one is present (the shipped
  default), so the six-country footprint is the common case and the four-country one is the fallback.

---

## 4. Two defects found on the way

**The committed regression corpus could not be built and run.** Rebuilding `regression.db` from its own seed and
running the gate throws:

```
Error: expect_components key "unit" has no GauntletResult mapping — extend componentOf
```

The sub-venue cases added 2026-08-01 assert a `unit` component; no result field ever carried one, and `componentOf`'s
unknown-key throw (added the same day, deliberately loud) kills the whole regression layer. The corpus had been
ungradeable since the day those cases landed — the only thing hiding it was that the built artifact in the data root
was older than the seed. Fixed here the same way `venue` was fixed in August: `GeocodeResult.unit` carries the parsed
span, `componentOf` maps it, and the API schema drift guard is updated in step.

**The built artifact drifts from its seed silently.** The shared `regression.db` held 116 cases against a seed of 130.
Nothing warns; a case can sit committed and ungraded indefinitely. Not fixed here — it wants its own ticket (a
build-stamp comparison at layer start would do it).

---

## 5. Recommendation

**The D-rule evidence now supports default-on.** Both named gaps are closed, and neither closed with a surprise.

The D-rule asks one question — does this default-on mechanism carry a known regression against the shipped model on
any tier-1 locale? The answer is measured, not argued:

- **Gauntlet, the standard instrument, both ways: zero newly-failing cases.** 65/68 gated cases pass with the lever
  pinned and with it unpinned; the three failures are identical, pre-date this work, and are unrelated. The full diff
  between the two runs is two rescues and a banner line.
- **The mechanism ran.** 2/137 cases fired, both correctly, and the four adversarial rows that would break first were
  untouched by the cheap exit. This is the column that was missing from the first attempt, where an identical verdict
  meant only that the corpus could not see the lever.
- **56,000 pair evaluations across both backends, zero false positives.** 28,000 on FTS (new) and 28,000 on the
  candidate table (reproducing the landing record to the row). 1,210 domestic FTS rows and 1,240 domestic candidate
  rows fell past the cheap exit and had every alternative country tried; every one was refuted.
- **The backend dependence is measured and small.** FTS is stricter on FR/GB and looser on US; it moves the RESCUE rate
  by 0.7–1.1 points and the false-positive count by nothing. The `exactMatch` disagreement the landing record flagged
  is real and it costs recall, not precision.

Three conditions attach, none of them blocking:

1. **The corpus must be rebuilt for the gate to see any of this.** `mailwoman eval gauntlet-build regression-db` — the
   seven cases here exist only in the seed until it runs, and the `unit` fix in §4 is required for the rebuilt corpus
   to run at all.
2. **On the flip, promote the two rescue rows.** The gate already says which (`fr-rivoli-us-scoped`,
   `de-linden-us-scoped`); leaving them at `improvement_target` after the default changes turns a gated guarantee into
   a tracked note.
3. **Read the win rate correctly.** The rescue leg simulates a UNIFORMLY mis-scoped default — the demo/CLI reality
   (locale `en-US` → `US` on every query) but not traffic that already carries a correct country. The claim the
   numbers support is "when the default is wrong, this fixes ~9 in 10 of them and breaks none", not "this improves
   9 in 10 addresses".

What default-on does NOT fix, so the flip is not oversold: `gb-downing-us-scoped` stays broken because the en-GB
overlay does not parse the GB postcode (§1.4); JP and NZ have codex slices and no postcode data (§3); CA and AU need
the candidate table (§3); and the coarse placer still cannot override `defaultCountry` even at 0.9999908844 confidence,
which the landing record already flagged for its own ticket.

---

## 6. Reproducing this

```bash
# Gap (a) — the gate, both ways. Rebuild the corpus first: the committed seed carries
# seven cases the built artifact does not.
mailwoman eval gauntlet-build regression-db
mailwoman eval gauntlet
mailwoman eval gauntlet --postcode-country-coherence

# Gap (b) — the scale legs, per panel and backend.
node mailwoman/dev-tools/postcode-coherence-scale.run.ts us fts
node mailwoman/dev-tools/postcode-coherence-scale.run.ts us candidate   # …and fr, gb

# The coverage bound.
node mailwoman/dev-tools/postcode-coherence-coverage.run.ts fts
node mailwoman/dev-tools/postcode-coherence-coverage.run.ts candidate
```

The gauntlet runs behind this record used a private data-root overlay (every entry of `$MAILWOMAN_DATA_ROOT` symlinked
except `gauntlet/`, which was a real directory) so the shared `regression.db` was never written. Anyone reproducing
this in the primary checkout rebuilds the artifact in place instead.
