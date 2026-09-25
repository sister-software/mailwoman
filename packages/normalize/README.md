# @mailwoman/normalize

This package is **stage 1 of the Mailwoman runtime pipeline**, which performs
deterministic input preprocessing.

It provides pure-function text normalization that prepares free-text address
strings for later parsing stages. Every transform produces an `offsetMap`, so
later stages can map normalized-string spans back to raw-string character
offsets.

```ts
import { normalize } from "@mailwoman/normalize"

const result = normalize("123  Main   St.")
// result.normalized → "123 Main St."
// result.offsetMap  → maps each normalized char back to raw
```

## What it does

| Transform                     | Purpose                                                                     |
| ----------------------------- | --------------------------------------------------------------------------- |
| **NFC normalization**         | Unicode canonical composition                                               |
| **Punctuation normalization** | Smart-quotes → straight, fullwidth → ASCII, elision/apostrophe preservation |
| **Whitespace collapse**       | Multi-space, tab, non-breaking → single space; leading/trailing trim        |
| **Abbreviation expansion**    | Opt-in: `"St."` → `"Street"`, `"Ave"` → `"Avenue"` etc.                     |
| **CJK normalization**         | CJK-specific whitespace and punctuation handling                            |

## API

```ts
// Full normalization pipeline (NFC → punctuation → whitespace)
normalize(input: string, opts?: NormalizeOpts): NormalizedInput

// Individual transforms (if you need only one)
applyNfc(input: string): NormalizedInput
applyPunctuation(input: string): NormalizedInput
collapseWhitespace(input: string): NormalizedInput
expandAbbreviations(input: string, opts?: ExpandOpts): NormalizedInput
applyCjkNormalization(input: string): CjkResult

// Offset map utilities
composeMaps(inner: OffsetMap, outer: OffsetMap): OffsetMap
identityMap(length: number): OffsetMap
```

## Pipeline position

```
raw string → normalize → query-shape → locale-hint → kind-classifier → phrase-grouper → ...
```

This package is stage 1 in the [Staged Pipeline Interface](https://github.com/sister-software/mailwoman/blob/main/docs/engineering/reference/STAGES.mdx). It has no runtime dependencies.

## Design

- **Pure functions without side effects or ML.** The output is byte-for-byte deterministic for the same input.
- **Every transform maintains `offsetMap`.** Each transform tracks how normalized positions map back to raw input positions. The parser needs this map to report spans in the original string.
- **Configurable through `NormalizeOpts`:** toggle `expandAbbreviations`, `normalizeCase`, and `cjk`.

## Related

- [`@mailwoman/query-shape`](../query-shape): stage 1.5, the structural priors that consume the normalized output.
- [Staged Pipeline Interface](https://github.com/sister-software/mailwoman/blob/main/docs/engineering/reference/STAGES.mdx)
- [Tokenization concepts](https://mailwoman.ai/articles/concepts/tokenization/)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/AGPL-3.0.html)
