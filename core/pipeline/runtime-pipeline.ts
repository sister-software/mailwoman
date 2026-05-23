/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `runPipeline` — the runtime coordinator that composes all six stages.
 *
 *   Generic over stage implementations (see `types.ts::RuntimePipelineStages`). Each stage is
 *   injected; the coordinator handles composition, timing, fast-path routing, and graceful
 *   degradation when stages are absent.
 *
 *   Implementation contract per `docs/articles/plan/reference/STAGES.md`.
 */

import type { AddressTree } from "../decoder/types.js"
import type {
	AddressClassifier,
	LocaleHint,
	LocaleTag,
	NormalizedInputLite,
	PipelineOpts,
	PipelineResult,
	QueryKindResult,
	QueryShapeLite,
	RuntimePipelineStages,
} from "./types.js"

/**
 * Known QueryShape format strings that indicate "this token is a postcode". Mirrors the set in
 *
 * @mailwoman/kind-classifier — kept duplicated so core/pipeline has no dep on kind-classifier.
 */
const POSTCODE_FORMATS: ReadonlySet<string> = new Set([
	"us_zip",
	"us_zip4",
	"uk_postcode",
	"fr_postcode",
	"de_postcode",
	"ca_postcode",
	"jp_postcode",
])

function isPostcodeFormat(format: string): boolean {
	return POSTCODE_FORMATS.has(format)
}

function isPostcodeFormatHit(hit: { format: string }): boolean {
	return isPostcodeFormat(hit.format)
}

/** Pass-through normalize used when no `normalize` stage is wired. */
function identityNormalize(raw: string, opts?: { locale?: string }): NormalizedInputLite {
	return { raw, normalized: raw, appliedLocale: opts?.locale }
}

/** No-op query-shape used when no `computeQueryShape` stage is wired. */
function emptyQueryShape(): QueryShapeLite {
	return { knownFormats: [] }
}

/** Default locale detector: trusts the caller's hint, or falls back to `und`. */
async function defaultDetectLocale(
	_input: NormalizedInputLite,
	_shape: QueryShapeLite,
	opts?: { hint?: LocaleTag }
): Promise<LocaleHint> {
	const locale = opts?.hint ?? "und"
	return {
		locale,
		confidence: opts?.hint ? 1.0 : 0.0,
		alternatives: [],
		source: opts?.hint ? "caller" : "detected",
	}
}

/** Default kind classifier: always returns `structured_address` with low confidence (no fast-path). */
async function defaultClassifyKind(
	_input: NormalizedInputLite,
	_shape: QueryShapeLite,
	_locale: LocaleHint
): Promise<QueryKindResult> {
	return {
		kind: "structured_address",
		confidence: 0.0,
		alternatives: [],
	}
}

/**
 * Decide whether to short-circuit stages 3-5 and go straight to resolve. Conservative: requires
 * high kind-classifier confidence AND a matching QueryShape known-format hit. See
 * `STAGES.md#fast-path-routing` for the rationale.
 */
function canShortCircuit(kind: QueryKindResult, shape: QueryShapeLite, opts?: PipelineOpts): boolean {
	if (opts?.forceFullPipeline) return false
	if (kind.confidence < 0.95) return false
	if (kind.kind === "postcode_only") {
		return shape.knownFormats.some(isPostcodeFormatHit)
	}
	if (kind.kind === "locality_only") {
		return (shape.totalLength ?? Infinity) <= 30 && shape.characterClass === "alpha"
	}
	return false
}

/**
 * Build a stub `AddressTree` for the fast-path case (no classifier ran). Single root node tagged by
 * the QueryShape's known-format hit.
 */
function buildFastPathTree(text: string, kind: QueryKindResult, shape: QueryShapeLite): AddressTree {
	if (kind.kind === "postcode_only") {
		const hit = shape.knownFormats.find((f) => isPostcodeFormat(f.format))
		if (hit) {
			return {
				raw: text,
				roots: [
					{
						tag: "postcode",
						value: text.slice(hit.span.start, hit.span.end),
						start: hit.span.start,
						end: hit.span.end,
						confidence: hit.confidence,
						children: [],
						source: "query-shape",
						sourceId: hit.format,
					},
				],
			}
		}
	}
	if (kind.kind === "locality_only") {
		return {
			raw: text,
			roots: [
				{
					tag: "locality",
					value: text.trim(),
					start: 0,
					end: text.length,
					confidence: kind.confidence,
					children: [],
					source: "query-shape",
					sourceId: "kind:locality_only",
				},
			],
		}
	}
	return { raw: text, roots: [] }
}

