# @mailwoman/locale-gate

**Stage 2 of the Mailwoman runtime pipeline** — rule-based locale detection.

Derives a `LocaleHint` from the structural fingerprint computed by
`@mailwoman/query-shape`. Uses only universal cues — script class, postcode
patterns, known-format hits — never place-name dictionaries. Returns a ranked
list of candidates so the coordinator can surface disagreement when the
caller's explicit `--locale` hint differs from what the input shape implies.

```ts
import { detectLocale } from "@mailwoman/locale-gate"

const hint = detectLocale(queryShape, {})
// hint.primary → "en-US"
// hint.alternatives → [{tag: "en-GB", confidence: 0.3}, ...]
// hint.detectorDisagreement → false
```

## API

```ts
detectLocale(shape: QueryShapeLike, opts?: DetectLocaleOpts): LocaleHint
detectLocaleSync(shape: QueryShapeLike, opts?: DetectLocaleOpts): LocaleHint

// Individual scorers (for custom composition)
scoreByScript(shape: QueryShapeLike): LocaleCandidate[]
scoreByPostcode(shape: QueryShapeLike): LocaleCandidate[]
scoreFallback(shape: QueryShapeLike): LocaleCandidate[]
```

## Pipeline position

```
query-shape → locale-gate → kind-classifier → phrase-grouper → classifier → ...
```

Stage 2 in the [Staged Pipeline Contract](https://mailwoman.sister.software/articles/plan/reference/STAGES/).

## Design

- **Rule-based v1.** The locale gate scores candidate locales by composing
  deterministic rules over the `QueryShape`. A trained character-level model
  is deferred to a future release.
- **Bitter-lesson-safe:** script class, postcode regex patterns, known-format
  hits. No place-name memorization.
- **Surfaces disagreement.** When the caller passes an explicit `--locale`
  hint and the gate disagrees, the hint carries `detectorDisagreement: true`
  so the coordinator can decide.

## Related

- [`@mailwoman/query-shape`](../query-shape) — feeds `QueryShape` into this stage
- [`@mailwoman/kind-classifier`](../kind-classifier) — Stage 2.5, also consumes `QueryShape`
- [`@mailwoman/core`](../core) — `LocaleTag` type and pipeline infrastructure
- [Staged Pipeline Contract](https://mailwoman.sister.software/articles/plan/reference/STAGES/)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
