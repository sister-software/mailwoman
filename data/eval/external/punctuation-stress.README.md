# punctuation-stress.jsonl — gold conventions (#518)

200 hand-curated rows across the punctuation classes our government-data evals never carry.
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
   (dotted abbreviations, CEDEX, unit designators). The 2026-06-12 expansion (120→200) deepened
   the slash, bracketed, and mixed-hard classes (the tied and neural-lead quadrants depth decision
   needs), adding AU/NZ/DE/FR/GB coverage to each.

## Head-to-head (200 rows, 2026-06-12, folded vocabulary view)

`--engine v0` vs neural v4.4.0 ship config + `--fold-gold`. **Composition-shift note:** the set
grew 120→200 on 2026-06-12, deliberately deepening slash, bracketed, and mixed-hard — the classes
where v0 ties or where the depth decision needed more signal. Per-class numbers shifted relative to
the 120-row run because the MIX changed (more challenging slash/mixed-hard rows were added), not
because either engine's behavior changed. Do not read this table as a model regression or
improvement vs the 120-row baseline; it is a different population.

| class            |                  v0 |     neural (v4.4.0) | Δ            |
| ---------------- | ------------------: | ------------------: | ------------ |
| apostrophe       |                89.0 |                79.5 | v0 +9.5      |
| bracketed        |                80.3 |                84.1 | neural +3.8  |
| care-of          |                60.8 |                74.5 | neural +13.7 |
| dotted           |                82.3 |                74.0 | v0 +8.3      |
| hyphen           |                86.9 |                82.8 | v0 +4.1      |
| mixed-hard       |     58.2 († 1 died) |                60.0 | neural +1.8  |
| paren-annotation |                78.4 |                87.5 | neural +9.1  |
| paren-component  |                76.5 |                80.4 | neural +3.9  |
| quoted-venue     |     75.3 († 1 died) |                66.7 | v0 +8.6      |
| slash            |                71.8 |                62.4 | v0 +9.4      |
| unbalanced       |                68.3 |                84.1 | neural +15.8 |
| **overall**      | **75.7** (2 deaths) | **75.3** (0 deaths) | tie (+0.4 v0)|