/**
 * Run the runtime pipeline.
 *
 * Composition order (per STAGES.md):
 *
 * 1. Normalize (or identity)
 * 2. Compute QueryShape (or empty)
 * 3. Locale gate (or caller-trust)
 * 4. Kind classifier (or default structured_address)
 * 5. Branch: fast-path → resolver; full → classifier → resolver
 *
 * Per-stage timing recorded on `result.timing`. Fast-path stages are absent from the timing map.
 */
export async function runPipeline(
	raw: string,
	stages: RuntimePipelineStages,
	opts?: PipelineOpts
): Promise<PipelineResult> {
	const timing: Record<string, number> = {}
	const t0 = performance.now()

	const normalize = stages.normalize ?? identityNormalize
	const computeQueryShape = stages.computeQueryShape ?? emptyQueryShape
	const detectLocale = stages.detectLocale ?? defaultDetectLocale
	const classifyKind = stages.classifyKind ?? defaultClassifyKind

	const normalized = normalize(raw, { locale: opts?.locale })
	timing["normalize"] = performance.now() - t0

	const tQs = performance.now()
	const queryShape = computeQueryShape(normalized, { locale: opts?.locale })
	timing["query-shape"] = performance.now() - tQs

	const tLocale = performance.now()
	const locale = await detectLocale(normalized, queryShape, { hint: opts?.locale })
	timing["locale-gate"] = performance.now() - tLocale

	const tKind = performance.now()
	const kind = await classifyKind(normalized, queryShape, locale)
	timing["kind-classifier"] = performance.now() - tKind

	// Fast-path: trivial inputs short-circuit stages 3-5. The fast-path tree is built from
	// QueryShape's format hits + kind alone — useful even without a wired resolver (a consumer
	// who just wants the parsed structure for a bare postcode shouldn't be forced to pay for the
	// classifier).
	if (canShortCircuit(kind, queryShape, opts)) {
		let tree = buildFastPathTree(normalized.normalized, kind, queryShape)
		if (stages.resolver) {
			const tResolve = performance.now()
			tree = await safeResolve(stages.resolver, tree, opts)
			timing["resolve"] = performance.now() - tResolve
		}
		return {
			input: raw,
			normalized,
			queryShape,
			locale,
			kind,
			tree,
			timing,
			path: "fast-path",
		}
	}

	// Full pipeline.
	let tree: AddressTree = { raw: normalized.normalized, roots: [] }
	if (stages.classifier) {
		const tClassify = performance.now()
		tree = await safeClassify(stages.classifier, normalized.normalized, queryShape)
		timing["token-classify"] = performance.now() - tClassify
	}

	if (stages.resolver) {
		const tResolve = performance.now()
		tree = await safeResolve(stages.resolver, tree, opts)
		timing["resolve"] = performance.now() - tResolve
	}

	return {
		input: raw,
		normalized,
		queryShape,
		locale,
		kind,
		tree,
		timing,
		path: "full",
	}
}

/** Defensive wrapper: if the classifier throws, return an empty tree rather than abort the pipeline. */
async function safeClassify(
	classifier: AddressClassifier,
	text: string,
	queryShape: QueryShapeLite
): Promise<AddressTree> {
	try {
		return await classifier.parse(text, { queryShape })
	} catch {
		return { raw: text, roots: [] }
	}
}

/** Defensive wrapper: a resolver failure leaves the classifier tree intact. */
async function safeResolve(
	resolver: NonNullable<RuntimePipelineStages["resolver"]>,
	tree: AddressTree,
	opts?: PipelineOpts
): Promise<AddressTree> {
	try {
		return await resolver.resolveTree(tree, opts?.resolveOpts)
	} catch {
		return tree
	}
}
