# @mailwoman/normalize

**Stage 1 of the Mailwoman runtime pipeline** — deterministic input preprocessing.

Pure-function text normalization that prepares free-text address strings for
downstream parsing stages. Every transform produces a load-bearing `offsetMap`
so downstream stages can map normalized-string spans back to raw-string character
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
| **Abbreviation expansion**    | Opt-in — `"St."` → `"Street"`, `"Ave"` → `"Avenue"` etc.                    |
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
raw string → normalize → query-shape → locale-gate → kind-classifier → phrase-grouper → ...
```

Stage 1 in the [Staged Pipeline Contract](https://mailwoman.sister.software/articles/plan/reference/STAGES/). No runtime dependencies.

## Design

- **Pure functions, no side effects, no ML.** The output is byte-for-byte deterministic for the same input.
- **`offsetMap` is load-bearing.** Every transform tracks how normalized positions map back to raw input positions. This is essential for the parser to report spans in the original string.
- **Configurable via `NormalizeOpts`:** toggle `expandAbbreviations`, `normalizeCase`, and `cjk`.

## Related

- [`@mailwoman/query-shape`](../query-shape) — Stage 1.5, structural priors that consume the normalized output
- [Staged Pipeline Contract](https://mailwoman.sister.software/articles/plan/reference/STAGES/)
- [Tokenization concepts](https://mailwoman.sister.software/articles/concepts/tokenization/)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
