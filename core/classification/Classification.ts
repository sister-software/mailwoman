/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Displayable } from "../resources/debugging.js"
import type { Alpha3bLanguageCode } from "../resources/languages/index.js"
import type { LibPostalLanguageCode } from "../resources/libpostal.js"

/**
 * Classification recognized by Mailwoman.
 */
export const Classifications = new Set([
	"adjacent",
	"alpha",
	"alphanumeric",
	"area",
	"chain",
	"country",
	"dependency",
	"directional",
	"end_token_single_character",
	"end_token",
	"given_name",
	"house_number",
	"intersection",
	"level_designator",
	"level",
	"locality",
	"middle_initial",
	"multistreet",
	"numeric",
	"ordinal",
	"person",
	"personal_suffix",
	"personal_title",
	"place",
	"postcode",
	"punctuation",
	"region",
	"road_type",
	"start_token",
	"stop_word",
	"street_name",
	"street_prefix",
	"street_proper_name",
	"street_suffix",
	"street",
	"surname",
	"toponym",
	"unit_designator",
	"unit",
	"unknown",
	"venue",
] as const)

export type Classification = typeof Classifications extends Set<infer T> ? T : never

const ClassificationConfidenceBias = new Map<Classification, number>([["country", 0.9]])

/**
 * Public classification labels.
 */
const VisibleClassification = new Set([
	"country",
	"dependency",
	"house_number",
	"level_designator",
	"level",
	"locality",
	"postcode",
	"region",
	"street",
	"unit_designator",
	"unit",
	"venue",
] as const satisfies Classification[])

/**
 * Classification labels that are exposed to API consumers.
 */
export type VisibleClassification = typeof VisibleClassification extends Set<infer T> ? T : never

/**
 * Type guard for visible classification labels.
 */
export function isVisibleClassification(
	match: ClassificationMatch
): match is ClassificationMatch & { classification: VisibleClassification }
export function isVisibleClassification(classification: Classification): classification is VisibleClassification
export function isVisibleClassification(input: Classification | ClassificationMatch): input is VisibleClassification {
	const classification = typeof input === "string" ? input : input.classification

	return VisibleClassification.has(classification as VisibleClassification)
}

export type ClassificationMap = Map<VisibleClassification, string[]>
export type ClassificationConfidenceMap = Map<VisibleClassification, number>
export type ClassificationConfidenceRecord = Record<VisibleClassification, number | undefined>
export type ClassificationRecord = Partial<Record<VisibleClassification, string[]>>

/**
 * A classification match for a span of text.
 */
export interface ClassificationMatch {
	/**
	 * The classification assigned to the text.
	 */
	readonly classification: Classification

	/**
	 * The confidence of the classification.
	 */
	readonly confidence: number

	/**
	 * Languages for which the classification is valid.
	 *
	 * If a language is present in this set, it means that the value which it is associated with is a
	 * valid value in that language.
	 */
	readonly languages?: Displayable<ReadonlySet<LibPostalLanguageCode | Alpha3bLanguageCode>>

	/**
	 * Flags associated with the classification, i.e. clarifying details to enhance the
	 * classification.
	 */
	readonly flags?: Set<string>
}

export type ClassificationsMatchInput = ClassificationMatch | Classification

/**
 * A map of classifications to matches.
 */
export class ClassificationsMatchMap extends Map<Classification, ClassificationMatch> {
	/**
	 * Add a classification to the map if it has a higher confidence than the existing classification.
	 */
	public add(classification: Classification, confidence?: number): void
	public add(classificationMatch: Partial<ClassificationMatch>): void
	public add(...args: [Partial<ClassificationMatch>] | [Classification, number?]): void {
		let match: Partial<ClassificationMatch>

		if (typeof args[0] === "string") {
			const classification = args[0]
			const confidence = typeof args[1] === "number" ? args[1] : (ClassificationConfidenceBias.get(classification) ?? 1)

			match = {
				classification,
				confidence,
			}
		} else {
			match = {
				...args[0],
				confidence: args[0].confidence ?? ClassificationConfidenceBias.get(args[0].classification!) ?? 1,
			}
		}

		if (!match.classification) {
			throw new TypeError("Classification must be a non-empty string")
		}

		if (typeof match.confidence !== "number") {
			throw new TypeError("Confidence must be a number")
		}

		if (match.confidence < 0) {
			throw new RangeError(
				`${match.classification}: Confidence must be greater than or equal to 0: ${match.confidence}`
			)
		}

		if (match.confidence > 1) {
			throw new RangeError(`${match.classification}: Confidence must be less than or equal to 1: ${match.confidence}`)
		}

		const existing = this.get(match.classification)

		// Ensure that duplicate classifications do not reduce confidence
		if (existing && existing.confidence >= match.confidence) {
			return
		}

		this.set(match.classification, match as ClassificationMatch)
	}

	/**
	 * Predicate to determine if the map contains a classification that is visible.
	 */
	public hasVisibleClassification(classification?: VisibleClassification): boolean {
		return classification ? this.has(classification) : Iterator.from(this.keys()).some(isVisibleClassification)
	}

	/**
	 * Serialize the classification map to JSON.
	 */
	public override toJSON(): ClassificationMatch[] {
		return this.values().toArray()
	}

	static from(...input: ClassificationsMatchInput[]): ClassificationsMatchMap {
		const map = new ClassificationsMatchMap()

		for (const entry of input) {
			map.add(entry as ClassificationMatch)
		}

		return map
	}
}
