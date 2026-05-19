/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Parser-level proposal pipeline.
 *
 *   Stitches together three pieces that already exist independently:
 *
 *   1. Per-section fan-out across a list of `ProposalClassifier`s (rule or neural — same shape).
 *   2. `PolicyRegistry.apply()` filters the merged proposal stream by per-component policy modes.
 *   3. Surviving proposals are written back into the `TokenContext` as legacy `Classification`s the
 *        solver can read.
 *
 *   Pure module: no resource imports, no top-level await. Safe to import from anywhere.
 */

import type { PolicyRegistry } from "../../policy/policy.js"
import type { Span, TokenContext } from "../tokenization/index.js"
import {
	type ClassificationProposal,
	type ClassifierContext,
	type ComponentTag,
	componentTagToLegacyClassification,
	type ProposalClassifier,
} from "../types/index.js"

/**
 * Run every classifier against every section, concatenate the results.
 *
 * Classifiers that throw are isolated — their failure logs but does not block other classifiers'
 * proposals from being collected. (Per the `ProposalClassifier` contract, implementations are
 * supposed to swallow errors, but defense-in-depth lives here.)
 */
export async function collectProposals(
	sections: readonly Span[],
	classifiers: readonly ProposalClassifier[],
	context: ClassifierContext = {}
): Promise<ClassificationProposal[]> {
	const tasks: Array<Promise<ClassificationProposal[]>> = []
	for (const classifier of classifiers) {
		for (const section of sections) {
			tasks.push(
				classifier.classify(section, context).catch((err) => {
					// eslint-disable-next-line no-console
					console.warn(`[proposal-pipeline] ${classifier.id} threw on section "${section.body}":`, err)
					return []
				})
			)
		}
	}
	const results = await Promise.all(tasks)
	return results.flat()
}

/**
 * Optional policy filter. Returns the input unchanged when `policy` is undefined, otherwise
 * delegates to `PolicyRegistry.apply`.
 */
export function filterByPolicy(
	proposals: readonly ClassificationProposal[],
	policy: PolicyRegistry | undefined,
	locale: string | undefined
): ClassificationProposal[] {
	if (!policy) return [...proposals]
	return policy.apply(proposals, locale)
}

/**
 * Locate the context Span whose [start, end] best matches the given char range.
 *
 * Strategy:
 *
 * - Prefer an exact match on both `start` and `end`.
 * - Fall back to the smallest enclosing span (start ≤ target.start && end ≥ target.end).
 * - Returns null if nothing covers the range — the caller drops the proposal silently.
 */
export function findSpanByRange(context: TokenContext, start: number, end: number): Span | null {
	let best: Span | null = null
	let bestWidth = Infinity
	for (const span of iterateContextSpans(context)) {
		if (span.start === start && span.end === end) return span
		if (span.start <= start && span.end >= end) {
			const width = span.end - span.start
			if (width < bestWidth) {
				best = span
				bestWidth = width
			}
		}
	}
	return best
}

/**
 * Walk every span attached to a `TokenContext` — sections, words, phrases — in a single flat pass.
 * Order isn't guaranteed.
 */
export function* iterateContextSpans(context: TokenContext): Generator<Span> {
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

export interface WritebackResult {
	written: number
	skippedNoLegacyMap: number
	skippedNoSpan: number
}

/**
 * Write each surviving proposal back to the context's span graph as a legacy `Classification` so
 * the solver can read it. Returns a small summary useful for telemetry and tests.
 */
export function writeProposalsToContext(
	proposals: readonly ClassificationProposal[],
	context: TokenContext
): WritebackResult {
	let written = 0
	let skippedNoLegacyMap = 0
	let skippedNoSpan = 0

	for (const proposal of proposals) {
		const legacy = componentTagToLegacyClassification(proposal.component as ComponentTag)
		if (!legacy) {
			skippedNoLegacyMap++
			continue
		}
		const span = findSpanByRange(context, proposal.span.start, proposal.span.end)
		if (!span) {
			skippedNoSpan++
			continue
		}
		span.classifications.add(legacy, proposal.confidence)
		written++
	}

	return { written, skippedNoLegacyMap, skippedNoSpan }
}

/** Combined entrypoint: collect + filter + write. Returns the (post-filter) proposal list. */
export async function runProposalPipeline(
	context: TokenContext,
	classifiers: readonly ProposalClassifier[],
	options: { policy?: PolicyRegistry; locale?: string; classifierContext?: ClassifierContext } = {}
): Promise<{ proposals: ClassificationProposal[]; writeback: WritebackResult }> {
	const raw = await collectProposals(context.sections, classifiers, options.classifierContext ?? {})
	const filtered = filterByPolicy(raw, options.policy, options.locale)
	const writeback = writeProposalsToContext(filtered, context)
	return { proposals: filtered, writeback }
}
