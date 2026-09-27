# R6 — the FR dependent-locality instance (lieu-dit)

Hierarchy campaign R6 opened on 2026-08-01 as a direct follow-up to R5's finding. R5 found that the
model never emits `dependent_locality` in any locale, that no locale suppresses the tag, and that GB
and US emit it only because an artifact supplies the missing evidence. France is the next instance
because it already has both prerequisites: a carrier package (`@mailwoman/neural-weights-fr-fr`) and
a locale profile that lists the tag.

## The FR-specific scoping call, made before any build

WOF's French neighborhood records are Paris **quartiers**, such as "Des Halles", "Palais Royal" and
"Saint-Germain l'Auxerrois" (5,473 pairs nationally). Shipping those as the FR pair source would be
a mistake. The reasons are worth stating, because the US instance made the opposite decision:

- A quartier **never appears in a French postal address.** French addresses contain a number,
  street, postcode and commune. The postcode encodes the arrondissement (75001 = 1er), and the
  quartier is a cartographic subdivision rather than an address line.
- The line that does appear is the **lieu-dit**, a named hamlet or place within a commune. It is
  written on its own line between the street and the commune, as in `261 Impasse des Pinsons /
Pinsonnac / 12210 Montpeyroux`.

The FR source is therefore BAN's `nom_ld` field (DINUM/IGN, Licence Ouverte 2.0) rather than WOF.
The mechanism is the same, and the source is chosen by what the postal format carries. Using WOF
would produce a technically valid index that biases toward spans real French addresses never
contain.

## The instrument already exists and already reads badly

`mailwoman/eval-harness/fixtures/fr-lieudit-golden.jsonl` is a 120-row held-out board. The shipped
model card records its checkpoint-only score: **80 rows, 2 emit, 1 tag-correct.** That matches the
R5 pattern of a live tag the model cannot reach without retrieval. The prediction under test is that
a lieu-dit pair index moves this board the way GB's index moved its board from 0/69 to 69/69.

## Pre-registered bars

- **B-R6.1 (no regression).** Run the full gauntlet with the FR index present and absent, graded
  through per-country overlays. Bar: **zero newly failing counted cases**. The FR rows in particular
  (cedex, the comma-free Rue du Chevaleret row) must not move.
- **B-R6.2 (venue-confound floor).** Use a held-out FR confound board of lieu-dit surfaces at the
  start of venue names (the law-1 class). French lieux-dits commonly start with an article ("La Croix",
  "Le Moulin", "Les Granges") and collide with commercial names, so this is the risky bar. Bar:
  **≤2%** dependent-locality false positives, the shipped GB floor.
- **B-R6.3 (the positive side, on the pre-existing board).** Grade the 120-row
  `fr-lieudit-golden.jsonl` for dependent-locality emission and tag correctness. Bar: **≥70%
  tag-correct**, on the order of what the GB δ-sweep cleared. The baseline to beat is the recorded
  2/80 emit.
- **D-R6.4 (disclosure).** Report what fraction of the golden board's (lieu-dit, commune) pairs the
  built index contains. If every pair on the board is in the index, a high positive score measures
  whether the mechanism works rather than whether it generalizes. R5's B-R5.3 carried the same
  caveat, and the report must state it explicitly.

Failing B-R6.1 or B-R6.2 stops the ship regardless of B-R6.3.

## The readings — and the two decode-path defects the FR instance exposed

The artifact built without errors on the first try: **199,282 distinct (lieu-dit, commune) pairs** and
5,839,518 bytes, from 1,684,844 BAN rows whose lieu-dit survives `cleanLieuDit` (101 départements).
That matches the training extract's ~1.69M figure, as expected, since both read the same filter.
Both self-check probes hit.

The artifact still had no effect. The board stayed at **0/80**, with 100% of its pairs present in
the index. An artifact that is verifiably correct but has no effect points to a mechanism bug, so
the next step was diagnosis rather than tuning. The diagnosis found two defects, both in the shared
probe chain and neither specific to French:

**1. The segment probe assumed the parent owns its segment.** It stripped a trailing postcode from
a parent-candidate key ("Macclesfield SK11 9PD" → "macclesfield"), following the Anglo/NZ
convention, and had no leading form. France writes `12210 Montpeyroux`, so the parent key folded to
`"12210 montpeyroux"` and missed every bare-commune entry. A direct measurement showed that
`"…, Pinsonnac, 12210 Montpeyroux"` gave `applied=false`, while the identical row with the postcode
removed gave `applied=true, dependent_locality=Pinsonnac`. The fix is `stripLeadingSegmentPostcode`.
It applies only to countries in `LEADING_POSTCODE_COUNTRIES` and requires a full match against the country's own
codex shape, so output for a country that never writes that form stays byte-identical.

**2. A newline was not a segment boundary.** `computeGroupSegments` scanned only for `,`. Every row
on the FR golden board is newline-delimited, which is the shape the formatter itself emits (La
Poste's line 5). The whole address therefore collapsed into one segment, the segment path could
never fire, and the prior fell through to the anchored path. A line break is at least as strong a
boundary as a comma, and it now counts as one.

Both fixes apply to every locale and happened to surface here. The second one means that every
multi-line address, in every locale, had been skipping the segment path without any error.

## Bars

- **B-R6.1 PASS.** The full gauntlet is green after both decode-path changes (`VERDICT: PASS`, with
  the same 5 tracked xfails). Full suites: **neural 498/498, mailwoman 521/521**, including the
  byte-stability assertions in the pair-prior suites (66/66).
- **B-R6.2 PASS.** The 60-row FR law-1 confound board has 40 surfaces that start with an article
  or "Saint" ("La …", "Le …", "Saint…", drawn from 84,582 available) plus 20 others. Each opens a
  venue name under its true commune. Result: **0/60 dependent-locality false positives (0.0%)**
  against a ≤2% bar.
- **B-R6.3 PASS, the largest single change in the campaign.** On the pre-existing 120-row
  `fr-lieudit-golden.jsonl` (80 rows with a dependent locality), emission went from **0/80 to
  80/80, and tag-correct rows went from 0 to 76 (95.0%)** against a ≥70% bar. The prior-off leg on
  identical bytes stays at 0/80, so the artifact caused the change. The 4 remaining misses are span
  boundary errors rather than retrieval failures. Two drop particles ("Pres" for "Pres de la
  Fontaine", "Jardin Touve" for "Jardin du Touve"), and one involves an unbalanced quote. The prior
  fired on all 80.
- **D-R6.4 disclosed.** All 80 of the board's pairs are in the index, so B-R6.3 measures how well
  the mechanism works where the gazetteer has data. It does not measure generalization. This cannot be
  avoided here, because the board and the index both derive from BAN. R5's B-R5.3 carried the same
  caveat.

## Verdict

The FR instance ships. R5 predicted that this locale would depend on the artifact. It depended on
both the artifact and the probe. The probe defects affected every locale, and nobody had measured
them because no shipped locale sent postcode-first or multi-line addresses through this path.
