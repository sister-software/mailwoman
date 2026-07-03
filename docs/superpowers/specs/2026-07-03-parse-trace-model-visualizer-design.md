# Parse trace + `<ModelVisualizer>` — design

**Date:** 2026-07-03
**Status:** approved (operator, this session)
**Owners:** neural (`@mailwoman/neural`), docs (`@mailwoman/docs`), CLI (`mailwoman`)

## Problem

Three needs share one missing artifact:

1. **Customer diagnosis** — a user confused by a geocoder result should be able to follow, on the
   site, where the parse went right or wrong: what the model saw, what it believed, and which
   later pass overrode it.
2. **CLI trace** — the same follow-along from the terminal, emittable as JSON (support/bug-report
   artifact) or a mermaid diagram.
3. **Marketing** — a "look inside the model" visual with real data, on the demo/docs site.

Today the interior of a parse is discarded. `NeuralAddressClassifier.#decode`
(`neural/classifier.ts`) computes every intermediate — soft-feature channels, raw logits, locale
head, post-prior emissions, viterbi path, repair mutations — and returns only tokens (+ raw
logits/pieces via `parseWithLogits`). Nothing downstream can show _why_ a token got its tag.

## Decision summary

One serializable, versioned **trace artifact** produced by the shared decode path; renderers stay
dumb consumers of it:

```
              ┌─ <ModelVisualizer> (docs/demo, React)        … need 1, 3
trace JSON ───┼─ mailwoman parse --trace json|mermaid        … need 2
              └─ attached to bug reports / support threads    … need 1
```

