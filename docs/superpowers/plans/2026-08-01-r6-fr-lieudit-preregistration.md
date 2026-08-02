# R6 — the FR dependent-locality instance (lieu-dit)

Hierarchy campaign R6, opened 2026-08-01 directly off R5's finding: `dependent_locality` is dead
uniformly in the model, no locale suppresses it, and GB/US emit only because an artifact clears the
deficit. France is the next instance because it already has both prerequisites — a carrier package
(`@mailwoman/neural-weights-fr-fr`) and a locale profile that lists the tag.

## The FR-specific scoping call, made before any build

WOF's French neighbourhood records are Paris **quartiers** — "Des Halles", "Palais Royal",
"Saint-Germain l'Auxerrois" (5,473 pairs nationally). Shipping those as the FR pair source would be
a mistake, and it is worth stating why, because the US instance took exactly the opposite decision:

- A quartier **never appears in a French postal address.** French addresses are number, street,
  postcode, commune; the arrondissement is encoded in the postcode itself (75001 = 1er), and the
  quartier is a cartographic subdivision, not an address line.
- The line that DOES appear is the **lieu-dit** — a named hamlet or place within a commune, written
  on its own line between the street and the commune. `261 Impasse des Pinsons / Pinsonnac / 12210
Montpeyroux` is the shape.

So the FR source is BAN's `nom_ld` field (DINUM/IGN, Licence Ouverte 2.0), not WOF. Same mechanism,
different source — chosen by what the postal format actually carries. Getting this wrong would
produce a technically-valid index that biases toward spans real French addresses never contain.

## The instrument already exists and already reads badly

`mailwoman/eval-harness/fixtures/fr-lieudit-golden.jsonl` is a 120-row held-out board, and the
shipped model card records its checkpoint-only score: **80 rows, 2 emit, 1 tag-correct.** That is
the R5 signature exactly — a live tag the model cannot reach without retrieval. The prediction
under test is that a lieu-dit pair index moves it the way GB's moved 0/69 → 69/69.

## Pre-registered bars

- **B-R6.1 (no regression).** Full gauntlet with the FR index present vs absent, graded through
  per-country overlays. Bar: **zero newly-failing gated cases**, and the FR rows in particular
  (cedex, the comma-free Rue du Chevaleret row) must not move.
- **B-R6.2 (venue-confound floor).** A held-out FR confound board — lieu-dit surfaces opening venue
  names, the law-1 class. French lieux-dits are heavily article-led ("La Croix", "Le Moulin", "Les
  Granges") and collide with commercial names, so this is the risk-bearing bar. Bar: **≤2%**
  dependent-locality false positives, the shipped GB floor.
- **B-R6.3 (the positive side, on the pre-existing board).** The 120-row `fr-lieudit-golden.jsonl`,
  graded for dependent-locality emission and tag-correctness. Bar: **≥70% tag-correct**, matching
  the order the GB δ-sweep cleared. Baseline to beat is the recorded 2/80 emit.
- **D-R6.4 (disclosure).** Report what fraction of the golden board's (lieu-dit, commune) pairs the
  built index actually contains. A high positive score driven by a board whose pairs are all in the
  index measures mechanism efficacy, not generalization — the same caveat R5's B-R5.3 carried, and
  it must be stated rather than implied.

Failing B-R6.1 or B-R6.2 stops the ship regardless of B-R6.3.

## The readings — and the two decode-path defects the FR instance exposed

The artifact built clean on the first try: **199,282 distinct (lieu-dit, commune) pairs**, 5,839,518
bytes, from 1,684,844 BAN rows carrying a lieu-dit that survives `cleanLieuDit` (101 départements —
matching the training shard's ~1.69M figure, as it must, since both read the same filter). Both
self-check probes hit.

And it changed nothing. The board stayed at **0/80**, with 100% of its pairs present in the index.
An artifact that is provably correct and provably inert is a mechanism bug, so the next step was
diagnosis, not tuning. Two defects, both in the shared probe chain rather than anything French:

**1. The segment probe assumed the parent owns its segment.** It stripped a TRAILING postcode from
a parent-candidate key ("Macclesfield SK11 9PD" → "macclesfield") — the Anglo/NZ convention — and
had no leading form. France writes `12210 Montpeyroux`, so the parent key folded to
`"12210 montpeyroux"` and missed every bare-commune entry. Measured directly:
`"…, Pinsonnac, 12210 Montpeyroux"` gave `applied=false`, while the identical row with the postcode
removed gave `applied=true, dependent_locality=Pinsonnac`. Fixed with `stripLeadingSegmentPostcode`,
gated by `LEADING_POSTCODE_COUNTRIES` and anchored full-match against the country's own codex shape,
so a country that never writes that form is byte-identical.

**2. A newline was not a segment boundary.** `computeGroupSegments` scanned for `,` only. Every row
on the FR golden board is newline-delimited — the shape the formatter itself emits, La Poste's line
5 — so the whole address collapsed to ONE segment, the segment path went structurally inert, and the
prior fell through to the anchored path. A line break is a stronger boundary than a comma, never a
weaker one; it now counts alongside it.

Both are locale-general fixes that happened to surface here. The second in particular means every
multi-line address, in every locale, was silently missing the segment path.

## Bars

- **B-R6.1 PASS.** Full gauntlet green after both decode-path changes (`VERDICT: PASS`, same 5
  tracked xfails). Full suites: **neural 498/498, mailwoman 521/521** — including the byte-stability
  assertions the pair-prior suites carry (66/66).
- **B-R6.2 PASS.** 60-row FR law-1 confound board — 40 article-led surfaces ("La …", "Le …",
  "Saint…", drawn from 84,582 available) plus 20 others, each opening a venue name under its true
  commune: **0/60 dependent-locality false positives (0.0%)** against a ≤2% bar.
- **B-R6.3 PASS, and it is the campaign's largest single move.** The pre-existing 120-row
  `fr-lieudit-golden.jsonl` (80 rows carrying a dependent locality) goes **0/80 emit → 80/80 emit,
  0 → 76 tag-correct = 95.0%** against a ≥70% bar. The prior-OFF leg on identical bytes stays 0/80,
  so the artifact is what moved it. The 4 residual misses are span-boundary, not retrieval: dropped
  particles ("Pres" for "Pres de la Fontaine", "Jardin Touve" for "Jardin du Touve") and one
  unbalanced quote — the prior fired on all 80.
- **D-R6.4 disclosed.** 80/80 of the board's pairs are in the index, so B-R6.3 measures mechanism
  efficacy where the gazetteer has data, not generalization. Unavoidable here and worth naming: the
  board and the index are both BAN-derived. The same caveat R5's B-R5.3 carried.

## Verdict

The FR instance ships. R5 predicted this locale was artifact-gated; it was artifact-gated AND
probe-gated, and the probe half was locale-general breakage nobody had measured because no shipped
locale wrote its postcode first or its addresses multi-line through this path.
