---

## R2 groundwork (2026-08-01, verified against the shipped admin DB)

`admin-global-priority.db` carries **exactly 211 borough rows** (the design doc's number,
confirmed). Extraction: `spr.placetype='borough'` joined through `ancestors` to
locality/localadmin parents. Distribution: London 33, Cardiff 33 (inspect — Welsh communities
mis-typed?), Tokyo 23, Rotterdam 23, Paris 20, Amsterdam 8. NOTE: Amsterdam's boroughs are
compass-named (Noord/Zuid/West/Oost/Nieuw-West/Zuidoost) — the directional-homograph class at
placetype grain; law-1-style care applies when these become pair entries. Berlin rows appear
twice (locality + localadmin parents) — dedupe on (child, parent-surface). Next: emit these as
PIX1 rows into the per-locale indexes (London → pair-index-gb; others gated on their locale's
carrier + tag-aliveness per the placetype-evidence doc).

---

## R3 survey opening (2026-08-01)

**ONSPD FEB 2026 is ALREADY ON DISK** (`$MAILWOMAN_DATA_ROOT/onspd/2026-07-22/`, OGL). The
current ward lookup (`WD ... 05_25.csv`) carries both probe targets (Nine Elms E05014015,
Islandmagee N08000826). London extraction executed: live postcodes in the 8 London postal areas,
LAD filter E09*, wd25cd → ward name → **459 (ward, London) pairs**
(`scratch-gbvenue/london-ward-pairs.jsonl`), incl. Nine Elms + the Clapham ward family. Boundary
recorded: "Clapham North" is a NEIGHBOURHOOD, not a ward — ward grain covers part of the
neighbourhood class; the residual wants a finer source (OS Open Names) in a later increment. NI:
ward names exist (N08*) but the PAIR parent needs post towns — an outcode→post-town table is the
missing piece, deferred. IE: licence survey still open (Tailte Éireann/logainm).

---

## R4 groundwork + the WOF-neighbourhood vein (2026-08-01)

**Census measurement (shipped admin DB): 26,431 parents carry dep-loc-class children.** London:
675 (33 boroughs + 675-class neighbourhoods), NYC: 5 + 309, Manchester: 134, Springfield: 158 —
the conditional prior has real discriminative mass, confirming the census artifact's premise.

**The R3 residual's source is our own data**: London's WOF neighbourhoods include Nine Elms and
the neighbourhood class the ward grain missed — no OS Open Names acquisition needed. Quality
profile of the direct-parent extraction (667 distinct GB surfaces under the London locality):
101 are law-1 directional-led/-trailed ("East Acton", "Bromley North") — the exact class that
truncated "3rd Ave NE"; they need the ambiguity-class treatment, not blanket inclusion. AND the
extraction needs ANCESTOR CLOSURE, not direct parent: "Clapham North" routes to London via its
borough (the WOF-hierarchy shape), so the extractor must accept any-ancestor-London (locality or
E09 borough). Pre-registered bar for the neighbourhood increment: fold-collision audit vs the
existing 19,615 pairs + a held-out board incl. the law-1 subset graded for venue-confound FPs
BEFORE the artifact ships them.