- **Producer seam:** a new `traceParse(text, opts)` method on `NeuralAddressClassifier`,
  implemented by _retaining_ what `#decode` already computes. `#decode` remains the single decode
  path (#481 invariant) — trace retention happens inside it, never beside it. `parse` and
  `parseWithLogits` stay byte-stable.
- **Envelope scope:** pipeline-wide from day one. `PipelineResult` (`core/pipeline/types.ts:271`)
  already carries per-stage artifacts (`normalized`, `queryShape`, `locale`, `kind`,
  `phraseProposals`, `tree`, `timing`, `path`); the trace envelope wraps that and adds the neural
  stage payload now, reserving keys for resolver detail later. No schema churn when stages join.
- **Rejected alternatives:**
  - _Docs-local feed reconstruction_ (rebuild anchor/gazetteer channels in the docs layer via
    `buildSoftFeatures`): forks the feed choreography — the exact train/inference drift class the
    codebase forbids.
  - _Overloading `parseWithLogits`:_ muddies its documented purpose (per-span logit aggregation
    for joint-reconcile) and perturbs existing callers' contract.

## 1. Trace contract

Types live where their producers live; the envelope composes them.

### `NeuralParseTrace` (new, `@mailwoman/neural`, exported from `index.ts`)

Everything below is what `#decode` already computes, keyed by the moment the model's opinion was
formed or overridden:

| Field             | Source in `#decode`              | Notes                                                                                                                                |
| ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `text`            | `modelText` after case-normalize | the string the model actually saw                                                                                                    |
| `caseNormalized`  | `normalizeInputCase` applied?    | boolean                                                                                                                              |
| `pieces`          | tokenizer `encode`               | `{ piece, start, end }[]`                                                                                                            |
| `ids`             | tokenizer `encode`               | `number[]`                                                                                                                           |
| `anchor?`         | `buildSoftFeatures`              | `SoftFeatureChannel` as fed (post-choreography)                                                                                      |
| `gazetteer?`      | `buildSoftFeatures`              | `SoftFeatureChannel` as fed (post-suppression)                                                                                       |
| `logits`          | runner output                    | raw, pre-prior — the model's emissions                                                                                               |
| `localeLogits?`   | runner output                    | 9-wide, `LOCALE_COUNTRIES` order                                                                                                     |
| `detectedSystem?` | `detectAddressSystem`            | `SystemCode \| null` + whether pinned vs auto                                                                                        |
| `priors`          | prior-builder calls              | list of `{ kind, applied }` for queryShape / fst / streetMorphology / spanProposer / conventionsMask — which actually fired          |
| `emissions`       | post-prior matrix                | what viterbi actually decoded over                                                                                                   |
| `labels`          | `this.labels`                    | the 33-label vocabulary, for axis labeling                                                                                           |
| `path`            | viterbi / argmax                 | label indices + per-token confidence                                                                                                 |
| `repairs`         | repair passes                    | ordered `{ pass, before, after }` token diffs for wordConsistency / postcodeRepair / unitRepair / spanBridge — empty entries omitted |
| `tokens`          | final                            | the same `DecoderToken[]` `parse` would produce                                                                                      |

All arrays are plain numbers/strings — JSON-serializable by construction. Feature matrices are
small (≤ seq×11 floats) so no truncation is needed.

### Envelope (`ParseTrace`, added with increment 3)

```
{ schemaVersion: 1, input, pipeline?: <PipelineResult minus tree-duplicates>, neural?: NeuralParseTrace, resolve?: <reserved> }
```

Increment 1 ships only `NeuralParseTrace`; the envelope type is declared alongside the CLI/pipeline
threading in increment 3, keyed so earlier consumers never break (`resolve` reserved from day one).

## 2. Producer seam — `traceParse`

- `#decode` gains a private `trace?: boolean` parameter; when set, its return widens to include
  the intermediates listed above. Non-trace calls must not pay for copies — retention is
  capture-by-reference of arrays `#decode` already built; the only new allocations are the
  repair before/after snapshots, taken only when tracing.
- Public API: `async traceParse(text: string, opts?: ParseOpts): Promise<NeuralParseTrace>`.
  Same opts as `parse`, same decode path, same repairs.
- `parse` / `parseWithLogits` byte-stable (existing tests are the guard).
- Browser reachability: `loadNeuralClassifierFromUrls` (`neural-web/loader.ts`) returns a real
  `NeuralAddressClassifier`, and the docs webpack alias bundles neural-web from workspace source —
  so `traceParse` is reachable on the site with no npm release.

## 3. Site renderer — `<ModelVisualizer>`

`docs/src/components/ModelVisualizer/` (follows the existing component-per-directory convention;
peers: `SubwordExplorer`, `BIOHighlight`, `PipelineExplorer`).

- Data source: `useDemoEmbed()` — the classifier is already loaded from production Hugging Face
  bucket assets, so local docs dev works with no lab data root.
  `MailwomanClassifierLike` (docs context type) gains `traceParse`.
- v1 renders four horizontal bands from one trace, sharing an x-axis of pieces:
  1. **Token ribbon** — pieces with char offsets; hover = id + offsets.
  2. **Channel band** — anchor/gazetteer confidence + feature heat per piece (the
     retrieval-augmented "what the atlas already knew").
  3. **Emissions heatmap** — labels × tokens; toggle raw `logits` vs post-prior `emissions`
     (the delta _is_ the priors' influence); conventions-masked cells marked.
  4. **Decode band** — viterbi path + confidence; repair diffs highlighted as
     before → after chips.
     Locale head renders as a side gauge (9 bars, `LOCALE_COUNTRIES` order).
- Marketing polish (animation, guided narrative) layers onto this same component later —
  explicitly out of v1 scope.

## 4. CLI — `mailwoman parse --trace <json|mermaid>`

- `--trace json`: the envelope verbatim to stdout — the support/bug-report artifact; a customer's
  exact trace is reproducible from the JSON alone.
- `--trace mermaid`: compact text flowchart rendered from the same trace (stages, per-stage
  verdicts, repair overrides).
- SVG output **deferred**: needs a DOM-less renderer; revisit after the React bands exist to
  steal layout from.
- Threading: `runPipeline` gains an opt-in trace flag that calls `traceParse` (when the classifier
  exposes it) and attaches the neural trace to the envelope alongside the `PipelineResult` fields.

## 5. Increments

1. `NeuralParseTrace` type + `traceParse` + tests (`@mailwoman/neural`).
2. `<ModelVisualizer>` v1 in docs (neural stage only, via `useDemoEmbed`).
3. CLI `--trace json|mermaid` + `runPipeline` threading + `ParseTrace` envelope type.
4. Resolver stage payload joins the envelope (key already reserved).

Each increment is independently shippable; 2 and 3 are parallel once 1 lands.

## Error handling

- `traceParse("")` mirrors `parse("")`: empty trace (`pieces: []`, `tokens: []`), no throw.
- Models without the locale head: `localeLogits`/`detectedSystem` absent, renderer hides the gauge.
- Channel-off classifiers (no anchor lookup / lexicon configured): `anchor`/`gazetteer` absent;
  renderer shows the channel band as "not fed" rather than zeros — an unfed channel is a
  diagnostic fact (the #566/#685 OOD class), not an empty one.
- CLI `--trace` on a pipeline whose classifier lacks `traceParse` (stale compiled tree, foreign
  classifier): envelope ships without the `neural` key + a stderr note — never a crash.

## Testing

- **Parity (the load-bearing test):** for a corpus of addresses, `traceParse(text).tokens` must
  deep-equal `parse(text)`'s tokens under identical opts — proves the no-fork invariant.
- **Byte-stability:** existing `parse`/`parseWithLogits` suites unchanged and green.
- **Schema snapshot:** one serialized trace committed as a fixture; drift fails the test and
  forces a conscious `schemaVersion` decision.
- **Docs:** component renders from a canned trace fixture (no model download in CI), plus the
  existing storybook convention (`*.stories.tsx`) for visual review.
- **CLI:** golden-file test for `--trace mermaid` on a fixed input; `--trace json` validated
  against the schema fixture.

## Non-goals (v1)

- SVG emission from the CLI.
- Resolver/gazetteer candidate traces (increment 4 reserves the key; design when it lands).
- Any change to training-side Python or the ONNX export.
- Exposing attention weights or other _inside-the-graph_ tensors — the trace covers the model's
  I/O contract and the decode pipeline around it, not transformer internals. (Netron already
  serves the op-graph view; revisit only if a concrete need appears.)
