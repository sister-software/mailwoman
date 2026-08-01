# The libpostal dictionaries — provenance, consumers, and the curated-data layering

These dictionaries came with Mailwoman's Pelias/libpostal roots: per-language equivalence tables
(`canonical|variant|variant…`, one class per line) that libpostal uses for classification and
expansion, across 61 language directories. In Mailwoman v1 they fed the rules classifiers
directly. **The rules parser was deleted in v7.0.0** — since then their role has flipped from
_runtime classifier fuel_ to _curation source material_, and this file records exactly who still
reads what, so nobody has to re-derive it (audited 2026-08-01; re-run the sweep before trusting
this list across major refactors).

## Who reads what (the complete consumer map)

| File                                                                    | Consumer                                                                                                | What it feeds                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<lang>/directionals.txt`                                               | `mailwoman/gazetteer-pipeline/evidence-lexicons.ts` (curation languages)                                | The **law-1 directional closure**: locality evidence may never paint onto a directional-ish surface (the v3.19 lesson — US neighbourhoods literally named "Northeast" truncated "3rd Ave NE"). Reaches the model through the locality-surface evidence channel. |
| `en/directionals.txt`, `en/street_types.txt`                            | `corpus/src/adapters/tiger/street-decompose.ts`                                                         | Splitting raw TIGER street strings into prefix/name/suffix for BIO training gold.                                                                                                                                                                               |
| `fr/street_types.txt`                                                   | `corpus/src/adapters/ban/street-decompose.ts`                                                           | Same, for BAN.                                                                                                                                                                                                                                                  |
| `<lang>/street_types.txt` (all 60 locales that ship one)                | `mailwoman/gazetteer-pipeline/street-morphology.ts` (+ the `gazetteer build street-morphology` command) | `fst-street-morphology.bin` — the browser street-affix gate (survey #1, shipped v8.1.0).                                                                                                                                                                        |
| `all/given_names.txt`, `all/surnames.txt`, `<lang>/personal_titles.txt` | `evidence-lexicons.ts`                                                                                  | The **person-name tier**: 1-token person-name surfaces blocked as locality evidence.                                                                                                                                                                            |
| `<lang>/stopwords.txt`                                                  | `mailwoman/gazetteer-pipeline/fst.ts`                                                                   | FST gazetteer curation.                                                                                                                                                                                                                                         |

Everything else — 34 of the 40 distinct filenames (`chains.txt`, `near.txt`, `cross_streets.txt`,
`unit_types_*`, `level_types_*`, `qualifiers.txt`, …) — has **no code consumer** since the rules
excision, and `core/resources/libpostal.ts`'s generic loader (`prepareLocaleIndex`,
`generatePlurals`) has no production caller either (only its own test). Total vestigial mass:
~0.13 MB of the ~0.7 MB dictionary tree.

**Deliberately kept anyway.** Deleting buys ~130 KB and costs provenance: the files stay
byte-comparable with the upstream lineage, and several vestigial classes are plausible inputs to
named future work (the `unit_types_*`/`level_types_*`/`staircases.txt` families are libpostal's
unit-parsing vocabulary — relevant when JP floor/unit conventions land with the CJK arc). The
exotic-POI query surface was explicitly checked before this call: franchise/variant/amenity
queries run on their own curated tables (`poi-taxonomy`'s phrase table + `variant-aliases`), not
on these dictionaries — `kind-classifier` declares "no dictionaries in-tree" as an invariant.

## The curated-data layering (where these sit in the "dictionary" landscape)

Mailwoman has four curated-data families that all look like "dictionaries" from a distance.
They answer different questions and live in different places on purpose:

| Tier               | Question it answers                       | Contents                                                               | Lives in                                                                                                  |
| ------------------ | ----------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Spelling**       | how is text spelled into the model?       | 73k learned subword pieces                                             | the SentencePiece vocab (inside the weights; welded to trained BIO spans)                                 |
| **Closed classes** | what are the function words of addresses? | directionals, street types, unit types — small, enumerable, stable     | **these dictionaries** + `@mailwoman/codex` → consumed at build/training time (lexicons, FSTs, synthesis) |
| **Open classes**   | what places exist?                        | millions of changing place names                                       | the WOF gazetteer + FST evidence channels + the resolver (never in the weights)                           |
| **Query idiom**    | what do people call things?               | brand/variant/amenity phrases (`servo` → fuel, `Macca's` → McDonald's) | `poi-taxonomy` + `variant-aliases`                                                                        |

The old allow/block semantics didn't die with the rules parser — they migrated up a level into
the **lexicon curation laws** (law-1: directionals never carry locality evidence; the person-name
tier) and the graded surface-ambiguity classes in the FST rows. Blocking became a condition on
_evidence painting_ instead of a hard token gate: the open-world version of the same intent.

## Descriptive here, normative in codex

`en/directionals.txt` includes `lower`, `upper`, `middle`, `central` — none of which USPS
recognizes. That's correct _for this file's job_: its consumers are recall-shaped ("don't paint
locality evidence on anything even directional-ish"). The **normative** tables — USPS Pub-28
verbatim, preferred abbreviations, branded types — live in `@mailwoman/codex` (see
`codex/us/street-suffix.ts`, `codex/us/street-directional.ts`) and serve the precision-shaped
jobs: synthesis recipes, invariance transforms, formatting. The two overlap by design and must
not be merged: broadening codex breaks formatting; narrowing this file weakens the evidence
guard.