**Fold-collision audit of the 667 (2026-08-01):** 243 already resolve in the current artifact
(PPD ∪ boroughs ∪ wards), **424 fresh**, of which 56 are law-1 directional. Two structural
findings for the increment's design: (a) "Clapham North" is WOF-typed **locality**, not
neighbourhood — the dual-role class (#402); locality-under-London pairs are a separate,
riskier ambiguity class and do NOT ride this increment; (b) the ancestor-closure and
direct-parent extractions coincide at 667 — London neighbourhood records parent directly.
Next rung (pre-registered): the 424-fresh increment behind a held-out board with the 56
law-1 rows graded for venue-confound FPs before the artifact ships them.

**R4b — the neighbourhood increment SHIPPED (2026-08-01):** the pre-registered bar PASSED — the
56-row law-1 confound board (directional neighbourhood surfaces opening venue names) shows
**0 dep-loc false positives before AND after** the 424-fresh merge; the segment-mode gating holds.
Positive side verified: "East Acton"/"Crystal Palace"/"Nine Elms" all extract as
dependent_locality. Artifact: `data/gazetteer/london-pairs-v2.jsonl` (966 rows = wards ∪
neighbourhoods, sorted-unique) supersedes v1; link-dev-weights repointed; full GB index =
19,209 PPD + 830 secondary = 20,039, cross-checked + self-verified; TRANSITION-BETA green.

---

## R4c — the placetype census artifact (PRE-REGISTERED 2026-08-01, before the probe ran)

The census is the general form the pair index is one instance of: per parent surface, the
distribution of its children's PROJECTED tags. Built here as PCN1
(`neural/placetype-census.ts`, writer+reader in one file like PIX1/PCB1) from the shipped WOF
admin DB, via `mailwoman gazetteer census`.

**Why a second artifact instead of folding these links into the pair index.** A pair entry
ASSERTS a surface is a dependent locality, so every batch needs a venue-confound board before it
ships (R4b's law-1 discipline). A census node asserts nothing about any surface — it can only tilt
a reading the model already entertains under a parent it already identified. That is what makes it
the safe carrier for the long tail (GB alone has 22,843 WOF dep-loc-class links; individually
boarding them is not a plan).

**Scope: data + loader + offline probe. NO decode wiring, and the header ships with NO `delta`** —
a calibrated bias is a later rung's output, and an artifact carrying an unmeasured one would ship a
lever nobody measured.

**Pre-registered bars:**

- **B-C1 (artifact sanity).** Build reports 0 unmapped placetypes; the self-check readback finds
  nodes for London/Manchester/Birmingham with nonzero dependent-locality mass; artifact ≤ 2 MB.
- **B-C2 (discrimination).** Median dependent-locality LIFT over the GB base rate, across the
  parents of a held-out GB dep-loc sample, is **≥ 2.0×**. A lift near 1 means the census is not
  conditional evidence at all and the rung closes NEGATIVE.
- **B-C3 (marginal value over PIX1).** Of sampled GB dep-loc links whose (child, parent) MISSES the
  shipped pair index, **≥ 20%** have a census node with nonzero dependent-locality share. Near 0%
  would mean the census covers only what the index already covers, and the rung closes NEGATIVE.
- **D-C4 (required disclosure, not a pass/fail bar).** Report the census's dep-loc mass on the
  56-row law-1 confound board. The expected result is ~100% coverage, because every row shares the
  London parent: **the census cannot discriminate at span level by construction.** That is the
  finding to state plainly, not to bury — it is precisely why the census is a parent-scoped prior
  that must compose with span-level evidence, and why this rung ships un-wired.

### R4c Addendum 1 — B-C2 is mis-specified; the amended bar, pre-registered before reading it

The GB build (5,577 nodes, 136,674 bytes, 33,899 counted links, 0 unmapped placetypes) makes
B-C2 unreadable as written, and the reason is structural rather than a property of any parent:
**within-node share is ~100% everywhere.** WOF rarely parents a locality under another locality,
so the only children this source contributes under a locality parent are the dependent-locality
class itself. The country base rate lands at 65.6% dependent_locality / 34.4% locality, and every
covered parent — London, Manchester, Birmingham alike — reads share 100.0%, lift 1.5×.

**B-C2 therefore reads 1.5× against a 2.0× bar. Recorded as a MISS of the metric, not of the
mechanism.** The pre-registration exists to stop exactly the move of quietly swapping in a
friendlier statistic, so the miss stands in the record.

The diagnosis says which statistic actually carries the information. A census node's evidence is
not "what fraction of this parent's children are dependent localities" (trivially all of them);
it is **presence and magnitude across the parent population** — most localities have no such
children at all and never enter the artifact.

- **B-C2′ (amended, pre-registered BEFORE computing it).** Of GB locality-class places in the
  source, the fraction carrying ≥1 dependent-locality child is **≤ 50%** — a census hit must rule
  out at least half the parent population to be evidence — AND the median dependent-locality child
  count on covered nodes is **≥ 2**. Failing either closes the discrimination question NEGATIVE.
- **D-C2″ (disclosure).** Report the covered fraction among LARGE parents separately. The expected
  shape is that big cities are all covered, so the census discriminates in the small/middle tail
  and says nothing about major-city queries. State it either way.

### R4c Addendum 2 — the readings, and B-C3's circularity

**B-C1 PASS.** GB census: 5,577 nodes, 136,674 bytes, 33,899 links, 0 unmapped placetypes;
readback probes return nonzero dependent-locality mass for London (707), Manchester (65),
Birmingham (110).

**B-C2 MISS (of the metric — see Addendum 1).** Median within-node lift 1.31× against a 2.0× bar.

**B-C2′ PASS, both halves.** GB has 28,872 locality-class places (16,987 distinct surfaces); the
census covers 5,637 = **33.2%** (bar ≤ 50%), and the median covered node carries **2**
dependent-locality children (bar ≥ 2). A census hit does rule out two thirds of the parent
population.

**D-C2″ (disclosure).** The top decile of covered parents holds 8,415 of 22,545 dependent-locality
children — 37% of the mass in 10% of the parents. The distribution is exactly as suspected: major
cities are all covered and the census tells you nothing you didn't know there; its information is
in the small/middle tail, where the median parent has two.

**B-C3 VOID — the measurement is circular, and the 97.1% it produced means nothing.** The sample
drew (child, parent) links from WOF, and the census is built from WOF under an inclusion rule that
admits a parent precisely because it has such a child. Every sampled parent was therefore in the
census by construction. The reading (20,186 of 22,843 links miss the shipped pair index; 97.1% of
those misses have census parent coverage) is recorded as void, not as a pass.

The one fact in it that is NOT circular, because it concerns the other artifact: **the shipped pair
index resolves only 2,657 of WOF's 22,843 GB dependent-locality links — 11.6%.** The tail this arc
set out to cover is real and mostly uncovered.

- **B-C3′ (pre-registered BEFORE running, replaces B-C3).** Take GB post towns from the PPD
  tuples — HM Land Registry, a source the census never read — and measure the fraction with
  nonzero census dependent-locality mass, both unweighted and weighted by PPD row volume (the
  unit real queries arrive in). Bar: **≥ 20% unweighted**. Report the weighted figure alongside;
  a large gap between the two is itself the finding about where the census does and does not speak.

**D-C4 (disclosure) confirmed as predicted.** All 56 law-1 confound rows share the London parent
with the true positives, so the census has dependent-locality mass on 100% of them. The census
cannot discriminate a venue-opening directional surface from a real dependent locality — it is a
parent-scoped prior, and span-level selectivity has to come from elsewhere. This is the honest
ceiling on what the artifact can ever contribute, and the reason it ships without a delta.

### R4c verdict — the census is real evidence, and it is parent-scoped only

**B-C3′ PASS.** Against GB post towns from the PPD tuples (25.7M rows, a source the census never
read): **54.2% of the 1,167 post towns** have census dependent-locality mass, and **74.3% of PPD
rows** land in a covered town. On the subset of post towns whose PPD rows actually carry a
dependent locality: 56.8% of towns, **77.5% of rows**.

The gap between unweighted and weighted coverage (54% → 74%) is the useful part: the census speaks
for the towns where the mail volume is. The uncovered half is the small-town tail, where WOF has no
neighbourhood records — coverage, not fact, and the reader treats it as neutral.

**Rung outcome: the artifact ships, un-wired, with its ceiling stated.**

- It is genuine conditional evidence: a hit rules out two thirds of GB's parent population
  (B-C2′) and is available on three quarters of real dependent-locality-bearing rows (B-C3′).
- It cannot do span-level work (D-C4). Every law-1 confound row shares London with the true
  positives. A census delta alone would raise dependent-locality odds on the venue span exactly as
  much as on the real one — which is why no delta is written and why the calibration rung, if it
  runs, has to compose the census with span-level evidence rather than replace it.
- The complementary fact about the OTHER artifact: the shipped pair index resolves 11.6% of WOF's
  GB dependent-locality links. The tail the census addresses is most of the space.

**Not shipped in the weights package.** `placetype-census-gb.bin` is buildable via `mailwoman
gazetteer census` and stays out of `neural-weights-en-gb/` until something consumes it — an
un-wired 137 KB in every published tarball is dead weight, and shipping it would imply a
mechanism that does not exist yet.
