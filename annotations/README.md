# @mailwoman/annotations

The composer for [Mailwoman](https://mailwoman.sister.software)'s OpenCage-style enrichment block. A
resolved coordinate gets enriched with derived data — timezone, UN/LOCODE, ISO/NUTS, coordinate formats
(DMS/MGRS/geohash/Maidenhead/Mercator), calling code, currency, sun times.

```ts
import { composeAnnotators, toOpenCage, type Annotator } from "@mailwoman/annotations"

const annotate = composeAnnotators([coordinateFormats, countryReference, timezone])
const set = await annotate({ lat: 38.8977, lon: -77.0365 })

// native (camelCase) for our own API:
set.timezone?.name // "America/New_York"

// OpenCage-keyed for the compat APIs:
toOpenCage(set).timezone // { name: "America/New_York", offset_sec: -18000 }
```

## Design

`AnnotationSet` is the native typed representation (camelCase, source of truth). Each recipe package
implements `Annotator` — `(input: { lat, lon, place? }) => Partial<AnnotationSet>` — and fills the slice
it owns; `composeAnnotators` runs them concurrently and merges, skipping any that throw. Two serializers,
`toOpenCage()` and `toNative()`, render the set at the API edge. One schema, two shapes (the hybrid
decision).

Recipe packages: coordinate formats live in [`@mailwoman/spatial`](../spatial), country reference in
[`@mailwoman/codex`](../codex), and the data-backed lookups ship standalone
([`@mailwoman/timezone-lookup`](../timezone-lookup), [`@mailwoman/un-locode-lookup`](../un-locode-lookup)).
