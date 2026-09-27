# The semantic observation route in production — the integration decision

**Date:** 2026-08-27 · **Status:** decision of record · **Issue:** #1966 · **Epic:** #1916 (program
parent #1680) · **Decides:** stop condition 2 of
[`2026-08-26-geographic-model-boundaries.md`](./2026-08-26-geographic-model-boundaries.md), for the
route merged in PR #1955 and given GO on #1930.

**Sequenced against:** #1960/PR #1969 (the measurement surface), #1962 (recognition), #1963
(semantics), #1965 (absence observations), #1967 (the phase-2 ruler this record supplies the bar
for).

Stop condition 2 says a large downstream phase needs a concrete product requirement supported by its
own evidence, and that a recorded GO does not count as one. This record supplies that requirement and
states how strong the evidence is. It decides the surface, the dependency direction, the default
posture, the bar any default change must clear, and the rollback plan. It implements no code.

Two measurements were taken while writing it. Both can be reproduced from §11, and both changed the
decision. The first is reassuring: over **9,324 distinct committed inputs**, the route as merged
changes **zero** subject matches. The second shows a defect: with the wave-1 semantics that the
boundary record's §4.1 already admits, the route hands `matchPOISubject` two categories, and
alphabetical order decides which one it takes.

---

## 0. The decision

1. **The product requirement is admitted**, and it is a requirement about a capability the system
   does not have rather than about a volume of traffic it receives (§2).
2. **The consuming surface is `createRuntimePipeline`'s existing `poiSemanticLookup` option**,
   consulted last and supplying positive evidence only. This record freezes the order PR #1955
   established (§3.1).
3. **The dependency direction is `mailwoman` → `@mailwoman/geographic-model`, and no other dependency.**
   The boundary record's §6 constraint on `@mailwoman/core` is **left standing, unamended** (§3.2,
   §10). The `devDependency` becomes a real dependency only in a change published by the same
   coordinated release that moves `@mailwoman/geographic-model` off `0.0.0` (§3.3).
4. **The default posture is off, and this record does not authorize a default change.** The D-rule
   allows three options for a mechanism with unmeasured effect on a tier-1 locale: repair it, admit
   it per locale, or ship it opt-in. This record takes the third (§4).
5. **A supported opt-in surface is authorized**, conditional on the four prerequisites in §8. Two of
   them are defects this record's own measurements found, and both take effect as soon as #1963
   lands (§1.4).
6. **§5 lists the bar for any future default change**, including two measurements that do not exist
   today. #1967's ruler must contain it.
7. **If the phase-2 evidence lands at diagnostic strength**, the admissible outcome is the
   observation-only surface in §7. That surface puts provenance on the wire without changing the
   query kind, and the recognition route stays opt-in indefinitely.

---

## 1. What is known, and over what denominator

### 1.1 The capability the shipped path lacks

Committed data attests this half, and it does not depend on the probe at all.

The committed category lexicon matches exact phrases over venue nouns. The boundary record's §5.2 ran
nine queries through the shipped `matchPOISubject` against the shipped `poiTaxonomyLookup`. Every
activity phrasing returns `NO SUBJECT MATCH`, `createScorePOIQuery` returns `0`, and the input leaves
the POI branch entirely. The system answers an activity query by parsing the sentence as an address.
The miss is structural rather than a lexicon omission. Locale-normalized matching folds diacritics
over the same phrase index, and the one-edit typo path needs a length difference of at most 1 against
an existing phrase.

The type system rules out repairing this inside `@mailwoman/poi-taxonomy`, and the layer's contents
show why. `SynonymEntry.categoryID` is a **single** id, while the set of kinds affording an activity
is plural and depends on the country. On the shipped `poi.db` (manifest `2026-07-22.0`), **7,168 of
the 89,336 rows** under the two pharmacy-adjacent Overture leaves sit under `retail > drugstore` and
are structurally unreachable from the shipped `pharmacy` query. That is 8.0% overall, 12.9% within the
US, and a measured zero in FR.

This requirement is supported by committed evidence and holds regardless of whether any probe ran.

### 1.2 What the recorded GO measured, and over what

The probe used four target rows and six controls. Targets moved from 0/4 to 3/4, routing moved from
1/4 to 4/4, and controls passed 6/6 with zero regressions. The frozen ruler maps that to GO, and the
operator recorded it on 2026-08-26.

