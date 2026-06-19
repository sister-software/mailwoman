# @mailwoman/query-shape

**Stage 1.5 of the Mailwoman runtime pipeline** — cheap structural priors.

Pure functions that compute a structural fingerprint of an address string in
microseconds — character class, segmentation, known-format detection — without
any ML or place-name dictionaries. The `QueryShape` result informs later
pipeline stages (locale detection, kind classification, phrase grouping).

```ts
import { computeQueryShape } from "@mailwoman/query-shape"

const shape = computeQueryShape("1600 Amphitheatre Parkway, Mountain View, CA 94043")
// shape.script → "Latin"
// shape.hasDigits → true
// shape.segments → [{text: "1600 Amphitheatre Parkway", ...}, {text: "Mountain View", ...}, ...]
// shape.knownFormats → [{type: "us_zip5", text: "94043"}, {type: "us_state_abbr", text: "CA"}]
```

## What it computes

| Signal                     | Purpose                                                                        |
| -------------------------- | ------------------------------------------------------------------------------ |
| **Character class**        | Per-codepoint and per-token script classification (Latin, CJK, Cyrillic, etc.) |
| **Segmentation**           | Split into punctuation-bounded segments (comma, newline, tab)                  |
| **Known-format detection** | Regex hits for postcode patterns, state abbreviations, PO box formats          |
| **Region abbreviations**   | US/CA/AU state/province abbreviation detection                                 |
| **Whitespace pattern**     | Input shape (`structured`, `single_line`, `free_text`)                         |

## API

```ts
computeQueryShape(input: string, opts?: ComputeQueryShapeOpts): QueryShape

// Individual detectors
classifyCodepoint(cp: number): CharacterClass
classifyToken(token: string): TokenClass
detectKnownFormats(segments: Segment[]): KnownFormatHit[]
detectRegionAbbreviations(segments: Segment[]): RegionAbbreviationHit[]
segment(input: string): Segment[]
```

## Pipeline position

```
normalize → query-shape → locale-gate → kind-classifier → phrase-grouper → ...
```

## Design

- **Pure, zero-dependency, microseconds-cheap.** No ML inference, no I/O, no place-name dictionaries.
- **Bitter-lesson-safe:** only universal structural cues — script class, format regexes, segmentation
  punctuation. Never memorizes locale-specific place names.
- Accepts a minimal `NormalizedInputLite` (just `{raw, normalized}` strings) from Stage 1.

## Related

- [`@mailwoman/normalize`](../normalize) — Stage 1, feeds into this stage
- [`@mailwoman/locale-gate`](../locale-gate) — Stage 2, consumes `QueryShape` for locale detection
- [`@mailwoman/kind-classifier`](../kind-classifier) — Stage 2.5, consumes `QueryShape` for kind classification
- [Query Shape design rationale](https://mailwoman.sister.software/articles/plan/reference/QUERY_SHAPE/)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
