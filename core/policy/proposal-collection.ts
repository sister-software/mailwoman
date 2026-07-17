/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generic proposal collection + policy filtering.
 *
 *   Fan a list of `ProposalClassifier`s out across a list of sections, then optionally filter the
 *   merged proposal stream through a `PolicyRegistry`. Both classifier families (neural, and any
 *   future rule wrapper) satisfy the same `ProposalClassifier` shape, so this pair is engine-neutral.
 *
 *   Rehomed here from the (deleted) `core/parser/proposal-pipeline.ts` during the v7 rules-parser
 *   excision — the parser-era `TokenContext` writeback half went with the solver; these two generic
 *   helpers survive because the neural `--policy` CLI path still uses them.
 *
 *   Pure module: no resource imports, no top-level await. Safe to import from anywhere.
 */

import type { Section } from "../types/classifier.ts"
import { type ClassificationProposal, type ClassifierContext, type ProposalClassifier } from "../types/index.ts"
import type { PolicyRegistry } from "./policy.ts"

/**
 * Run every classifier against every section, concatenate the results.
 *
 * Classifiers that throw are isolated — their failure logs but does not block other classifiers' proposals from being
 * collected. (Per the `ProposalClassifier` contract, implementations are supposed to swallow errors, but
 * defense-in-depth lives here.)
 */
export async function collectProposals(
	sections: readonly Section[],
	classifiers: readonly ProposalClassifier[],
	context: ClassifierContext = {}
): Promise<ClassificationProposal[]> {
	const tasks: Array<Promise<ClassificationProposal[]>> = []

	for (const classifier of classifiers) {
		for (const section of sections) {
			tasks.push(
				classifier.classify(section, context).catch((err) => {
					console.warn(`[proposal-collection] ${classifier.id} threw on section "${section.body}":`, err)

					return []
				})
			)
		}
	}
	const results = await Promise.all(tasks)

	return results.flat()
}

/**
 * Optional policy filter. An explicit `policy` registry is authoritative; without one the input is returned unchanged.
 */
export function filterByPolicy(
	proposals: readonly ClassificationProposal[],
	policy: PolicyRegistry | undefined,
	locale: string | undefined
): ClassificationProposal[] {
	if (!policy) return [...proposals]

	return policy.apply(proposals, locale)
}
