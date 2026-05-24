---
sidebar_position: 14
title: The pipeline contract
---

# The pipeline contract

You don't have to take Mailwoman's pipeline as-is. The runtime coordinator (`createRuntimePipeline`) accepts each of the six stages as an injectable function or interface; an integrator can swap any of them for a custom implementation without forking the core.

This article is the practical "how do I plug in" companion to:

- [The staged pipeline](../understanding/the-staged-pipeline.md) — the narrative for _why_ the stages exist
- [STAGES.md (reference)](../plan/reference/STAGES.md) — the full per-stage contract with type definitions, error semantics, and edge cases

Read those first if you're new. Use this page when you already know the shape and want to ship a custom stage.

## Stage signatures

```ts
import type { RuntimePipelineStages } from "@mailwoman/core/pipeline"

interface RuntimePipelineStages {
	normalize?: (raw: string, opts?: { locale?: string }) => NormalizedInputLite
	computeQueryShape?: (input: NormalizedInputLite | string, opts?: { locale?: string }) => QueryShapeLite
	detectLocale?: (input: NormalizedInputLite, shape: QueryShapeLite, opts?: { hint?: LocaleTag }) => Promise<LocaleHint>
	classifyKind?: (input: NormalizedInputLite, shape: QueryShapeLite, locale: LocaleHint) => Promise<QueryKindResult>
	classifier?: { parse(text: string, opts?: { queryShape?: QueryShapeLite }): Promise<AddressTree> }
	resolver?: { resolveTree(tree: AddressTree, opts?: ResolveOpts): Promise<AddressTree> }
}
```

Every stage is **optional**. When you omit one, the coordinator either substitutes a no-op stub (`normalize`, `computeQueryShape`, `detectLocale`, `classifyKind`) or skips the stage entirely (`classifier`, `resolver`).

## Replacing a stage

```ts
import { createRuntimePipeline } from "mailwoman"

const myLocaleDetector = async (input, shape, opts) => {
	if (opts?.hint) return { locale: opts.hint, confidence: 1.0, alternatives: [], source: "caller" }
	// Your detection logic here — fastText, a CLD, an LLM, whatever.
	const guess = await myModel.classify(input.normalized)
	return { locale: guess.tag, confidence: guess.score, alternatives: [], source: "detected" }
}

const pipeline = createRuntimePipeline({
	detectLocale: myLocaleDetector,
	// Other stages default to the shipped implementations.
})

const result = await pipeline("8 rue Lafayette, Paris")
```

Same pattern for any stage. The defaults you don't override (e.g. `@mailwoman/normalize`, `@mailwoman/query-shape`, `@mailwoman/kind-classifier`) keep running.

## Error semantics

Not every stage failure is treated the same. The coordinator distinguishes **graceful** stages (failure produces a degraded but valid result) from **non-graceful** stages (failure surfaces to the caller).

| Stage                  | If it throws                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normalize`            | Propagates. Input preprocessing is a contract; a crash is a bug.                                                                                   |
| `computeQueryShape`    | Propagates. Same rationale.                                                                                                                        |
| `detectLocale`         | Propagates. A locale detector that crashes signals a real fault, not noise.                                                                        |
| `classifyKind`         | Propagates. Kind classification runs on the QueryShape we just computed — there's nothing external that can poison it.                             |
| `classifier.parse`     | **Swallowed.** Returns an empty `AddressTree`; pipeline continues. The classifier runs against external weights / arbitrary user input; defensive. |
| `resolver.resolveTree` | **Swallowed.** Returns the classifier's tree unchanged. Backend may be unavailable; we surface what we have rather than fail the whole call.       |

This asymmetry is intentional. Stages 1, 2, 2.5 are pure functions over the input; if they crash, something is wrong with the request shape and the caller needs to know. Stages 3 and 6 are wrapped because their dependencies (ONNX model, SQLite database, network) are points where production failures legitimately happen and degrading gracefully beats taking the whole query down.

## Cancellation

`PipelineOpts.signal: AbortSignal` is honored **between stages**, not within them.

```ts
const controller = new AbortController()
setTimeout(() => controller.abort(), 100)

try {
	const result = await pipeline("…", { signal: controller.signal })
} catch (err) {
	// err.name === "AbortError" if the coordinator caught the signal between stages.
	// err is whatever you passed to controller.abort(reason) if you supplied a reason.
}
```

If you abort while a stage is mid-execution, that stage runs to completion before the abort takes effect. The longest cancellation latency is one stage's runtime — typically the neural classifier (~10-70ms p99 for the en-US weights). Fine-grained mid-stage cancellation is a future enhancement that requires plumbing `signal` into each stage's contract.

Aborting before any stage runs throws immediately. Aborting between stages skips the rest of the pipeline.

## Timing budget

`PipelineResult.timing` records per-stage wall time in milliseconds. The keys present depend on the path the coordinator took:

| Key               | Always present                        | Notes                                                   |
| ----------------- | ------------------------------------- | ------------------------------------------------------- |
| `normalize`       | yes                                   |                                                         |
| `query-shape`     | yes                                   |                                                         |
| `locale-gate`     | yes                                   |                                                         |
| `kind-classifier` | yes                                   |                                                         |
| `token-classify`  | full path only, when classifier wired | Absent on fast-path; absent when no classifier injected |
| `resolve`         | when resolver wired                   | Present on both full and fast-path                      |

The `path` field tells you which branch ran: `"full"` (stages 3-5 ran) or `"fast-path"` (kind classifier + QueryShape agreed on a trivial input, stages 3-5 skipped, tree built from QueryShape alone).

Use `mailwoman parse --benchmark <N>` for percentile breakdowns over many iterations against a real input.

## Fast-path criteria

The coordinator short-circuits stages 3-5 when:

1. `forceFullPipeline` is **not** set on `PipelineOpts`, AND
2. `classifyKind` returned `confidence ≥ 0.95`, AND
3. The kind matches a known shape signal:
   - `postcode_only` → QueryShape has a postcode `knownFormats` hit
   - `locality_only` → `totalLength ≤ 30` AND `characterClass === "alpha"`

The fast-path tree is built from QueryShape's format hit alone — useful even without a resolver wired (a consumer who just wants the parsed structure for `"10118"` shouldn't pay for the classifier).

## When to swap a stage

Common reasons:

- **Custom locale detector** — replace `detectLocale` with a fastText / cld3 / commercial detector when you have a specific traffic profile
- **In-process resolver** — swap `resolver` for an embedded WOF SQLite or in-memory gazetteer
- **Different classifier** — your own ONNX model, a rule-based classifier, a remote inference endpoint
- **Test fakes** — every stage takes a vi.fn() / sinon stub directly; no special harness needed

You should **not** swap a stage to bypass it cheaply. If you want the pipeline without locale detection, pass `{ locale: "en-US" }` on every call — the default `detectLocale` is already a sub-microsecond caller-trust stub. The performance you'd reclaim by swapping is rounding error against the neural classifier's milliseconds.

## See also

- [STAGES.md](../plan/reference/STAGES.md) — the full per-stage type contract
- [The staged pipeline](../understanding/the-staged-pipeline.md) — why these stages exist
- [QUERY_SHAPE.md](../plan/reference/QUERY_SHAPE.md) — the structural-prior sub-system feeding stages 2 and 2.5
