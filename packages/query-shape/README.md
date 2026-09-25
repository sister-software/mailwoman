# @mailwoman/query-shape

This package is **stage 1.5 of the Mailwoman runtime pipeline**, which computes
cheap structural priors.

Its pure functions compute a structural fingerprint of an address string in
microseconds. The fingerprint covers character class, segmentation, and
known-format detection, and it uses no ML or place-name dictionaries. Later
pipeline stages (locale detection, kind classification, phrase grouping) read
the `QueryShape` result.

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
normalize → query-shape → locale-hint → kind-classifier → phrase-grouper → ...
```

## Design

- **Pure, dependency-free, and fast.** Each call takes microseconds and uses no ML inference, I/O, or
  place-name dictionaries.
- **Universal cues only.** The package uses only universal structural cues: script class, format
  regexes, and segmentation punctuation. It never memorizes locale-specific place names.
- It accepts a minimal `NormalizedInputLite` (only the `{raw, normalized}` strings) from stage 1.

## Related

- [`@mailwoman/normalize`](../normalize): stage 1, which feeds this stage.
- [`@mailwoman/locale-hint`](../locale-hint): stage 2, which reads `QueryShape` for locale detection.
- [`@mailwoman/kind-classifier`](../kind-classifier): stage 2.5, which reads `QueryShape` for kind classification.
- [Query Shape design rationale](https://github.com/sister-software/mailwoman/blob/main/docs/engineering/reference/QUERY_SHAPE.mdx)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/AGPL-3.0.html)
