/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Adapter that wraps Mailwoman's legacy mutation-based rule classifiers (`classifyTokens(context):
 *   void`) into the proposal-emitting contract declared in `@mailwoman/core/types` (#6).
 *
 *   Phase 0 contract scaffolding: the adapter lets a single rule classifier be exposed as a
 *   `ProposalClassifier`. The exhaustive one-wrapper-per-classifier sweep + solver rewire is a
 *   follow-up; see Phase 0 task 3 success criteria in plan #8.
 */

import {
	type Classification,
	type Classifier as LegacyClassifier,
	type ClassifierConstructor as LegacyClassifierConstructor,
	type ClassifierOptions as LegacyClassifierOptions,
} from "@mailwoman/core/classification"
import { Span, TokenContext } from "@mailwoman/core/tokenization"
import {
	type ClassificationProposal,
	type ClassifierContext,
	type ComponentTag,
	legacyClassificationToComponentTag,
	type ProposalClassifier,
	type Section,
} from "@mailwoman/core/types"

/**
 * Options describing how to wrap a legacy classifier in the proposal interface.
 */
export interface WrapLegacyClassifierOptions {
	/** Stable identifier for this classifier; used as `source_id`. */
	id: string

	/** Legacy classifier instance or constructor. */
	classifier: LegacyClassifier | LegacyClassifierConstructor

	/**
	 * Constructor options forwarded when `classifier` is a constructor. Ignored when it's already an instance.
	 */
	classifierOptions?: LegacyClassifierOptions

	/**
	 * `ComponentTag`s this classifier may emit. Proposals carrying a tag not in this set are dropped (with a console
	 * warning in development).
	 */
	emits: readonly ComponentTag[]

	/**
	 * Legacy classification tags this classifier is known to produce. The wrapper traverses the span graph for spans
	 * bearing one of these tags. Defaults to "any tag with a `ComponentTag` mapping."
	 */
	legacyTags?: readonly Classification[]

	/**
	 * Locales this classifier is active for. `["*"]` (locale-agnostic) by default — matches the pre-refactor behavior.
	 */
	locales?: readonly (string | "*")[]

	/** Default penalty applied to emitted proposals. */
	penalty?: number

	/**
	 * Override the default mapping for a legacy → component pair. Returning `null` drops the proposal.
	 */
	mapTag?: (legacy: Classification) => ComponentTag | null
}

/**
 * Wrap a single legacy rule classifier as a `ProposalClassifier`.
 *
 * Mechanics:
 *
 * 1. The legacy classifier is instantiated (if a constructor) and its `ready()` step is awaited.
 * 2. On `classify(section)`, a fresh local `TokenContext` is built around the section's body text so legacy mutations
 *    don't bleed into the caller's graph.
 * 3. After `classifyTokens(localContext)` runs, the wrapper walks all spans (sections, words, phrases) and collects spans
 *    bearing any of the wrapper's `legacyTags`.
 * 4. Each such (span, classification) pair becomes a `ClassificationProposal`. The span is re-anchored to the caller's
 *    section so character offsets are correct relative to the original input.
 *
 * Note on isolation: building a fresh `TokenContext` is deliberately coarse — it ignores any prior classifications from
 * earlier classifiers in the pipeline. Composite classifiers that depend on upstream tags will need a different bridge;
 * that lives in a higher-level orchestrator, not in this adapter.
 */
export function wrapLegacyClassifier(options: WrapLegacyClassifierOptions): ProposalClassifier {
	const {
		id,
		classifier: classifierOrCtor,
		classifierOptions,
		emits,
		legacyTags,
		locales = ["*"],
		penalty = 0,
		mapTag,
	} = options

	const instance: LegacyClassifier =
		typeof classifierOrCtor === "function" ? new classifierOrCtor(classifierOptions) : classifierOrCtor

	const tagFilter: (legacy: Classification) => ComponentTag | null =
		mapTag ??
		((legacy) => {
			const mapped = legacyClassificationToComponentTag(legacy)

			return mapped && emits.includes(mapped) ? mapped : null
		})

	const expectedLegacy = legacyTags ? new Set<Classification>(legacyTags) : null

	let readyPromise: Promise<void> | null = null

	function ensureReady(): Promise<void> {
		if (!instance.ready) return Promise.resolve()
		readyPromise ??= instance.ready().then(() => undefined)

		return readyPromise
	}

	async function runOnSection(section: Section): Promise<ClassificationProposal[]> {
		await ensureReady()

		const localContext = new TokenContext(section.body)
		instance.classifyTokens(localContext)

		const sectionOffset = section.start
		const proposals: ClassificationProposal[] = []

		for (const span of iterateSpans(localContext)) {
			for (const [legacy, match] of span.classifications) {
				if (expectedLegacy && !expectedLegacy.has(legacy)) continue

				const component = tagFilter(legacy)

				if (!component) continue

				if (!emits.includes(component)) continue

				proposals.push({
					span: rebaseSpan(span, sectionOffset),
					component,
					confidence: match.confidence,
					source: "rule",
					source_id: id,
					penalty,
					metadata: {
						legacyClassification: legacy,
						...(match.languages ? { languages: Array.from(match.languages) } : {}),
						...(match.flags ? { flags: Array.from(match.flags) } : {}),
					},
				})
			}
		}

		return proposals
	}

	const wrapped: ProposalClassifier = {
		id,
		emits,
		locales,
		ready: () => ensureReady(),
		classify: (section, _context: ClassifierContext) => runOnSection(section),
	}

	return wrapped
}

/**
 * Walk every span attached to a `TokenContext` — sections, words, and phrases — in a single flat pass. Order is not
 * guaranteed.
 */
export function* iterateSpans(context: TokenContext): Generator<Span> {
	const visited = new Set<number>()
	const queue: Span[] = []

	if (context.span) queue.push(context.span)

	for (const section of context.sections) queue.push(section)

	while (queue.length > 0) {
		const span = queue.pop()!

		if (visited.has(span.id)) continue
		visited.add(span.id)
		yield span

		for (const child of span.children) queue.push(child)

		for (const phrase of span.phrases) queue.push(phrase)
	}
}

/**
 * Produce a Span whose character offsets are anchored to the caller's original input (not the local context's). The
 * returned span is a thin clone for use in proposals; the source span continues to live in the local TokenContext.
 */
function rebaseSpan(span: Span, sectionOffset: number): Span {
	if (sectionOffset === 0) return span

	const rebased = Span.from(span.body, { start: span.start + sectionOffset })

	return rebased
}
