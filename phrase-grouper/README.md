# @mailwoman/phrase-grouper

**Stage 2.7 of the Mailwoman runtime pipeline** — phrase boundary discovery.

Proposes coherent input units with a structural kind hypothesis and confidence.
Decouples boundary discovery from type classification: Stage 3 conditions on
these proposals so it answers the simpler "what type is this proposed span?"
rather than jointly discovering boundaries and types.

```ts
import { groupPhrases } from "@mailwoman/phrase-grouper";

const groups = groupPhrases(normalizedInput, queryShape, localeHint);
// groups → [
//   {text: "1600 Amphitheatre Parkway", kind: "street_phrase", confidence: 0.95},
//   {text: "Mountain View", kind: "locality_phrase", confidence: 0.8},
//   {text: "CA", kind: "region_abbreviation", confidence: 0.99},
//   {text: "94043", kind: "postcode", confidence: 0.98},
// ]
```

## What it proposes

| Phrase kind | Triggers |
|-------------|----------|
| `street_phrase` | Number + capitalized words, hyphenated street names |
| `locality_phrase` | Capitalized word sequence after comma, near region/postcode |
| `venue_phrase` | Leading capitalized word sequence before a street phrase |
| `postcode` | Known postcode format (ZIP5, UK outward, etc.) |
| `region_abbreviation` | US state / CA province / AU state abbreviations |
| `numeric` | Standalone number (potential house number) |
| `hyphenated_compound` | Hyphenated pairs (`Jean-Jacques`, `Winston-Salem`) |

## API

```ts
groupPhrases(
  input: NormalizedInputLite,
  shape: QueryShapeLike,
  locale?: LocaleHint
): Promise<PhraseGroup[]>

groupPhrasesSync(
  input: NormalizedInputLite,
  shape: QueryShapeLike,
  locale?: LocaleHint
): PhraseGroup[]
```

## Pipeline position

```
kind-classifier → phrase-grouper → classifier (neural/rule-based) → ...
```

## Design

- **Boundary discovery, not classification.** The phrase grouper answers "where
  are the coherent units?" — the classifier answers "what *type* is each unit?"
  This separation makes both problems easier.
- **Bitter-lesson-safe:** uses only universal structural cues (proximity,
  punctuation, capitalization, hyphenation, format-shape repetition). Never
  place-name dictionaries. A learned span proposer is reserved for a future
  release.
- **Rule-based v1.** Ships in `@mailwoman/phrase-grouper`; consumed by the
  pipeline coordinator in `@mailwoman/core`.

## Related

- [`@mailwoman/core`](../core) — pipeline coordinator that consumes phrase groups
- [`@mailwoman/kind-classifier`](../kind-classifier) — preceding stage
- [The Knowledge Ladder](https://mailwoman.sister.software/articles/concepts/the-knowledge-ladder/) — design rationale
- [Staged Pipeline Contract](https://mailwoman.sister.software/articles/plan/reference/STAGES/)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
