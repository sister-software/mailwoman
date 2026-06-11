# punctuation-stress.jsonl — gold conventions (#518)

~120 hand-curated rows across the punctuation classes our government-data evals never carry.
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
4. **Unbalanced delimiters**: gold includes stray quotes as they appear in the value when they are
   part of a real-world name (`Joe's "Pizza`); the load-bearing read is parse SURVIVAL + neighbor
   accuracy, captured per-row by the scorer (a thrown parse fails every component in the row).
5. **Dotted abbreviations**: values keep their dots as written (`P.O. Box 19`, `St. Louis`,
   `Washington D.C.`) — the span-bridge regression lens.
6. **Half addresses** (`123 1/2`) follow USPS convention: the fraction belongs to house_number.
7. Locale defaults US; `class` field drives the per-class report. Rows seeded from: the January
   experiment's tests (commit 10195ea), the v4.4.0 gate's measured classes, arena leftovers
   (Eduard-Sueß), and real-world named places chosen for their punctuation (Coeur d'Alene,
   Winston-Salem, Saint-Louis-du-Ha! Ha!).