The denominators matter most here. The boundary record's §5.1 labels the four target rows as
**synthetic**. They are the venue-noun controls with the noun replaced by an activity phrase, and the
anchors are copied byte-for-byte so only the subject varies. Recognition rests on ten authored
phrases whose provenance opens with `AUTHORED FOR ONE EXPERIMENT`, and four of the ten are the
registered target phrasings. The controls are six POI queries, three of which are the venue-noun form
of the same intent at the same anchors.

The project's standing caution about hand-authored boards applies here too: a board over-represents
the class it was written for. #1748 shows the effect, with 4.4% on the board it was authored against
and 0.2% on the real panel. The boundary record's §5.5 states the same bound in advance for this
probe.

### 1.3 What no measurement covers

Three things are unmeasured. Each is stated here so that nobody later reads it as a null result.

- **Prevalence.** No committed input set holds an activity-shaped query that predates the probe
  (§5.5's first bound), and the repository has no traffic census. The rate at which real callers type an
  activity-phrased POI query is **unknown** rather than zero.
- **Recognition breadth.** Of the ten phrases, four are registered and six were never graded against
  anything. §11's positive control shows two of the six ungraded phrasings, "purchase medicine" and
  "collect a prescription", firing and claiming a subject. Breadth is untested by design and belongs
  to #1962.
- **The 3/4 ceiling is structural.** This route cannot reach `sem-act-fr-01` without changing which
  anchor split wins on the default path. A POI literally named `Somewhere` in the shipped `poi.db`
  claims the prefix before the space-delimited "near" separator is considered. #1930's caveat 1 and
  #1039 both record it. No semantics change can fix that.

### 1.4 Two defects the measurements found, both live the moment #1963 lands

Both defects were reproduced by running code.

**(a) A plural affordance collapses to one by code-point order.** The affordance edge exists because
an activity is afforded by a **set** of kinds, which is §5.3's argument for why a synonym table
cannot hold it. The query surface cannot hold a set either, and it narrows the set without reporting
it:

- `reachKinds` returns every affording concept sorted by concept id, code point ascending.
- The route pushes one `POIPhraseMatch` per reached kind, in that order.
- `matchPOISubject` returns `hits[0]!` at both of its return points.
- `POIIntent`'s evidence is `{ kind: "category"; categoryID: string; matched: string }` — one id.

A simulation added the wave-1 `drugstore` concept exactly as §4.1 admits it (`strongly_expected`,
`countries: ["US"]`) to the committed artifact:

```text
route identity: reachableCategoryIDs ["drugstore","pharmacy"]

"where can i pick up a prescription near Denver CO"
  rung returns, in order: drugstore, pharmacy      matchPOISubject takes: drugstore
"prescription near Toulouse"
  rung returns, in order: drugstore, pharmacy      matchPOISubject takes: drugstore
"prescription near Paris"
  rung returns, in order: drugstore, pharmacy      matchPOISubject takes: drugstore

observations recorded for one query: 2
  concept=drugstore  category=drugstore  modality=strongly_expected  mappedKindCount=2
  concept=pharmacy   category=pharmacy   modality=necessary          mappedKindCount=2
```

`drugstore` wins because `d` precedes `p`. In the US, alphabetical order makes the class reaching
6,679 rows win over the class reaching 44,945, and the `strongly_expected` assertion win over the
`necessary` one. The route's own `SemanticObservation` docstring says that a `mappedKindCount` above
one is a finding for the decision record to resolve rather than the route. This is that record, and §8.1
decides it.

**(b) The assertion's country scope is never read.** `RelationAssertion.countries` exists in the
schema, but `reachKinds` filters on relation and target only. The injected `lookup` ignores its
`locale` argument entirely, because the parameter is missing from its signature. The US-scoped
drugstore claim above therefore fires for Toulouse and Paris, where §5.3 measured **zero**
`drugstore` rows in the layer. The route would answer a French query with a category the data cannot
serve. Today `mappedKindCount = 1` and no assertion carries `countries`, so the behavior is still
correct. #1963 authors the first scoped assertion, and from then on this is a defect in
production-shaped code.

---

## 2. The product requirement (stop condition 2)

**The requirement is admitted at the strength the evidence supports:**

> A query that names what the user wants to do, in a POI-shaped form, must reach the entity kinds
> that afford it — with the assertion that decided it available to the caller — rather than being
> answered as an address parse of a sentence.

The evidence for the requirement is §1.1, which is committed data and independent of the probe. The
capability is absent, the absence is structural, and the type system rules out the obvious repair.
The evidence for the requirement's **size** is §1.3, which contains no measurement.

That difference decides the posture, and it is the central argument of this record. Shipping an
unreachable capability to the callers who ask for it is defensible. Changing what every caller gets
is a different claim, and it needs a denominator that does not exist. The requirement is therefore
admitted **at opt-in strength**. That is enough to make the route a supported surface, but not
enough to change the default answer for inputs nobody has counted.

The first paragraph of this section satisfies stop condition 2 for the opt-in surface. It does not
satisfy stop condition 2 for a default change.

---

## 3. Surface and dependency direction

### 3.1 The consuming surface

**`createRuntimePipeline`'s `poiSemanticLookup` option, unchanged in position and interface.** The
subject lookup stays three rungs and the order is frozen by this record:

1. `poiTaxonomyLookup` — the committed category lexicon.
2. `poiNameLookup` — the POI name rung, when a `poi.db` is wired.
3. the injected route — **only** where both returned no result.

The route supplies positive evidence only. A miss returns `[]`. The route can add a subject where
there was none, but it can never remove one or displace a committed hit. When the route is absent,
the composition behaves exactly as shipped. This order is fixed under the opt-in posture. Changing
it would change precedence on the default path, which is a separate decision with its own D-rule
obligations.

The route is typed as a plain `POIPhraseLookup`, so the pipeline has no information about where the
evidence came from. The existing executor serves a match exactly as if the category had been typed.
That property keeps the integration point to one optional argument instead of a branch, and this
record preserves it.

**One move is required before the surface is supported.** The builder lives at
`packages/mailwoman/lib/eval-harness/semantic-utility/observation-route.ts`. A consumer must not reach
into an eval harness for a runtime capability, so the builder moves into the `mailwoman` runtime
tree with a real export subpath, and the harness imports it from there. The move must leave the
probe's frozen definition and freeze record unchanged, with an empty diff. #1960 carries the same
obligation.

### 3.2 Dependency direction

**`mailwoman` → `@mailwoman/geographic-model`. The dependency runs in one direction, creates no
cycle, and adds no new fan-out.**

- The POI branch already lives in `mailwoman`: `poi-intent.ts`, `poi-executor.ts`, and the pipeline
  factory itself. `@mailwoman/core` keeps the interface types (`POIIntent`, `POIResult`,
  `POIIntentOutcome`) and no type that would need world semantics.
- `@mailwoman/kind-classifier` calls the lexicon, but the lexicon is **injected** through
  `createKindClassifier({ poiLexicon })`. It needs no dependency either.
- `@mailwoman/geographic-model` already depends on `@mailwoman/poi-taxonomy`, which `mailwoman`
  already depends on. The edge adds one package to `mailwoman`'s graph rather than a subtree.

**The boundary record's §6 constraint stays in force: `@mailwoman/core` may not depend on
`@mailwoman/geographic-model` without a later integration decision.** This record is the later
decision that clause anticipates, and it declines to use the permission. §10 records that in the
terms §6 asks for.

### 3.3 Release sequencing — measured, because the stale reason is still written in the code

The route module's header says `mailwoman` holds no runtime dependency because
`@mailwoman/geographic-model` is outside the release list and "a published `mailwoman` naming it
would name a version no registry carries". **Both parts of that statement are now false**, and the
correction belongs in the same change that moves the module (§8.4).

Measured on 2026-08-27:

| Fact                                       | Value                                                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Root `workspaces` entries                  | 58                                                                                                                                  |
| `.release-it.json` publish list            | 52, and `packages/geographic-model` is one of them (PR #1959)                                                                       |
| npm `@mailwoman/geographic-model` versions | `0.0.0` only, `latest → 0.0.0`                                                                                                      |
| That tarball                               | 51 files, 312,282 bytes unpacked — **36 of them under `out/`**, plus `data/geographic-model.json` and the four authoring JSON files |
| Its dependencies                           | `@mailwoman/poi-taxonomy@9.2.0`, `type-fest@^5.8.0`                                                                                 |
| `mailwoman` version / edge today           | `9.2.0` / `devDependencies: { "@mailwoman/geographic-model": "workspace:*" }`                                                       |

The published `0.0.0` is therefore a functioning package rather than a name reservation. It carries
compiled JavaScript, type declarations and the compiled artifact. The version number, rather than the
contents, is what makes a runtime dependency unsafe **today**. `yarn pack` freezes `workspace:*` to
whatever version the sibling has at pack time. A `mailwoman` packed before the next coordinated
release would pin `0.0.0` permanently, and that version will never be republished once the workspace
is in the bump set. `AGENTS.md` describes the same frozen-workspace hazard from the other side.

**The decision:** the edge moves from `devDependencies` to `dependencies` in the change that ships
the supported surface. That change is not published until the same coordinated release also
publishes `@mailwoman/geographic-model` at the shared version. The workspace is in
`.release-it.json`'s list. That list is both the publish set **and** the bump set. One `yarn release`
therefore does both, and the dependency versions always match. No step here needs a hand-publish, and no step
here permits one.

The dynamic import may stay or go once the edge is real. Publishing no longer requires it. Keeping
it only keeps the artifact reader off the load path for callers who never build a route, which is a
small, separate benefit.

---

## 4. Default posture and admission shape

### 4.1 Default OFF

The D-rule states that no default-on mechanism ships with a known regression against the shipped
model on any tier-1 locale, and that the compliant routes are to repair it, to admit it per locale,
or to ship it opt-in. It also states the obligation that comes with opt-in: a path that is off by
default must ship with tests that turn it on. Otherwise nobody exercises the mechanism, it decays,
and its first real use is also its first execution.

This record takes the opt-in route, for a reason the D-rule's own wording supports. The route changes
which query **kind** is chosen. An input the committed lexicon does not claim currently takes the
address path. With the route on, an input ending in a declared activity phrase takes the POI branch
instead. That change would newly affect every non-POI input carrying such a phrase, and §1.3 says
nobody has counted those inputs. A default change against an uncounted population has no measured
regression, and that is exactly why it is not admissible: the D-rule's bar requires a measurement,
and the lack of a measured regression does not meet it.

§11's census is the first measurement of that population. For the merged route it found **zero
changes over 9,324 committed inputs**. That number is real and reassuring. It also describes only
ten authored phrases and a corpus written for other purposes. #1962 will replace the phrases, and the
corpus limitation will remain.

### 4.2 The admission shape is presence rather than a boolean

**Decided: the caller constructs the route and passes it in. The pipeline has no
`semanticRoute: true` flag.**

A boolean would require the pipeline to construct the artifact reader itself. That would put
`@mailwoman/geographic-model` on the default construction path and give the pipeline knowledge of
where the evidence came from, which are the two properties PR #1955's design avoided. The presence of
the option turns the route on, its absence gives the pipeline that shipped, and the type stays a plain
`POIPhraseLookup`.

**A future default change must add the suppression option before it turns the route on.**
`createRuntimePipeline` already uses this pattern twice: `fst?: … | false` and
`streetMorphology?: … | false`, each documented as the byte-stable override for a mechanism that
became default-on. Any change that makes the route auto-construct must widen `poiSemanticLookup` to
`… | false` in the same commit, with a test that sets it `false` and asserts byte-stability against
the pre-change composition. A rollback option added after the change does not count as rollback (§6).

### 4.3 Locale and country admission

**Decided: the design adds no third scoping mechanism. The two existing mechanisms provide admission
control, and both must work before the surface is supported.**

- **Recognition is locale-scoped at the phrase.** #1962's lexicon scopes each entry to its locales,
  following the `@mailwoman/variant-aliases` semantics. `collect a prescription` is a British
  phrasing, and the lexicon records that.
- **Semantics are country-scoped at the assertion.** `RelationAssertion.countries` is the field, and
  §4.1's W1-2 is the first record to use it.

Neither is consulted today (§1.4(b)). A per-locale allow-list on the pipeline option would be a third
place to look for the same answer, and it could hide a mis-scoped assertion. The decision is
therefore to repair the two existing mechanisms rather than add a third, and §8.2 makes that a
prerequisite.

**Amended 2026-09-05 (#1999).** The two scopes apply to different things, and the first
implementation applied both to the caller. Recognition belongs to the caller: a phrase's locale scope
says who uses that wording, so it is checked against the caller's locale. Semantics belong to the
place: an assertion's `countries` says where the establishments it describes exist, so it is checked
against the country the anchor resolved to. The caller's locale determines how the phrase is read. The
anchor's country determines where the condition is true. When both scopes were applied to the caller, an `en-US` caller asking
about Garancières admitted the US-scoped `drugstore` claim into a French search (#1996's receipts,
#1998's three refusals). The route now returns every reached kind with the assertion's scope on the
match (`POIPhraseMatch.countryScope`). `createPOIIntentStage` applies it after the anchor parse and
records the result on the intent (`countryBinding`). It abstains as `country_scope_excluded` when none
of the kinds the phrase reached is valid in that country. An anchor that resolved to no country admits
no scoped claim. §5 row 7 already said "anchored", and the implementation now matches it.

The route's phrase normalization is deliberately locale-independent. It uses `toLowerCase` rather
than `toLocaleLowerCase`, so a Turkish host locale cannot make the same query answer differently on
two machines. That property is separate from locale scoping and stays as it is.

---

## 5. The bar for any default change

Every row must be run and reported in the same decision package, on one pinned set of artifacts.
A result for one row cannot be inferred from another.

| #     | Check                              | How                                                        | Bar                                                                                                                                                                                                                                                                                         |
| ----- | ---------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | The promoted POI board family      | `mailwoman eval poi-board --enforce`                       | The three reachable rows at `status: pass` and **counted** rather than tracked; `sem-act-fr-01` no worse than its committed `known_fail`; all three floors met over the re-registered composition, arithmetic stated                                                                        |
| **2** | The full regression board          | `mailwoman eval gauntlet` — regression **and** metamorphic | No new violation beyond the tracked expected failures, in either layer                                                                                                                                                                                                                      |
| **3** | The five conformance laws          | `mailwoman eval conformance`                               | Every decided row holds; tracked and unmeasured counts unchanged or reduced. **Plus new rows**: the route normalizes NFKC, case and whitespace, so the case-folding, whitespace and punctuation laws each have a claim to make about an activity phrase and no committed row makes it today |
| **4** | The parse promotion eval           | `mailwoman eval promote`                                   | **The D-rule.** No regression against the shipped model on any tier-1 locale. Measured on the address side: a query-kind change moves inputs off the address path, and the POI board cannot see that                                                                                        |
| **5** | The false-claim census             | §11's instrument, re-run at the shipping phrase lexicon    | Zero subject-match changes on the board's address-guard rows; every change elsewhere adjudicated row by row. The positive control reported in the same run — a census that cannot detect a change reports the same zero as a real absence                                                   |
| **6** | Multi-kind adjudication            | A test over an activity with two afforded kinds            | `mappedKindCount > 1` answered without an authored preference (§8.1). A default change while `hits[0]` decides by code point is refused outright                                                                                                                                            |
| **7** | Country admission                  | A row anchored outside an assertion's `countries`          | The route stays silent there, and the receipt says which scope refused it                                                                                                                                                                                                                   |
| **8** | Artifact identity on every receipt | —                                                          | `poi.db` manifest version, weights version, resolver backend, `modelVersion`, phrase-lexicon id and version. An arm label is not a measurement of what ran                                                                                                                                  |
| **9** | The recorded phase-2 decision      | #1967                                                      | The ruler contains rows 1–8; both arms run; the operator records the verdict                                                                                                                                                                                                                |

Two of those nine rows measure something nobody has measured yet. Row 5 exists only as this record's
instrument, and rows 6 and 7 have no committed rows at all. They are listed here so #1967's
pre-registration includes them from the start.

**What the bar deliberately omits:** a prevalence number. If one becomes available, it strengthens
the requirement in §2, and this record is amended to say so. A missing prevalence number is not a
check that can be waived. It is the reason for the current default posture.

---

## 6. Rollback

**While opt-in.** Rollback means removing the argument at the one call site. A consumer who never
passed `poiSemanticLookup` is unaffected by any of this program's work, which is what the opt-in
posture guarantees. Nobody needs to republish anything.

**After a hypothetical default change.** The suppression option must exist before the change:
`poiSemanticLookup: false`, added in the same commit with its own test (§4.2). If rolling back a
default change requires a patch release, the change has no real rollback.

**Data rollback.** Two versioned artifacts change independently: the compiled model (`modelVersion`)
and the phrase lexicon (`tableID` + `version`). Every receipt carries both, so a rollback can identify
which one changed. To revert a wave of semantics, revert the committed artifact and rebuild it
deterministically. To revert a recognition regression, revert the lexicon. Neither requires changing
the route.

**Release rollback.** `mailwoman` and `@mailwoman/geographic-model` bump together in the same
coordinated release (§3.3), so a revert is a coordinated patch release of both. Reverting only one
would recreate the version skew the release list exists to prevent.

---

## 7. What diagnostic-strength evidence would justify instead

If #1967's phase-2 measurement misses its resolution threshold but clears a pre-registered
structured diagnostic threshold, the admissible outcome is **the observation surface without the
recognition change**. This record defines that outcome now so it is not improvised under pressure
later.

Today the provenance the program is built around does not reach a caller. `semanticObservations[]`
appears only under `packages/mailwoman/lib/eval-harness/semantic-utility/`. The route hands the
observations out through a `takeObservations()` drain that the harness owns, and `POIIntentOutcome`
has no field for them. A consumer of `createRuntimePipeline` gets the category and none of the
authority behind it.

An existing interface fits this need. `QueryKindResult.intentMarkers` carries `QueryIntentMarker`,
whose docstring states that a marker never changes which answer wins. A marker is additive and
attributed, and it always accompanies the ordinary result. Its `mechanism` field records the rule
that produced it in a `family:rule` form, and its `evidence` field carries the measurement so the
marker can be audited. `QueryIntentCode.POICategory` already exists for a query that resolved to a
POI category.

The diagnostic-strength surface therefore works as follows. The semantic observation travels as a
`QueryIntentMarker` (`mechanism: "semantic:affords"`, with `evidence` carrying the assertion id,
modality, mapping and both provenance records). The recognition route stays opt-in, and the compiled
artifact keeps growing under the amendment process. A caller can then see on whose authority the
category was chosen, and no behavior changes on the default path. The same plumbing suits the opt-in
surface regardless of the phase-2 verdict, and #1965's absence observations need the same channel.
That is why §8.3 lists it as a prerequisite rather than a fallback.

**A stop-strength outcome**, such as regressing controls or a false-claim census that finds claims
nobody can adjudicate, ends the opt-in surface as well as the default change. The route then returns
to its current state: experiment code behind a frozen pre-registration. The compiled artifact and its
conformance instruments remain as the durable product of the phase.

---

## 8. Prerequisites for the supported opt-in surface

This record authorizes the work below and no other work. Each item needs its own issue, and none
is implemented here.

### 8.1 The plural affordance must be answered without an authored preference

The set-to-one narrowing in §1.4(a) is resolved as follows, and the resolution keeps the program's
architectural boundary intact.

**The POI branch searches the union, and the resolver orders the results.** §3 of the boundary
record assigns candidate ordering to the runtime and resolver, and prohibits the geographic model from
authoring any ordering. Searching every afforded, mapped category and letting the existing candidate
ordering rank the union satisfies both rules. No world-model record states a preference, because the
schema has no field for one. The ordering that decides the answer is the one the system already owns
and already measures.

This requires `POIIntent`'s evidence to carry a set rather than one id. The reader already handles
sets: `resolveOvertureCategories` returns an array per seed id, and `#searchKRing` probes each. The
narrowing happens entirely upstream, at `matchPOISubject`'s `hits[0]` and at
`POIIntent.evidence.categoryID`. Widening it is a runtime change with its own board obligations, and
it is owned outside this program.

**Until that change lands, a plural affordance may not reach the route.** The interim rule is a
construction refusal, like the eight refusals the route already has: a declared phrase whose activity
reaches more than one mapped kind is refused at construction, and the error lists the phrase and the
kinds. A refusal is visible, and an unreported alphabetical winner is not. #1963 lands the first
plural case, so this refusal must exist before #1963 merges. Otherwise the collapse would ship
without anyone seeing it.

**Landed 2026-08-28 (#1980), and the interim refusal is gone.** `POIPhraseMatch` gained one field
that says whether a lookup's several hits are one set to search together or a preference list whose
head is the subject. The committed phrase index keeps the preference-list reading, which belongs to
#1933 and is unchanged. `matchPOISubject` carries the whole set, `POIIntent`'s category subject holds
`categoryIDs`, and the executor probes them in one `#searchKRing` call. The reader's own distance sort
ranks the union, and no stage on the path authors a weight or a per-category preference. W1-3 landed
after it, and the compiled model reads `0.3.0`. At the Coalinga anchor, `pharmacy` returns zero rows,
`drugstore` returns two, and the union answers `drugstore` at 0.77 km.

### 8.2 The two existing scopes must be consulted

`reachKinds` must read `RelationAssertion.countries`, and the route's `lookup` must accept and use its
`locale` argument. Each gap is one missing line today, and no test would detect either. Each needs a
row that stays silent outside its scope, per §5 row 7. This is a prerequisite for #1963 rather than
for the surface, because a scoped assertion authored against a route that ignores scope would mean
something different from what it says.

**Amended 2026-09-05 (#1999).** Both scopes are now consulted, and they apply where §4.3's amendment
says: the locale scope in the route's `lookup`, and the country scope in the POI intent stage against
the anchor's resolved country. The row for §5 row 7 is `abs-c-02` in the absence probe. There, a US
anchor keeps `drugstore`, so the searched set exceeds the surveyed class and the route refuses with
`category_not_surveyed`. It sits beside `abs-t-02`/`abs-t-05`, where a French anchor drops
`drugstore` and the observation fires. The probe registers the searched set per row, so the scope
binding is graded rather than inferred.

### 8.3 Observations must reach the caller

As §7 describes, the semantic observation travels as a `QueryIntentMarker` on
`QueryKindResult.intentMarkers`, with the assertion, the mapping and both provenance records in
`evidence`. Without it, the opt-in surface would serve a category with no authority attached, which is
what this program exists to avoid. #1965's coverage-qualified absence observations need the same path
to the caller.

### 8.4 The builder moves, and its header is corrected

As §3.1 requires, the builder moves out of the eval harness into the runtime tree with a real export
subpath. As §3.3 describes, both parts of its header's release-list reasoning are now false. The
header must be rewritten to state the version constraint that applies rather than the membership
constraint that no longer does. The probe's definition and freeze record must show an empty diff
across the move.

---

## 9. Sequencing

| Issue                       | Relationship to this record                                                                                                                                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#1960 / PR #1969**        | Merges first; it is the measurement surface §5 rows 1 and 5 read. Its three `improvement_target` rows name **this issue** as their blocker, so when #1966 closes they must be re-pointed at the implementation issue §8 authorizes. A tracked row naming a closed issue is a row nobody is holding |
| **#1962** (recognition)     | **Blocks the opt-in surface.** A supported capability may not rest on a table whose provenance reads `AUTHORED FOR ONE EXPERIMENT`. Its per-entry locale scoping is half of §4.3's admission control, and its phrase-collision census is what stops another `Somewhere`                            |
| **#1963** (semantics)       | **Blocked by §8.1 and §8.2.** It lands the first plural affordance and the first country-scoped assertion, and both defects in §1.4 become live at that moment. Its own re-measurement obligation (§4.1's closing paragraph) is unchanged by this record                                           |
| **#1964 / #1965** (absence) | **Independent of the default posture.** Observation-only by construction, blocked on exclusion-grade coverage cells rather than on this record. It shares §8.3's route to the caller and should not build a second one                                                                             |
| **#1967** (phase-2 ruler)   | **Consumes this record.** §5's nine rows are what the ruler must contain; rows 5, 6 and 7 have no committed instruments today and must be built into the pre-registration rather than discovered after the arms run                                                                                |
| **#1039**                   | Owns `sem-act-fr-01`'s structural blocker. Not this program's, and not on the path to the opt-in surface                                                                                                                                                                                           |
| **#1933**                   | Owns the `drugstore`/`pharmacy` retrieval split. §8.1's union search is adjacent to it and must not be mistaken for it. One is which categories a subject reaches, the other is which category a typed phrase reaches                                                                              |

**This record does not authorize a default change, and #1967 alone cannot authorize one.** A default
change needs §5's bar cleared, a recorded operator decision, and, if the bar itself changes, an
amendment here.

---

## 10. The boundary record's §6, addressed

Stop condition 5 requires the boundary to be amended in a reviewed change rather than widened in
passing, and §6's fourth architectural exclusion reserves the `@mailwoman/core` question for "a
later integration decision".

**This is that decision, and §6 stays in force without amendment.** `@mailwoman/core` gains no
dependency on `@mailwoman/geographic-model`, now or as a consequence of anything §8 authorizes. §6's
reason still holds: core ships the pipeline interface and roughly 9 MB of reference data to every
consumer, so every drop-in API would inherit a world-semantics dependency there. §3.2 also shows that
the integration needs no API from core. The POI branch lives in `mailwoman`, and
`@mailwoman/kind-classifier` receives its lexicon by injection.

No other exclusion in §6 changes. Ranking behavior is unchanged, and no authored weight, boost,
penalty or ordering API is introduced. §8.1 explicitly routes the plural case to the resolver's
existing ordering rather than authoring one.

---

## 11. How the numbers here were taken

This section lets a reader re-run the measurements rather than trust them. Both instruments were
temporary scripts, deleted after the run. Each is short enough to rebuild from this description, and
§5 row 5 makes the first one permanent.

**The false-claim census.** Every distinct string in every committed `.jsonl` under
`packages/mailwoman/lib/eval-harness/gauntlet/cases/`, `…/conformance/` (both `base` and `variant`) and
`…/fixtures/`. That is 9,324 distinct inputs: 915 gauntlet cases, 182 conformance, and 8,227
fixtures (BAN FR fragments 2,800, Overture DE fragments 2,404, `no-digits` 2,400, the parity corpora,
the golden sets, the venue confounds, and the 51-row POI board). Each input was passed to
`matchPOISubject` twice with the same locale: once against `poiTaxonomyLookup` alone, and once
against `poiTaxonomyLookup` falling through to the route. The census compared the subject and
category id.

```text
route identity: {"phraseTableID":"semantic-utility-probe-activity-phrases","phraseTableVersion":"1.0.0",
                 "declaredPhrases":10,"modelVersion":"0.1.0","reachableCategoryIDs":["pharmacy"]}
distinct inputs: 9324    gauntlet-cases 915 · conformance 182 · fixtures 8227
subject match changed by the route: 0
```

The same run included a positive control, because an instrument that cannot detect a change reports
the same zero as a real absence:

```text
"where can i pick up a prescription near Denver CO"  (no subject) → where can i pick up a prescription → pharmacy
"prescription near Denver CO"                        (no subject) → prescription → pharmacy
"i need my prescription refilled near Tijuana"       (no subject) → i need my prescription refilled → pharmacy
"purchase medicine near Chicago IL"                      (no subject) → purchase medicine → pharmacy
"collect a prescription near London"                 (no subject) → collect a prescription → pharmacy
```

The last two are declared phrasings no registered row uses, and they claim a subject.

The POI **name** rung is deliberately absent from both arms. It can only claim phrases the route
would otherwise be asked about, so leaving it out can only over-report semantic claims, and a
measured zero is conservative. Adding it needs a `poi.db`, which §5 row 5 should use.

**The wave-1 simulation.** The committed `packages/geographic-model/data/geographic-model.json` was
read and cloned. The clone received one added concept (`drugstore`, `isA: ["establishment"]`) with
one assertion (`affords` → `obtain_medication`, `modality: strongly_expected`, `countries: ["US"]`)
and one `poi-taxonomy` mapping to external id `drugstore`. That is the wave-1 set exactly as §4.1
admits it. The route was built over the modified artifact with
`createSemanticObservationRoute({ model })` and queried through `matchPOISubject`. §1.4 shows the
output.

**Read directly rather than measured.** The release-list and npm figures in §3.3 come from
`.release-it.json`'s workspaces array, `npm view @mailwoman/geographic-model`, and the `0.0.0`
tarball's own file list. The conformance row counts are 189 committed across five files, which is the
182 decided plus 6 tracked plus 1 unmeasured that PR #1955's inertness receipt reports. The board
figures are 51 rows at 96.1% with two pre-existing failures, and PR #1969's proposed 55-row
composition with four tracked. The `poi.db` row counts in §1.1 are the boundary record's §5.3
measurement at manifest `2026-07-22.0`, carried forward. §4.1's re-measurement instruction applies to
them, and that re-measurement is #1963's obligation rather than this record's.
