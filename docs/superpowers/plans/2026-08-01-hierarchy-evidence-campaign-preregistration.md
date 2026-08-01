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
