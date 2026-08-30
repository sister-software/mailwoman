# `data/` provenance

## `activity-lexicon.json` — the reviewed activity-phrase lexicon

- **Source:** `mailwoman-curated`, hand-maintained.
- **Authored:** 2026-08-27 (#1962).
- **Entries:** 11 surface forms, all naming the activity concept `obtain_medication`.
- **License:** AGPL-3.0-only OR LicenseRef-Commercial, with the rest of the repository. No third-party
  vocabulary is copied into it.

This file replaced a ten-phrase table written for one experiment, whose provenance said so in its
first sentence. A capability cannot rest on that, so every entry here names a record that attests it.

### What an entry may rest on

Four attestation classes are admissible, and each points at something already committed, so a reader
can check it rather than believe it. Nothing rests on observed traffic: this vocabulary carries no
measurement, and a consumer may not read it as one.

| `attestation.kind`    | What it points at                                                                  | What checks it                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `committed-query`     | A query row committed to this repository, by file and row id                       | The quoted query is compared against the committed row, and must contain the phrase as a subject   |
| `derived-form`        | Another entry, plus the regular transformation that produced this one              | The base must exist, must not itself be derived, and must carry the same activity and locale scope |
| `regional-register`   | A register split a committed vocabulary already records, plus the entry it mirrors | The referenced record must exist and carry exactly the locales the entry copied                    |
| `concept-description` | A clause of the activity concept's own description, quoted                         | The compiled concept's description must contain the quoted clause verbatim                         |

The first two checks run inside this package (`auditActivityLexicon`, which `readActivityLexicon`
refuses a failing lexicon on). The last two need artifacts this package does not depend on, and run
where those artifacts are held —
`packages/mailwoman/test/unit/eval-harness/activity-lexicon-attestation.test.ts`.

### What an entry may not do

- **Name an activity nothing affords.** A consumer resolves `activity` against a compiled artifact;
  a phrase naming an activity no entity kind both affords and maps into a searchable category would
  match a query and answer nothing, which reads as the query being unanswerable rather than as the
  vocabulary being wrong. The consumer refuses at construction — see
  `packages/mailwoman/observations/semantic-route.ts`.
- **Say anything about the world.** Which entity kinds afford the activity, in which country, with
  what modality and on whose authority come from `@mailwoman/geographic-model`. An entry that
  restated any of it would be a second copy of a claim with no provenance behind it.
- **Carry a weight.** There is no field for a preference, a boost or an order, and adding one would
  put candidate ordering in a vocabulary.

### Locale scope

Scoping follows the `@mailwoman/variant-aliases` semantics: an exact tag match answers at full
strength, a language-only match at half, and nothing else answers. An absent `locales` list means
unscoped and is not the same as an empty one — a phrase scoped to nowhere can never fire, and the
audit refuses it.

A scoped entry does not answer when the locale is unknown. That is deliberate: a phrasing declared
regional cannot be reached without knowing the region, or the record means something other than what
it says.

### Adding an entry

1. Write the phrase and the activity it names.
2. Name the record that attests it, in one of the four classes above, and quote the text it rests on.
3. Write the note a future reviewer would need to decide whether the entry still belongs.
4. Run the phrase-collision census
   (`node packages/mailwoman/dev-tools/activity-phrase-collision-census.run.ts --db <poi.db>`) and
   commit the refreshed report. A new phrase whose subject a name or category lexicon already claims
   never reaches an activity route at all, and the census is where that is visible.
5. Bump `version`.

Reviewed curation caps how fast this file grows, which is the point. Free phrase authoring would
reintroduce through recognition exactly the unaudited breadth the program forbids in semantics.
