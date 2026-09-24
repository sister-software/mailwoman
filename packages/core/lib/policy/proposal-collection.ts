/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Run proposal classifiers over sections and optionally filter their results by policy.
 */

import type { PolicyRegistry } from "#policy/policy"
import type { Section } from "#types/classifier"
import type { ClassificationProposal, ClassifierContext, ProposalClassifier } from "#types/index"

/**
 * Run each classifier on each section.
 * Log failures and continue collecting other results.
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
				classifier.classify(section, context).catch((error) => {
					console.warn(`[proposal-collection] ${classifier.id} threw on section "${section.body}":`, error)

					return []
				})
			)
		}
	}

	const results = await Promise.all(tasks)

	return results.flat()
}

/**
 * Apply the supplied policy, or return a copy of the proposals when no policy is configured.
 */
export function filterByPolicy(
	proposals: readonly ClassificationProposal[],
	policy: PolicyRegistry | undefined,
	locale: string | undefined
): ClassificationProposal[] {
	if (!policy) return [...proposals]

	return policy.apply(proposals, locale)
}
