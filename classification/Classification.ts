/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export type ClassificationMetadata = Record<string, any>

/**
 * Base classification class.
 */
export class Classification {
	/**
	 * Whether the classification appears in results.
	 */
	public public: boolean = false

	/**
	 * The confidence of the classification.
	 */
	public confidence: number = 1.0

	/**
	 * The metadata of the classification.
	 */
	public meta: Record<string, any> = {}

	/**
	 * The label of the classification.
	 */
	public readonly label: string = "unknown"

	/**
	 * Create a classification.
	 *
	 * @param confidence - The confidence of the classification.
	 * @param meta - The metadata of the classification.
	 */
	constructor(confidence = 1, meta: ClassificationMetadata = {}) {
		this.public = false // only public classifications appear in results
		this.label = "unknown"
		this.confidence = confidence
		this.meta = meta
	}

	/**
	 * Compare this classification to another classification.
	 */
	equals(classification: Classification): boolean {
		// @todo: compare meta?
		return this.constructor.name === classification.constructor.name && this.confidence === classification.confidence
	}
}

export type ClassificationConstructor = new (confidence?: number, meta?: ClassificationMetadata) => Classification

/**
 * A configuration for a classifier scheme.
 */
export interface ClassifierSchemeConfig {
	/**
	 * The confidence level of the classification.
	 */
	confidence: number
	/**
	 * Constructor for the classification.
	 */
	Class: ClassificationConstructor
	/**
	 * A list of criteria that must be met for the classification to be applied.
	 */
	scheme: ClassifierSchemeCriteria[]
}

export interface ClassifierSchemeCriteria {
	/**
	 * The classification labels that must be present in the token.
	 */
	is: string[]
	/**
	 * The classification labels that must not be present in the token.
	 */
	not?: string[]
	/**
	 * Confidence level for the criteria.
	 */
	confidence?: number

	/**
	 * Constructor for the classification.
	 *
	 * @todo Is this used?
	 */
	Class?: ClassificationConstructor
}

/**
 * Extract the label from a classification constructor.
 *
 * This is useful for creating a union of classification labels, such as in public type definitions.
 */
export type ExtractClassificationLabel<T extends ClassificationConstructor> = Extract<
	InstanceType<T>,
	{
		readonly public: true
	}
>["label"]
