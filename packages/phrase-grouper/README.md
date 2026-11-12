# @mailwoman/phrase-grouper

**Stage 2.7 of the Mailwoman runtime pipeline** — phrase boundary discovery.

Proposes coherent input units with a structural kind hypothesis and confidence.
Decouples boundary discovery from type classification: Stage 3 conditions on
these proposals so it answers the simpler "what type is this proposed span?"
rather than jointly discovering boundaries and types.

```ts
import { groupPhrasesSync } from "@mailwoman/phrase-grouper"
import { computeQueryShape } from "@mailwoman/query-shape"

const text = "1600 Amphitheatre Parkway, Mountain View, CA 94043"
const proposals = groupPhrasesSync({ raw: text, normalized: text }, computeQueryShape(text))
// 12 overlapping proposals, highest confidence first. The first four:
// [
//   { span: { body: "1600", start: 0, end: 4, … }, kindHypothesis: "NUMERIC", confidence: 0.95 },
//   { span: { body: "Amphitheatre Parkway", start: 5, end: 25, … }, kindHypothesis: "STREET_PHRASE", confidence: 0.9 },
//   { span: { body: "Mountain View", start: 27, end: 40, … }, kindHypothesis: "STREET_PHRASE", confidence: 0.75 },
//   { span: { body: "CA", start: 42, end: 44, … }, kindHypothesis: "REGION_ABBREVIATION", confidence: 0.7 },
//   …
// ]
```

## What it proposes

| Phrase kind           | Triggers                                                    |
| --------------------- | ----------------------------------------------------------- |
| `street_phrase`       | Number + capitalized words, hyphenated street names         |
| `locality_phrase`     | Capitalized word sequence after comma, near region/postcode |
| `venue_phrase`        | Capitalized word sequence at the start of a street phrase   |
| `postcode`            | Known postcode format (ZIP5, UK outward, etc.)              |
| `region_abbreviation` | US state / CA province / AU state abbreviations             |
| `numeric`             | Standalone number (potential house number)                  |
| `hyphenated_compound` | Hyphenated pairs (`Jean-Jacques`, `Winston-Salem`)          |

## API

```ts
groupPhrases(
  input: NormalizedInputLite,
  shape: QueryShapeLike,
  locale?: LocaleHint
): Promise<PhraseProposal[]>

groupPhrasesSync(
  input: NormalizedInputLite,
  shape: QueryShapeLike,
  locale?: LocaleHint
): PhraseProposal[]
```

## Pipeline position

```
kind-classifier → phrase-grouper → classifier (neural/rule-based) → ...
```

## Design

- **Boundary discovery rather than classification.** The phrase grouper answers "where
  are the coherent units?" — the classifier answers "what _type_ is each unit?"
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
- [The Knowledge Ladder](https://mailwoman.post/articles/concepts/the-knowledge-ladder/) — design rationale
- [Staged Pipeline Interface](https://github.com/sister-software/mailwoman/blob/main/docs/records/plan/reference/STAGES.mdx)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/AGPL-3.0.html)
