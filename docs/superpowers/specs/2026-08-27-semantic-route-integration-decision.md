# The semantic observation route in production — the integration decision

**Date:** 2026-08-27 · **Status:** decision of record · **Issue:** #1966 · **Epic:** #1916 (program
parent #1680) · **Decides:** stop condition 2 of
[`2026-08-26-geographic-model-boundaries.md`](./2026-08-26-geographic-model-boundaries.md), for the
route merged in PR #1955 and given GO on #1930.

**Sequenced against:** #1960/PR #1969 (the measurement surface), #1962 (recognition), #1963
(semantics), #1965 (absence observations), #1967 (the phase-2 ruler this record supplies the bar
for).

Stop condition 2 says a large downstream phase needs a concrete product requirement on its own
evidence, and that a recorded GO is not one. This record supplies that requirement, states the
strength the evidence actually carries, and decides the surface, the dependency direction, the
default posture, the bar any default change must clear, and the rollback story. It implements
nothing.

Two measurements were taken while writing it, both reproducible from §11, and both changed the
decision. One is reassuring: over **9,324 distinct committed inputs**, the route as merged changes
**zero** subject matches. One is not: with the wave-1 semantics the boundary record's §4.1 already
admits, the route hands `matchPOISubject` two categories and the one it takes is decided by
alphabetical order.

---

## 0. The decision

1. **The product requirement is admitted**, and it is a requirement about a capability the system
   does not have rather than about a volume of traffic it receives (§2).
2. **The consuming surface is `createRuntimePipeline`'s existing `poiSemanticLookup` option**,
   consulted last, positive evidence only — the order PR #1955 established is frozen by this record
   (§3.1).
3. **The dependency direction is `mailwoman` → `@mailwoman/geographic-model`, and nothing else.**
   The boundary record's §6 constraint on `@mailwoman/core` is **left standing, unamended** (§3.2,
   §10). The `devDependency` becomes a real dependency only in a change published by the same
   coordinated release that moves `@mailwoman/geographic-model` off `0.0.0` (§3.3).
4. **The default posture is OFF, and a default change is NOT authorized by this record.** The D-rule
   admits three routes for a mechanism with unmeasured effect on a tier-1 locale — repair it, admit
   it per locale, or ship it opt-in. This record takes the third (§4).
5. **A supported opt-in surface is authorized**, conditional on the four prerequisites in §8. Two of
   them are defects this record's own measurements found, and both become live the moment #1963
   lands (§1.4).
6. **The bar for any future default change is enumerated in §5**, including two measurements that do
   not exist today. #1967's ruler must contain it.
7. **If the phase-2 evidence lands at diagnostic strength**, the admissible outcome is the
   observation-only surface in §7 — provenance on the wire, no query-kind change — and the
   recognition route stays opt-in indefinitely.

---

## 1. What is known, and over what denominator

### 1.1 The capability the shipped path lacks

This half is attested on committed data and does not depend on the probe at all.

The committed category lexicon is exact-phrase over venue nouns. The boundary record's §5.2 ran nine
queries through the shipped `matchPOISubject` against the shipped `poiTaxonomyLookup`: every
activity phrasing returns `NO SUBJECT MATCH`, `createScorePOIQuery` returns `0`, and the input
leaves the POI branch entirely — an activity query is answered as an address parse of a sentence.
The miss is structural rather than a lexicon omission: locale-normalized matching folds diacritics
over the same phrase index, and the one-edit typo path needs a length difference of at most 1
against an existing phrase.

Repairing it inside `@mailwoman/poi-taxonomy` is refused at the type level, and the layer's contents
say why. `SynonymEntry.categoryID` is a **single** id; the set of kinds affording an activity is
plural and country-conditional. Measured on the shipped `poi.db` (manifest `2026-07-22.0`), **7,168
of the 89,336 rows** under the two pharmacy-adjacent Overture leaves sit under `retail > drugstore`
and are structurally unreachable from the shipped `pharmacy` query — 8.0% overall, 12.9% within the
US, and a measured zero in FR.

That is a requirement statement with committed evidence behind it, and it stands whether or not any
probe had ever run.

### 1.2 What the recorded GO measured, and over what

Four target rows and six controls. Targets moved 0/4 → 3/4, routing 1/4 → 4/4, controls held 6/6
with zero regressions. The frozen ruler maps that to GO, and the operator recorded it on
2026-08-26.

