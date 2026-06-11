# punctuation-stress.jsonl — gold conventions (#518)

120 hand-curated rows across the punctuation classes our government-data evals never carry.
Each row: `{raw, components, class}`. Graded by `scripts/eval/score-punctuation-stress.ts`
(per-class component accuracy + parse-survival), runnable against both engines.

Gold conventions, decided once here:

1. **Paired delimiters are EXCLUDED from component values** (`"Big Company HQ"` → venue
   `Big Company HQ`) — matching the January Chevrotain experiment's strip behavior and how a
   geocoder would consume the value.
2. **Parenthetical annotations** (`(rear entrance)`, `(2nd floor)`) are NOT components — gold
   omits them; the row grades whether NEIGHBORS survive the annotation. When paren content IS a
   component (`(Australia)` → country), it is labeled as that component, delimiters excluded.
3. **c/o & attention lines**: the schema has no `attention`/`care_of` tag the current model emits;
   the c/o phrase is left UNLABELED in gold and the row grades the neighbors. These rows measure
   poisoning, not c/o extraction (that capability is a separate future lever).
4. **Unbalanced delimiters** (operator ruling 2026-06-11): a stray, unpaired delimiter is
   EXCLUDED from the component value (`Joe's "Pizza` → `venue: Joe's Pizza`), and the component is
   still graded — never omitted. BALANCED quotes that are part of a name as written stay
   (`Joe's "Famous" Deli`, `Office "B"`). The load-bearing read remains parse SURVIVAL + neighbor
   accuracy, captured per-row by the scorer (a thrown parse fails every component in the row).
5. **Dotted abbreviations**: values keep their dots as written (`P.O. Box 19`, `St. Louis`,
   `Washington D.C.`) — the span-bridge regression lens.
6. **Half addresses** (`123 1/2`) follow USPS convention: the fraction belongs to house_number.
7. Locale defaults US; `class` field drives the per-class report. Rows seeded from: the January
   experiment's tests (commit 10195ea), the v4.4.0 gate's measured classes, arena leftovers
   (Eduard-Sueß), and real-world named places chosen for their punctuation (Coeur d'Alene,
   Winston-Salem, Saint-Louis-du-Ha! Ha!). The 2026-06-11 expansion (62→120) weighted the two
   v0-win quadrants (bracketed, hyphen), the under-5-row classes, and FR/DE/AU/NZ surfaces
   (dotted abbreviations, CEDEX, unit designators).

## Head-to-head (120 rows, 2026-06-11, folded vocabulary view)

`--engine v0` vs neural v4.4.0 ship config + `--fold-gold`. Gold updated 2026-06-11 per the
operator's unbalanced-delimiter ruling (convention 4: rows 29/32/112) — unbalanced + overall
cells shifted slightly vs the expansion-day run. Neural column re-measured 2026-06-12 with the Stage 2.7 span proposer DEFAULT-ON (operator ruling; #544/#546) — proposer-OFF baseline preserved in the #518 thread. Note: the set grew 62→120 on
2026-06-11 — per-class deltas vs the 62-row run reflect the composition shift (the expansion
deliberately deepened the v0-win quadrants and added international surfaces), NOT model drift.

| class            |                  v0 |     neural (v4.4.0) | Δ            |
| ---------------- | ------------------: | ------------------: | ------------ |
| apostrophe       |                93.3 |                84.4 | v0 +8.9      |
| bracketed        |                83.1 |                87.7 | neural +4.6  |
| care-of          |                60.0 |                85.0 | neural +25.0 |
| dotted           |                78.2 |                81.8 | neural +3.6  |
| hyphen           |                82.6 |                84.1 | neural +1.5  |
| mixed-hard       |     40.5 († 1 died) |                69.0 | neural +28.5 |
| paren-annotation |                84.6 |                86.2 | neural +1.6  |
| paren-component  |                75.0 |                75.0 | tie          |
| quoted-venue     |     73.8 († 1 died) |                75.4 | neural +1.6  |
| slash            |                71.7 |                71.7 | tie          |
| unbalanced       |                69.0 |                83.3 | neural +14.3 |
| **overall**      | **75.3** (2 deaths) | **80.9** (0 deaths) | neural +5.6  |
