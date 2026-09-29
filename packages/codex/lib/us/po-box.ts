/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * USPS PO Box detection and normalization.
 *
 * Supports common forms like "P.O. Box", "Post Office Box", and "Box".
 * Exposes helpers to detect ({@link isPOBox}), normalize ({@link normalizePOBox}),
 * and extract ({@link matchPOBox}) PO Box values.
 *
 * @see {@link https://pe.usps.com/text/pub28/28c2_012.htm USPS Pub 28 §29 (PO Box / Caller service)}
 */

/**
 * USPS phrases that can introduce a PO Box ID.
 *
 * Ordered longest-first so specific phrases match before broad ones.
 */
export const US_PO_BOX_DESIGNATORS = [
	"POST OFFICE BOX",
	"PO BOX",
	"P O BOX",
	"FIRM CALLER",
	"CALLER",
	"DRAWER",
	"LOCKBOX",
	"BOX",
] as const satisfies readonly string[]

export type USPoBoxDesignator = (typeof US_PO_BOX_DESIGNATORS)[number]

/**
 * Recognition patterns for {@link US_PO_BOX_DESIGNATORS}.
 *
 * Keep regex patterns next to canonical designators.
 */
const PO_BOX_DESIGNATOR_PATTERNS: ReadonlyArray<readonly [USPoBoxDesignator, string]> = [
	["POST OFFICE BOX", String.raw`post\s+office\s+box`],
	["PO BOX", String.raw`p\.?\s*o\.?\s*box`],
	["P O BOX", String.raw`p\.?\s*o\.?\s*box`],
	["FIRM CALLER", String.raw`firm\s+caller`],
	["CALLER", "caller"],
	["DRAWER", "drawer"],
	["LOCKBOX", "lockbox"],
	["BOX", "box"],
]

/**
 * One matcher per USPS designator.
 *
 * Ids are alphanumeric and may include dashes.
 */
const PO_BOX_MATCHERS = PO_BOX_DESIGNATOR_PATTERNS.map(([designator, pattern]) => ({
	designator,
	designatorRe: new RegExp(String.raw`^\s*${pattern}\s*$`, "i"),
	phraseRe: new RegExp(String.raw`^\s*(${pattern})\s*#?\s*([\dA-Za-z][\dA-Za-z-]*)\s*$`, "i"),
}))

/**
 * Returns true when `input` is only a USPS PO Box designator phrase.
 *
 * Useful when callers need to separate USPS terms from local aliases.
 */
export function isUSPoBoxDesignator(input: unknown): input is string {
	return typeof input === "string" && PO_BOX_MATCHERS.some(({ designatorRe }) => designatorRe.test(input))
}

/**
 * Returns true when input looks like a PO Box address.
 *
 * Matching is case-insensitive and tolerant of punctuation/spacing differences.
 */
export function isPOBox(input: unknown): boolean {
	return matchPOBox(input) !== null
}

/**
 * Parsed PO Box parts.
 */
export interface PoBoxMatch {
	/**
	 * Designator phrase as written in input, like "P.O.
	 * Box".
	 */
	matched: string
	/**
	 * Box id, like "123" or "12-A".
	 */
	id: string
}

/**
 * If `input` is a PO Box phrase, return the matched phrase and id.
 *
 * Returns null when there is no match.
 */
export function matchPOBox(input: unknown): PoBoxMatch | null {
	if (typeof input !== "string") return null

	for (const { phraseRe } of PO_BOX_MATCHERS) {
		const match = phraseRe.exec(input)

		if (match) return { matched: match[1]!.trim(), id: match[2]! }
	}

	return null
}

/**
 * Normalize recognized PO Box phrases to "PO BOX <id>".
 *
 * @returns Original input when no PO Box is found.
 */
export function normalizePOBox(input: string): string {
	const m = matchPOBox(input)

	if (!m) return input

	return `PO BOX ${m.id.toUpperCase()}`
}
