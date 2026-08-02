# R10 — India, and why the handoff's number was twice too big

Campaign R10, 2026-08-02, off the WOF-granularity handoff. That work found India yields 186,469
pairs — "6× the shipped GB pair index that took eight campaign rungs to assemble" — and named the
gazetteer rebuild as the highest-value single move available. The rebuild ran and India shipped, but
the number did not survive contact with our own ingest.

## The correction: 186,469 → 175,744, and 86,754 before aliases

The handoff's probes counted nodes in the raw WOF repo. They are gitignored and were not in this
tree, so the figure could not be audited — only re-derived. Re-derived through the pipeline:

| measurement                                             | pairs       |
| ------------------------------------------------------- | ----------- |
| in the rebuilt artifact, no currency filter             | 185,095     |
| **live only** (`is_current != 0 AND is_deprecated = 0`) | **86,754**  |
| live + parent-alias expansion (shipped)                 | **175,744** |

**53.4% of India's borough/neighbourhood nodes carry `edtf:deprecated`** — 100,860 of 189,002 —
against 0.0% (DE), 0.1% (GB, FR) and 2.5% (US). India is a dramatic outlier, and a raw-repo count
therefore overstates its usable yield by roughly 2×. The operator's instinct that our WOF machinery
already handled deprecation is what surfaced this; the machinery existed and the pair extraction
simply was not using it (fixed separately, #1411).

So India is **not** 6× GB. Live and alias-expanded it is 175,744 against GB's 30,825 — still the
campaign's largest instance, and still worth the rebuild, but the honest multiple is ~5.7× on a
number that includes aliases and ~2.8× without them.

## Parent-alias expansion, and why India alone

`12 MG Road, Indiranagar, Bengaluru` emitted nothing even with the index loaded: WOF stores
**Bangalore**, the address says **Bengaluru** (renamed 2014, present in the `names` table as an
`eng` VARIANT rather than the preferred name). The pair existed and could never fire.

`extractBoroughPairs` now expands parent surfaces from `names` where `language = 'eng'` and the name
is longer than three characters — the short tail is airport and agency codes (`BLR`, `BBMP`), the
shape most likely to collide with an unrelated word.

**Enabled for India only, deliberately.** Applied globally it took the US index from 47,878 to
101,560 — more than double, on surfaces no board has ever graded. Every increment in this campaign
cleared a venue-confound board before shipping, and a 2× expansion of the flagship locale earns its
own board rather than riding in on India's evidence. The existing surface-expansion probe
(`pair-index-hierarchy-probe.ts`) gates on `official = 1`; that is right for name-exactness and too
strict here, because the rows a rename leaves behind are exactly the non-official ones.

## Bars

- **B-R10.1 PASS** — gauntlet green; GB/US/DE indexes byte-identical (47,878 / 30,825 / 85,603),
  confirming the alias change is contained.
- **B-R10.2 PASS** — 70-row confound board (40 directional-class surfaces from 665 available + 30
  others, each opening an Indian venue name): **0/70 false positives**.
- **B-R10.3 PASS** — 60-row positive board: 60/60 emit, **59/60 tag-correct (98.3%)**. The single
  miss is a trailing period (`Pimpale Bk` vs `Pimpale Bk.`) — a tokenization artifact, not a
  retrieval failure.
- **D-R10.4** — before/after on real addresses: `12 MG Road, Indiranagar, Bengaluru, Karnataka
560038` fused the locality as `"Indiranagar Bengaluru Karnataka"` and emitted no dependent
  locality; it now yields `dependent_locality=Indiranagar, locality=Bengaluru`.

## Consolidation carried in the same change

DE moved off its checked-in 85k-line pairs file onto the shared `--borough-db` extractor. The data
had two homes and one could go stale against the other; `data/gazetteer/de-pairs-v1.jsonl` is gone.

## The artifact swap

`admin-global-priority.db` rebuilt (4.92M nodes, up from 4.09M — all India), **verify PASS 21/21**,
sealed, previous artifact preserved under `wof/superseded/`. Confirmed additive before swapping:
GB/US/DE/FR live pair counts identical across old and new; India 0 → 86,754.

## What the scorecard says after the rebuild, and why it still says "locality"

Regenerating `gazetteer granularity` against the swapped artifact moves India's `source` column from
`overture (rebuild pending)` to `wof-repo` and populates its dependent-locality rung with **88,142
nodes**. It still reports India as bottoming out at `locality`, and that is correct rather than a
stale read:

| country | locality nodes carrying a dep-loc child |    share |
| ------- | --------------------------------------: | -------: |
| DE      |                        12,436 of 17,123 |    72.6% |
| GB      |                         9,727 of 28,070 |    34.7% |
| **IN**  |                   **36,610 of 915,063** | **4.0%** |

India has by far the most sub-locality nodes in absolute terms and the thinnest coverage in relative
terms, because its locality tier is enormous — 915,063 nodes, essentially every village. 4.0% sits
under the scorecard's 5% floor.

The practical reading: **the India pair index is a city instrument.** Bangalore (605 children),
Delhi (583), Chennai (382), Hyderabad (338) and Varanasi (337) carry real depth; the long rural tail
carries none. That is the right expectation to set for it, and it is exactly the distinction the
scorecard's parent-coverage statistic exists to make — a raw node count would have called India the
best-covered country in the table.
