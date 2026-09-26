# R10 — India, and why the handoff's number was twice too big

Campaign R10 (2026-08-02) follows the WOF-granularity handoff. That work reported that India yields
186,469 pairs, "6× the shipped GB pair index that took eight campaign rungs to assemble", and
recommended the gazetteer rebuild as the highest-value single change available. The rebuild ran and
India shipped, but our own ingest produced a smaller number.

## The correction: 186,469 → 175,744, and 86,754 before aliases

The handoff's probes counted nodes in the raw WOF repo. The probes are gitignored and were not in
this tree, so the figure could not be audited, only re-derived. Re-derived through the pipeline:

| measurement                                             | pairs       |
| ------------------------------------------------------- | ----------- |
| in the rebuilt artifact, without a currency filter      | 185,095     |
| **live only** (`is_current != 0 AND is_deprecated = 0`) | **86,754**  |
| live + parent-alias expansion (shipped)                 | **175,744** |

**53.4% of India's borough/neighborhood nodes carry `edtf:deprecated`** (100,860 of 189,002),
against 0.0% for DE, 0.1% for GB and FR, and 2.5% for US. India is an extreme outlier, so a raw-repo
count overstates its usable yield by roughly 2×. The operator suspected that our WOF implementation
already handled deprecation, and checking that suspicion found the problem. The implementation
existed, but the pair extraction was not using it (fixed separately, #1411).

India is therefore **not** 6× GB. Live and alias-expanded, it has 175,744 pairs against GB's 30,825.
It is still the campaign's largest instance and still worth the rebuild, but the direct multiple is
about 5.7× with aliases and about 2.8× without them.

## Parent-alias expansion, and why India alone

`12 MG Road, Indiranagar, Bengaluru` emitted no dependent locality even with the index loaded. WOF stores
**Bangalore**, while the address says **Bengaluru**. The city was renamed in 2014, and the `names`
table holds Bengaluru as an `eng` variant rather than the preferred name. The pair existed but could
never fire.

`extractBoroughPairs` now expands parent surfaces from `names` where `language = 'eng'` and the name
is longer than three characters. Names of three characters or fewer are mostly airport and agency
codes (`BLR`, `BBMP`), which are the most likely to collide with an unrelated word.

**The expansion is enabled for India only, on purpose.** Applied globally, it took the US index from
47,878 to 101,560 pairs, more than double, on surfaces no board has ever graded. Every increment in
this campaign cleared a venue-confound board before shipping, and a 2× expansion of the flagship
locale needs its own board rather than India's evidence. The existing surface-expansion probe
(`pair-index-hierarchy-probe.ts`) filters on `official = 1`. That filter suits name exactness but is
too strict here, because the rows a rename leaves behind are the non-official ones.

## Bars

- **B-R10.1 PASS.** The gauntlet is green, and the GB/US/DE indexes are byte-identical (47,878 /
  30,825 / 85,603), which confirms the alias change affects only India.
- **B-R10.2 PASS.** On a 70-row confound board (40 directional-class surfaces drawn from 665
  available, plus 30 others, each at the start of an Indian venue name), the result is **0/70
  false positives**.
- **B-R10.3 PASS.** On a 60-row positive board, 60/60 rows emit and **59/60 are tag-correct
  (98.3%)**. The single miss is a trailing period (`Pimpale Bk` vs `Pimpale Bk.`), which is a
  tokenization artifact rather than a retrieval failure.
- **D-R10.4.** Before and after on real addresses: `12 MG Road, Indiranagar, Bengaluru, Karnataka
560038` previously fused the locality as `"Indiranagar Bengaluru Karnataka"` and emitted no
  dependent locality. It now yields `dependent_locality=Indiranagar, locality=Bengaluru`.

## Consolidation carried in the same change

DE moved from its checked-in 85k-line pairs file to the shared `--borough-db` extractor. The data had
two homes, and one could go stale relative to the other. `data/gazetteer/de-pairs-v1.jsonl` is
removed.

## The artifact swap

`admin-global-priority.db` was rebuilt with 4.92M nodes, up from 4.09M, and all of the increase is
India. It passed **verify 21/21** and was sealed, and the previous artifact is preserved under
`wof/superseded/`. Before the swap, a comparison confirmed that the change was additive: GB/US/DE/FR
live pair counts were identical across old and new, and India went from 0 to 86,754.

## What the scorecard says after the rebuild, and why it still says "locality"

Regenerating `gazetteer granularity` against the swapped artifact changes India's `source` column
from `overture (rebuild pending)` to `wof-repo` and fills its dependent-locality rung with **88,142
nodes**. The scorecard still reports that India's coverage stops at `locality`. That is correct and
does not come from stale data:

| country | locality nodes carrying a dep-loc child |    share |
| ------- | --------------------------------------: | -------: |
| DE      |                        12,436 of 17,123 |    72.6% |
| GB      |                         9,727 of 28,070 |    34.7% |
| **IN**  |                   **36,610 of 915,063** | **4.0%** |

India has by far the most sub-locality nodes in absolute terms and the thinnest coverage in relative
terms, because its locality tier is enormous: 915,063 nodes, essentially one per village. 4.0% is
below the scorecard's 5% floor.

In practice, **the India pair index covers cities.** Bangalore (605 children), Delhi (583), Chennai
(382), Hyderabad (338) and Varanasi (337) have real depth, and the long rural tail has none. Users of
the index should expect that. The scorecard's parent-coverage statistic exists to show this
distinction. A raw node count would have ranked India as the best-covered country in the table.
