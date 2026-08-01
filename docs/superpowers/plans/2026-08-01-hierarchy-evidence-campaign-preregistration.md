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