The denominators are what matter here. The four target rows are **synthetic and labeled as such** by
the boundary record's §5.1 — the venue-noun controls with the noun replaced by an activity phrase,
anchors copied byte-for-byte so the subject is the only thing that varies. Recognition rests on ten
authored phrases whose provenance opens with `AUTHORED FOR ONE EXPERIMENT`; four of the ten are the
registered target phrasings. The controls are six POI queries, three of them the venue-noun form of
the same intent at the same anchors.

The standing project reading of a hand-authored board applies to this one as much as to any other:
it over-represents the class it was written for, and #1748 is the worked example — 4.4% on the board
it was authored against, 0.2% on the real panel. The boundary record's §5.5 states the same bound in
advance for this probe.

### 1.3 What no measurement covers

Three absences, each stated so that nobody later reads it as a null result.

- **Prevalence.** No committed input set holds an activity-shaped query that predates the probe
  (§5.5's first bound), and no traffic census exists anywhere in the repository. How often a real
  caller types an activity-phrased POI query is **unknown**, not zero.
- **Recognition breadth.** Ten phrases, four of them registered, six never graded against anything.
  §11's positive control shows two of the six ungraded phrasings — "buy medicine" and "collect a
  prescription" — firing and claiming a subject. Breadth is untested by design, which is #1962's
  scope.
- **The 3/4 ceiling is structural.** `sem-act-fr-01` is unreachable by this route without changing
  which anchor split wins on the default path: a POI literally named `Somewhere` in the shipped
  `poi.db` claims the prefix before the space-delimited "near" separator is considered. #1930's
  caveat 1 and #1039 both record it. No semantics change that.

### 1.4 Two defects the measurements found, both live the moment #1963 lands

Neither is a hypothetical. Both were run.

**(a) A plural affordance collapses to one by code-point order.** The whole reason the affordance
edge exists is that an activity is afforded by a **set** of kinds — §5.3's argument for why a
synonym table cannot hold it. The query surface cannot hold it either, and the narrowing is silent:

- `reachKinds` returns every affording concept sorted by concept id, code point ascending.
- The route pushes one `POIPhraseMatch` per reached kind, in that order.
- `matchPOISubject` returns `hits[0]!` at both of its return points.
- `POIIntent`'s evidence is `{ kind: "category"; categoryID: string; matched: string }` — one id.

Simulated with the wave-1 `drugstore` concept exactly as §4.1 admits it (`strongly_expected`,
`countries: ["US"]`), against the committed artifact:

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

`drugstore` wins because `d` precedes `p`. In the US that is the class reaching 6,679 rows beating
the class reaching 44,945, and the `necessary` assertion losing to the `strongly_expected` one, on
alphabetical accident. The route's own `SemanticObservation` docstring says a `mappedKindCount`
above one is a finding for the decision record rather than something the route resolves. This is
that record, and §8.1 decides it.

**(b) The assertion's country scope is never read.** `RelationAssertion.countries` exists in the
schema, `reachKinds` filters on relation and target only, and the injected `lookup` ignores its
`locale` argument entirely — the parameter is not in its signature. So the US-scoped drugstore claim
above fires for Toulouse and Paris, where §5.3 measured **zero** `drugstore` rows in the layer. The
route would answer a French query with a category the data cannot serve. Today
`mappedKindCount = 1` and no assertion carries `countries`, so nothing is wrong; #1963 authors the
first scoped assertion, and at that moment this is a defect in production-shaped code.

---

## 2. The product requirement (stop condition 2)

**Admitted, and stated at the strength the evidence carries:**

> A query that names what the user wants to do, in a POI-shaped form, must reach the entity kinds
> that afford it — with the assertion that decided it available to the caller — rather than being
> answered as an address parse of a sentence.

The evidence for the requirement is §1.1, which is committed data and independent of the probe: the
capability is absent, the absence is structural, and the natural repair is refused at the type
level. The evidence for the requirement's **size** is §1.3, which is nothing.

That asymmetry decides the posture, and it is worth stating plainly because it is the whole argument
of this record. A capability nobody can reach is a defensible thing to ship for the callers who ask
for it. Changing what every caller gets is a different claim, and it needs the denominator that does
not exist. So the requirement is admitted **at opt-in strength**: enough to make the route a
supported surface, not enough to change the default answer for inputs nobody has counted.

Stop condition 2 is satisfied by the first paragraph. It is not satisfied for a default change, and
this record does not pretend otherwise.

---

## 3. Surface and dependency direction

### 3.1 The consuming surface

**`createRuntimePipeline`'s `poiSemanticLookup` option, unchanged in position and contract.** The
subject lookup stays three rungs and the order is frozen by this record:

1. `poiTaxonomyLookup` — the committed category lexicon.
2. `poiNameLookup` — the POI name rung, when a `poi.db` is wired.
3. the injected route — **only** where both returned nothing.

Positive evidence only: a miss returns `[]`, and the route can add a subject where there was none
but can never take one away or displace a committed hit. Absent, the composition is behaviourally
what shipped. Nothing about this order is negotiable inside the opt-in posture; changing it is a
precedence change on the default path, which is a separate decision with its own D-rule obligations.

The route is typed as a plain `POIPhraseLookup`, so the pipeline learns nothing about where the
evidence came from and a match is served by the existing executor exactly as if the category had
been typed. That property is what keeps the integration point one optional argument instead of a
branch, and this record keeps it.

**One move is required before the surface is supported.** The builder lives at
`packages/mailwoman/eval-harness/semantic-utility/observation-route.ts`. A consumer must not reach
into an eval harness for a runtime capability, so the builder moves into the `mailwoman` runtime
tree with a real export subpath, and the harness imports it from there. The probe's frozen
definition and freeze record are untouched by that move — they must show an empty diff, the same
obligation #1960 carries.

### 3.2 Dependency direction

**`mailwoman` → `@mailwoman/geographic-model`. One direction, no cycle, and no new fan-out.**

- The POI branch already lives in `mailwoman`: `poi-intent.ts`, `poi-executor.ts`, and the pipeline
  factory itself. `@mailwoman/core` holds the contract types (`POIIntent`, `POIResult`,
  `POIIntentOutcome`) and nothing that would need world semantics.
- `@mailwoman/kind-classifier` calls the lexicon, but takes it **injected** — `createKindClassifier({
poiLexicon })`. It needs no dependency either.
- `@mailwoman/geographic-model` already depends on `@mailwoman/poi-taxonomy`, which `mailwoman`
  already depends on. The edge adds one package to `mailwoman`'s graph, not a subtree.

**The boundary record's §6 constraint — no `@mailwoman/core` dependency on
`@mailwoman/geographic-model` without a later integration decision — is left STANDING.** This record
is the later decision that clause anticipates, and it declines to use the permission. §10 records
that in the terms §6 asks for.

### 3.3 Release sequencing — measured, because the stale reason is still written in the code

The route module's header says `mailwoman` holds no runtime dependency because
`@mailwoman/geographic-model` is outside the release list and "a published `mailwoman` naming it
would name a version no registry carries". **Both halves of that are now false**, and the
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

So the published `0.0.0` is a functioning package, not a name reservation: it carries compiled
JavaScript, type declarations and the compiled artifact. What makes a runtime dependency unsafe
**today** is the version number, not the contents. `yarn pack` freezes `workspace:*` to whatever the
sibling reads at pack time, so a `mailwoman` packed before the next coordinated release would pin
`0.0.0` permanently — a version that will never be republished once the workspace is in the bump
set, which is the frozen-workspace hazard `AGENTS.md` describes from the other side.

**The decision:** the edge moves from `devDependencies` to `dependencies` in the change that ships
the supported surface, and that change is not published until the same coordinated release also
publishes `@mailwoman/geographic-model` at the shared version. Because the workspace is in
`.release-it.json`'s list, which is the publish set **and** the bump set, one `yarn release` does
both and the dependency is coherent by construction. Nothing here needs a hand-publish, and nothing
here permits one.

The dynamic import may stay or go once the edge is real. It is no longer load-bearing for
publishability; keeping it only keeps the artifact reader off the load path for callers who never
build a route, which is a small and separate benefit.

---

## 4. Default posture and admission shape

### 4.1 Default OFF

The D-rule states that no default-on mechanism ships with a known regression against the shipped
model on any tier-1 locale, and that the compliant routes are to repair it, to admit it per locale,
or to ship it opt-in. It also states the opt-in half's obligation: a default-OFF path must ship with
tests that turn it ON, because a mechanism nobody exercises rots and its first real use is also its
first execution.

This record takes the opt-in route, for a reason the D-rule's own wording invites. The route changes
which query **kind** is chosen. An input the committed lexicon does not claim currently takes the
address path; with the route on, an input ending in a declared activity phrase takes the POI branch
instead. The population that change would newly touch is every non-POI input carrying such a phrase,
and §1.3 says nobody has counted it. A default change against an uncounted population is not a
measured regression, which is precisely why it is not admissible: the D-rule's bar is cleared by
measurement, not by the absence of one.

§11's census is the first measurement of that population, and its answer for the merged route is
**zero changes over 9,324 committed inputs**. That is a real and reassuring number. It is also a
statement about ten authored phrases and a corpus written for other purposes, and #1962 will replace
the first while nothing changes the second.

### 4.2 The admission shape is presence, not a boolean

**Decided: the caller constructs the route and hands it in. There is no `semanticRoute: true` flag.**

A boolean would require the pipeline to construct the artifact reader itself, which puts
`@mailwoman/geographic-model` on the default construction path and gives the pipeline knowledge of
where the evidence came from — the two properties PR #1955 spent its design on avoiding. Presence of
the option is the switch, absence is the pipeline that shipped, and the type stays a plain
`POIPhraseLookup`.

**A future default change must ADD the suppression before it flips.** `createRuntimePipeline`
already has the house pattern for this, twice: `fst?: … | false` and `streetMorphology?: … | false`,
each documented as the byte-stable escape hatch for a mechanism that became default-on. Any change
that makes the route auto-construct must widen `poiSemanticLookup` to `… | false` in the same
commit, with a test that sets it `false` and asserts byte-stability against the pre-change
composition. Rollback that arrives after the change is not rollback (§6).

### 4.3 Locale and country admission

**Decided: no third scoping mechanism. The two that exist are the admission control, and both must
be made to work before the surface is supported.**

- **Recognition is locale-scoped at the phrase.** #1962's lexicon scopes each entry to its locales,
  following the `@mailwoman/variant-aliases` semantics. `collect a prescription` is a British
  phrasing; the lexicon is where that is said.
- **Semantics are country-scoped at the assertion.** `RelationAssertion.countries` is the field, and
  §4.1's W1-2 is the first record to use it.

Neither is consulted today (§1.4(b)). A per-locale allow-list on the pipeline option would be a
third place to look for the same answer and would let a mis-scoped assertion pass unnoticed behind
it. So the decision is to repair the two rather than add a third, and §8.2 makes that a
prerequisite.

The route's phrase normalization is deliberately locale-independent — `toLowerCase` rather than
`toLocaleLowerCase`, so a Turkish host locale cannot make the same query answer differently on two
machines. That property is separate from locale scoping and stays as it is.

---

## 5. The bar for any default change

Every row must be run and reported in the same decision package, on one pinned set of artifacts.
None of them is satisfied by inference from another.

| #     | Check                              | How                                                        | Bar                                                                                                                                                                                                                                                                                         |
| ----- | ---------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | The promoted POI board family      | `mailwoman eval poi-board --enforce`                       | The three reachable rows at `status: pass` and **counted**, not tracked; `sem-act-fr-01` no worse than its committed `known_fail`; all three floors met over the re-registered composition, arithmetic stated                                                                               |
| **2** | The full regression board          | `mailwoman eval gauntlet` — regression **and** metamorphic | No new violation beyond the tracked expected failures, in either layer                                                                                                                                                                                                                      |
| **3** | The five conformance laws          | `mailwoman eval conformance`                               | Every decided row holds; tracked and unmeasured counts unchanged or reduced. **Plus new rows**: the route normalizes NFKC, case and whitespace, so the case-folding, whitespace and punctuation laws each have a claim to make about an activity phrase and no committed row makes it today |
| **4** | The parse promotion eval           | `mailwoman eval gate`                                      | **The D-rule.** No regression against the shipped model on any tier-1 locale. Measured on the address side: a query-kind change moves inputs off the address path, and the POI board cannot see that                                                                                        |
| **5** | The false-claim census             | §11's instrument, re-run at the shipping phrase lexicon    | Zero subject-match changes on the board's address-guard rows; every change elsewhere adjudicated row by row. The positive control reported in the same run — a census that cannot detect a change reports the same zero as a real absence                                                   |
| **6** | Multi-kind adjudication            | A test over an activity with two afforded kinds            | `mappedKindCount > 1` answered without an authored preference (§8.1). A default change while `hits[0]` decides by code point is refused outright                                                                                                                                            |
| **7** | Country admission                  | A row anchored outside an assertion's `countries`          | The route stays silent there, and the receipt says which scope refused it                                                                                                                                                                                                                   |
| **8** | Artifact identity on every receipt | —                                                          | `poi.db` manifest version, weights version, resolver backend, `modelVersion`, phrase-lexicon id and version. An arm label is not a measurement of what ran                                                                                                                                  |
| **9** | The recorded phase-2 decision      | #1967                                                      | The ruler contains rows 1–8; both arms run; the operator records the verdict                                                                                                                                                                                                                |

Two of those nine measure something nobody has measured yet — row 5 exists only as this record's
instrument, and rows 6 and 7 have no committed rows at all. They are named here so #1967's
pre-registration can carry them rather than discovering them afterwards.

**What the bar deliberately does not include:** a prevalence number. If one becomes available it
strengthens the requirement in §2 and this record is amended to say so. Its absence is not a check
that can be waived; it is the reason the default posture is what it is.

---

## 6. Rollback

**While opt-in.** Rollback is removing the argument at the one call site. A consumer who never
passed `poiSemanticLookup` is unaffected by any of this program's work, which is the property the
posture buys. No republish is required of anyone.

**After a hypothetical default change.** The suppression must exist before the change, not after —
`poiSemanticLookup: false`, added in the same commit, with its own test (§4.2). A default change
whose rollback needs a patch release has no rollback.

**Data rollback.** Two artifacts move independently and both are versioned: the compiled model
(`modelVersion`) and the phrase lexicon (`tableID` + `version`). Every receipt carries both, so a
rollback can name which one moved. A wave of semantics is reverted by reverting the committed
artifact and rebuilding it deterministically; a recognition regression is reverted by reverting the
lexicon. Neither requires touching the route.

**Release rollback.** `mailwoman` and `@mailwoman/geographic-model` bump together in the same
coordinated release (§3.3), so a revert is a coordinated patch release of both. Reverting one alone
recreates the version skew the release list exists to prevent.

---

## 7. What diagnostic-strength evidence would justify instead

If #1967's phase-2 measurement misses its resolution threshold but clears a pre-registered
structured diagnostic threshold, the admissible outcome is **the observation surface without the
recognition change**, and this record names it now so it is not invented under pressure later.

Today the provenance the whole program is built around does not reach a caller.
`semanticObservations[]` appears only under `packages/mailwoman/eval-harness/semantic-utility/`; the
route hands them out through a `takeObservations()` drain the harness owns, and
`POIIntentOutcome` has no field for them. A consumer of `createRuntimePipeline` gets the category
and none of the authority behind it.

There is an existing contract shaped for exactly this. `QueryKindResult.intentMarkers` carries
`QueryIntentMarker`, whose own docstring states that a marker never changes which answer wins — it
is additive, attributed, and always accompanied by the ordinary result — with `mechanism` naming the
rule that produced it in a `family:rule` form and `evidence` carrying the measurement so the marker
is auditable rather than assertive. `QueryIntentCode.POICategory` already exists for a query that
resolved to a POI category.

So the diagnostic-strength surface is: the semantic observation rides as a `QueryIntentMarker`
(`mechanism: "semantic:affords"`, `evidence` carrying the assertion id, modality, mapping and both
provenance records), the recognition route stays opt-in, and the compiled artifact keeps growing
under the amendment discipline. That gives a caller an answer to "on whose authority was this
category chosen" and changes nothing on the default path. It is also the right plumbing for the
opt-in surface regardless of the phase-2 verdict, and #1965's absence observations need the same
place to ride — which is why §8.3 lists it as a prerequisite rather than a fallback.

**A stop-strength outcome** — controls regressing, or the false-claim census turning up
unadjudicable claims — ends the opt-in surface too, not merely the default change. The route then
reverts to what it is today: experiment machinery behind a frozen pre-registration, with the
compiled artifact and its conformance instruments retained as the durable product of the phase.

---

## 8. Prerequisites for the supported opt-in surface

This record authorizes the work below and nothing beyond it. Each item needs its own issue; none is
implemented here.

### 8.1 The plural affordance must be answered without an authored preference

The set-to-one narrowing in §1.4(a) is decided as follows, and the decision keeps the program's
architectural line intact.

**The POI branch searches the union; the resolver orders the results.** §3 of the boundary record
assigns candidate ordering to the runtime and resolver, and assigns to the geographic model the
prohibition on authoring any ordering. Searching every afforded, mapped category and letting the
existing candidate ordering rank the union satisfies both: no world-model record states a
preference, because the schema has no field to state one with, and the ordering that decides the
answer is the one the system already owns and already measures.

That requires `POIIntent`'s evidence to carry a set rather than one id. The reader is already
set-shaped — `resolveOvertureCategories` returns an array per seed id and `#searchKRing` probes each
— so the narrowing is entirely upstream, at `matchPOISubject`'s `hits[0]` and at
`POIIntent.evidence.categoryID`. Widening it is a runtime change with its own board obligations, and
it is owned outside this program.

**Until it lands, a plural affordance may not reach the route.** The interim rule is a construction
refusal, in the same family as the eight the route already carries: a declared phrase whose activity
reaches more than one mapped kind refuses at construction, naming the phrase and the kinds. A
refusal is a finding; a silent alphabetical winner is not. #1963 lands the first plural case, so
this refusal must exist before it merges or the collapse ships unobserved.

### 8.2 The two existing scopes must be consulted

`reachKinds` must read `RelationAssertion.countries`, and the route's `lookup` must take and use its
`locale` argument. Both are one-line absences today with no test that would notice; each needs a row
that stays silent outside its scope, per §5 row 7. This is a prerequisite for #1963, not for the
surface — a scoped assertion authored against a route that ignores scope is a record that means
something different from what it says.

### 8.3 Observations must reach the caller

Per §7: the semantic observation rides as a `QueryIntentMarker` on `QueryKindResult.intentMarkers`,
with the assertion, the mapping and both provenance records in `evidence`. Without it the opt-in
surface serves a category with no authority attached, which is the one thing this program exists to
avoid. #1965's coverage-qualified absence observations need the same route to the caller.

### 8.4 The builder moves, and its header is corrected

Per §3.1 the builder moves out of the eval harness into the runtime tree with a real export subpath.
Per §3.3 its header's release-list reasoning is now false in both halves and must be rewritten to
state the version constraint that actually binds, not the membership one that no longer does. The
probe's definition and freeze record show an empty diff across the move.

---

## 9. Sequencing

| Issue                       | Relationship to this record                                                                                                                                                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#1960 / PR #1969**        | Merges first; it is the measurement surface §5 rows 1 and 5 read. Its three `improvement_target` rows name **this issue** as their blocker, so when #1966 closes they must be re-pointed at the implementation issue §8 authorizes — a tracked row naming a closed issue is a row nobody is holding |
| **#1962** (recognition)     | **Blocks the opt-in surface.** A supported capability may not rest on a table whose provenance reads `AUTHORED FOR ONE EXPERIMENT`. Its per-entry locale scoping is half of §4.3's admission control, and its phrase-collision census is what stops another `Somewhere`                             |
| **#1963** (semantics)       | **Blocked by §8.1 and §8.2.** It lands the first plural affordance and the first country-scoped assertion, and both defects in §1.4 become live at that moment. Its own re-measurement obligation (§4.1's closing paragraph) is unchanged by this record                                            |
| **#1964 / #1965** (absence) | **Independent of the default posture.** Observation-only by construction, blocked on exclusion-grade coverage cells rather than on this record. It shares §8.3's route to the caller and should not build a second one                                                                              |
| **#1967** (phase-2 ruler)   | **Consumes this record.** §5's nine rows are what the ruler must contain; rows 5, 6 and 7 have no committed instruments today and must be built into the pre-registration rather than discovered after the arms run                                                                                 |
| **#1039**                   | Owns `sem-act-fr-01`'s structural blocker. Not this program's, and not on the path to the opt-in surface                                                                                                                                                                                            |
| **#1933**                   | Owns the `drugstore`/`pharmacy` retrieval split. §8.1's union search is adjacent to it and must not be mistaken for it — one is which categories a subject reaches, the other is which category a typed phrase reaches                                                                              |

**A default change is not authorized by this record, and cannot be authorized by #1967 alone.** It
needs §5's bar cleared, an operator recording, and — if the bar itself moves — an amendment here.

---

## 10. The boundary record's §6, addressed

Stop condition 5 requires the boundary to be amended in a reviewed change rather than widened in
passing, and §6's fourth architectural exclusion reserves the `@mailwoman/core` question for "a
later integration decision".

**This is that decision, and §6 is left standing, unamended.** `@mailwoman/core` gains no dependency
on `@mailwoman/geographic-model`, now or as a consequence of anything §8 authorizes. The reason §6
gives — core ships the pipeline contract and roughly 9 MB of reference data to every consumer, so a
world-semantics dependency there is one every drop-in API inherits whether it asked or not — is
unweakened by this record, and §3.2 shows the integration needs nothing from core anyway: the POI
branch lives in `mailwoman`, and `@mailwoman/kind-classifier` takes its lexicon injected.

No other exclusion in §6 is touched. Ranking behavior is unchanged; no authored weight, boost,
penalty or ordering API is introduced; §8.1 explicitly routes the plural case to the resolver's
existing ordering rather than authoring one.

---

## 11. How the numbers here were taken

So a reader can re-run them rather than trust them. Both instruments were temporary scripts, deleted
after the run; each is short enough to rebuild from this description, and §5 row 5 makes the first
one permanent.

**The false-claim census.** Every distinct string in every committed `.jsonl` under
`packages/mailwoman/eval-harness/gauntlet/cases/`, `…/conformance/` (both `base` and `variant`) and
`…/fixtures/` — 9,324 distinct inputs: 915 gauntlet cases, 182 conformance, 8,227 fixtures
(BAN FR fragments 2,800, Overture DE fragments 2,404, `no-digits` 2,400, the parity corpora, the
golden sets, the venue confounds, the 51-row POI board). Each was passed to `matchPOISubject` twice
with the same locale — once against `poiTaxonomyLookup` alone, once against `poiTaxonomyLookup`
falling through to the route — and the subject plus category id compared.

```text
route identity: {"phraseTableID":"semantic-utility-probe-activity-phrases","phraseTableVersion":"1.0.0",
                 "declaredPhrases":10,"modelVersion":"0.1.0","reachableCategoryIDs":["pharmacy"]}
distinct inputs: 9324    gauntlet-cases 915 · conformance 182 · fixtures 8227
subject match changed by the route: 0
```

Positive control, in the same run, because an instrument that cannot detect a change reports the
same zero as a real absence:

```text
"where can i pick up a prescription near Denver CO"  (no subject) → where can i pick up a prescription → pharmacy
"prescription near Denver CO"                        (no subject) → prescription → pharmacy
"i need my prescription refilled near Tijuana"       (no subject) → i need my prescription refilled → pharmacy
"buy medicine near Chicago IL"                       (no subject) → buy medicine → pharmacy
"collect a prescription near London"                 (no subject) → collect a prescription → pharmacy
```

The last two are declared phrasings no registered row uses, and they claim a subject.

The POI **name** rung is absent from both arms, deliberately: it can only claim phrases the route
would otherwise be asked about, so its absence over-reports semantic claims in the same direction
and a measured zero is conservative. Adding it needs a `poi.db`, which §5 row 5 should use.

**The wave-1 simulation.** The committed `packages/geographic-model/data/geographic-model.json` was
read, cloned, and given one added concept (`drugstore`, `isA: ["establishment"]`) carrying one
assertion (`affords` → `obtain_medication`, `modality: strongly_expected`, `countries: ["US"]`) and
one `poi-taxonomy` mapping to external id `drugstore` — the wave-1 set exactly as §4.1 admits it.
The route was built over the modified artifact with
`createSemanticObservationRoute({ model })` and queried through `matchPOISubject`. Output in §1.4.

**Read directly, not measured.** The release-list and npm figures in §3.3 (`.release-it.json`'s
workspaces array; `npm view @mailwoman/geographic-model`; the `0.0.0` tarball's own file list). The
conformance row counts — 189 committed across five files, which is the 182 decided plus 6 tracked
plus 1 unmeasured that PR #1955's inertness receipt reports. The board figures — 51 rows at 96.1%
with two pre-existing failures, and PR #1969's proposed 55-row composition with four tracked. The
`poi.db` row counts in §1.1 are the boundary record's §5.3 measurement at manifest `2026-07-22.0`,
carried forward; §4.1's own re-measurement instruction binds them and is #1963's obligation, not
this record's.
