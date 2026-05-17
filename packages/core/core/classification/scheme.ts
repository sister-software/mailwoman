/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { Span } from "@mailwoman/core/tokenization"
import type { Classification } from "./Classification.js"

/**
 * A configuration for a classifier scheme.
 */
export interface ClassifierSchemeConfig {
	classification?: Classification

	/**
	 * The confidence level of the classification.
	 *
	 * @default 1
	 */
	confidence?: number
	/**
	 * A list of criteria that must be met for the classification to be applied.
	 */
	// scheme: ClassifierSchemeCriteria | ClassifierSchemeCriteria[]
	scheme: ClassifierSchemeCriteria[]
}

export interface ClassifierSchemeCriteria {
	/**
	 * ID for the sub-classification.
	 */
	classification?: Classification

	/**
	 * The classification labels that must be present in the token.
	 */
	is: Classification[]

	/**
	 * The classification labels that must not be present in the token.
	 */
	not?: Classification[]
	/**
	 * Confidence level for the criteria.
	 */
	confidence?: number
}

/**
 * Determine if a phrase matches a classifier scheme.
 */
export function phraseMatchesScheme({ is, not }: ClassifierSchemeCriteria, phrase: Span): boolean {
	const { children } = phrase

	if (!Array.isArray(is)) return false

	// Does the phrase include at least one of the target classifications?
	if (!is.some((cl) => phrase.is(cl))) {
		// Is this a multi-word phrase
		if (children.size !== 1) return false

		// this is a single-word phrase, also check the classification of its single child
		if (!is.some((cl) => children.first?.is(cl))) {
			return false
		}
	}

	// 'not' is an optional property
	if (!Array.isArray(not)) return true

	// phrase does include at least one of the target classifications
	if (not.some((cl) => phrase.is(cl))) return false

	// this is a single-word phrase, check the classification of it's single child
	if (children.size === 1) {
		if (not.some((cl) => children.first!.is(cl))) {
			return false
		}
	}

	return true
}
