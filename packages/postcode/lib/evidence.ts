/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What a value's form says about it as a postcode of one country: a whole code, a partial code, or neither.
 *
 *   A partial code is the leading part of a country's postcode that people write on its own: a GB outward code
 *   (`M11`, `SW1A`), a Canadian forward sortation area (`T2P`), an Irish Eircode routing key (`D02`).
 *   It covers an area much larger than a whole code covers.
 *   It also overlaps other things people write: `M11` is also a motorway.
 *   A partial reading is therefore its own, weaker kind of evidence, and it stays `partial` in every answer.
 */

import { acceptPostcode } from "#country-formats"

/**
 * The kind of evidence a value's form gives.
 */
export const PostcodeEvidenceKind = {
	/**
	 * The whole value has the country's complete postcode form.
	 */
	whole: "whole",
	/**
	 * The whole value has the form of the leading part of the country's postcode, and no complete form.
	 */
	partial: "partial",
} as const

export type PostcodeEvidenceKind = (typeof PostcodeEvidenceKind)[keyof typeof PostcodeEvidenceKind]

/**
 * A value's postcode evidence for one country.
 */
export interface PostcodeEvidence {
	readonly kind: PostcodeEvidenceKind
	/**
	 * The value as written, trimmed.
	 */
	readonly value: string
	/**
	 * The country's name for a partial form, such as `outward code`, or null for a whole code.
	 */
	readonly partialForm: string | null
}

interface PartialPostcodeForm {
	readonly name: string
	readonly pattern: RegExp
}

/**
 * The partial postcode forms people write on their own, by ISO 3166-1 alpha-2.
 *
 * A country belongs here when its whole code has a leading part that its postal
 * operator publishes as an area of its own.
 * Each pattern matches that part alone, case-insensitively.
 */
const PARTIAL_POSTCODE_FORMS: Readonly<Record<string, PartialPostcodeForm>> = {
	// Royal Mail's outward code: the postcode area and district, `M11`, `SW1A`, `EC1Y`.
	GB: { name: "outward code", pattern: /^[A-Z]{1,2}\d[A-Z\d]?$/iu },
	// Canada Post's forward sortation area, the first three characters of `T2P 1J9`.
	CA: { name: "forward sortation area", pattern: /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]$/iu },
	// An Eircode's routing key, the first three characters of `D02 AF30`, with Dublin 6W's `D6W`.
	IE: { name: "routing key", pattern: /^(?:[AC-FHKNPRTV-Y]\d{2}|D6W)$/iu },
}

/**
 * The postcode evidence `value`'s form gives for `countryCode`, or null when it gives none.
 *
 * A whole code is read with `acceptPostcode`, which ignores case and spacing.
 * A partial reading is returned only when the whole reading fails.
 */
export function postcodeEvidence(value: string, countryCode: string): PostcodeEvidence | null {
	const whole = acceptPostcode(value, countryCode)

	if (whole != null) return { kind: PostcodeEvidenceKind.whole, value: whole, partialForm: null }

	const form = PARTIAL_POSTCODE_FORMS[countryCode.toUpperCase()]
	const trimmed = value.trim()

	if (form?.pattern.test(trimmed)) {
		return { kind: PostcodeEvidenceKind.partial, value: trimmed, partialForm: form.name }
	}

	return null
}
