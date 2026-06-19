# @mailwoman/kind-classifier

**Stage 2.5 of the Mailwoman runtime pipeline** — query kind classification.

Categorizes an input into one of seven `QueryKind`s by composing rule-based
scorers over the `QueryShape` output. Returns possibilities (alternatives)
alongside the top pick so the coordinator can fall back when the winning kind
isn't actionable.

```ts
import { classifyKind } from "@mailwoman/kind-classifier";

const result = await classifyKind(queryShape, localeHint);
// result.kind → "structured_address"
// result.alternatives → [{kind: "intersection", confidence: 0.2}, ...]
```

## The seven query kinds

| Kind | Example |
|------|---------|
| `structured_address` | `"1600 Amphitheatre Pkwy, Mountain View, CA 94043"` |
| `postcode_only` | `"94043"` or `"SW1A 1AA"` |
| `locality_only` | `"Mountain View"` or `"San Francisco"` |
| `intersection` | `"Market St & Van Ness Ave"` |
| `po_box` | `"PO Box 12345"` |
| `landmark` | `"Eiffel Tower"` |
| `vague` | `"somewhere near the river"` |

## API

```ts
classifyKind(shape: QueryShapeLike, locale?: LocaleHint): Promise<QueryKindResult>
classifyKindSync(shape: QueryShapeLike, locale?: LocaleHint): QueryKindResult

// Individual scorers
scoreStructuredAddress(input: NormalizedInputLite, shape: QueryShapeLike): number
scorePostcodeOnly(shape: QueryShapeLike): number
scoreLocalityOnly(shape: QueryShapeLike): number
scoreIntersection(input: NormalizedInputLite, shape: QueryShapeLike): number
scorePoBox(input: NormalizedInputLite, shape: QueryShapeLike): number
scoreLandmark(shape: QueryShapeLike): number
scoreVague(shape: QueryShapeLike): number
```

## Pipeline position

```
locale-gate → kind-classifier → phrase-grouper → classifier → ...
```

## Design

- **Pure functions, no ML.** Rule-based v1; a trained classifier is deferred.
- **Returns alternatives.** The coordinator might skip a `locality_only` parse
  and fall back to a `vague` handler — the alternatives list makes that possible.
- **Consumes `QueryShape` + `LocaleHint`** from the two preceding stages.

## Related

- [`@mailwoman/query-shape`](../query-shape) — feeds structural data into this stage
- [`@mailwoman/locale-gate`](../locale-gate) — feeds locale context
- [`@mailwoman/phrase-grouper`](../phrase-grouper) — Stage 2.7, next in the pipeline
- [Staged Pipeline Contract](https://mailwoman.sister.software/articles/plan/reference/STAGES/)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
