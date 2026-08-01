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
