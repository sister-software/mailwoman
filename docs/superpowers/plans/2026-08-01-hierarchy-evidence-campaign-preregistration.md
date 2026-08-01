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
