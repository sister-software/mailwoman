/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   USPS Publication 28's secondary unit designators as cited postal-unit rules. The designators
 *   and their approved abbreviations are {@linkcode US_UNIT_DESIGNATOR_PREFERRED_ABBR}, and whether
 *   one takes a number is {@linkcode US_UNIT_DESIGNATOR_REQUIRES_RANGE}. This module adds the
 *   citation of Appendix C2 to each rather than holding a second designator table, and adds the two
 *   placement rules of section 213.
 *
 * @see {@link https://pe.usps.com/text/pub28/28apc_003.htm USPS Pub 28 Appendix C2 (Secondary Unit Designators)}
 * @see {@link https://pe.usps.com/text/pub28/28c2_003.htm USPS Pub 28 §213 (Secondary Address Unit Designators)}
 */

import type { PostalGuidelineCitation, PostalUnitGuidelineRule } from "#postal-guideline"
import {
	US_UNIT_DESIGNATOR_PREFERRED_ABBR,
	US_UNIT_DESIGNATOR_REQUIRES_RANGE,
	type USUnitDesignator,
} from "#us/unit-designator"

const PUB_28 = {
	document: "Publication 28 - Postal Addressing Standards",
	publisher: "United States Postal Service",
	edition: "undated (Postal Explorer HTML edition)",
	fetched: "2026-10-20",
} as const satisfies Partial<PostalGuidelineCitation>

const APPENDIX_C2 = {
	...PUB_28,
	section: "Appendix C2 Secondary Unit Designators",
	url: "https://pe.usps.com/text/pub28/28apc_003.htm",
	sha256: "f831863e368a76df7bb170f5ac3a2e4264aab671f434b5142413f8de0d8a6717",
} as const satisfies Omit<PostalGuidelineCitation, "quote" | "transcription">

const SECTION_213 = {
	...PUB_28,
	url: "https://pe.usps.com/text/pub28/28c2_003.htm",
	sha256: "3ce26415cc5cd131d533aa95d33408bb5ed546a4125bb365000c619ce087b49d",
} as const satisfies Omit<PostalGuidelineCitation, "quote" | "transcription" | "section">

const C2_KINDS: Partial<Record<USUnitDesignator, PostalUnitGuidelineRule["kind"]>> = {
	BASEMENT: "level",
	BUILDING: "building",
	FLOOR: "level",
	LOBBY: "interior",
	LOWER: "level",
	PENTHOUSE: "level",
	UPPER: "level",
}

/**
 * Title-cases a C2 description as the table prints it (`APARTMENT` → `Apartment`).
 */
function c2Description(designator: USUnitDesignator): string {
	// The C2 table spells the description `Hanger`.
	if (designator === "HANGAR") return "Hanger"

	return designator.charAt(0) + designator.slice(1).toLowerCase()
}

/**
 * One cited rule per Pub 28 Appendix C2 designator.
 *
 * The quote is the designator's table row: its description and approved abbreviation.
 */
export const US_UNIT_GUIDELINE_RULES: readonly PostalUnitGuidelineRule[] = (
	Object.keys(US_UNIT_DESIGNATOR_PREFERRED_ABBR) as USUnitDesignator[]
).map((designator) => ({
	id: `us-c2-${designator.toLowerCase()}`,
	kind: C2_KINDS[designator] ?? "unit",
	designator,
	abbreviation: US_UNIT_DESIGNATOR_PREFERRED_ABBR[designator],
	requiresIdentifier: US_UNIT_DESIGNATOR_REQUIRES_RANGE[designator],
	statement: `${designator} is abbreviated ${US_UNIT_DESIGNATOR_PREFERRED_ABBR[designator]} on the delivery address line.`,
	citation: {
		...APPENDIX_C2,
		quote: `${c2Description(designator)} ${US_UNIT_DESIGNATOR_PREFERRED_ABBR[designator]}`,
		transcription:
			"A row of the C2 table: the Description cell, one space, then the Approved Abbreviation cell, " +
			"without the table's asterisk footnote marks. The HTML table cells were joined by one space.",
	},
}))

/**
 * Where Pub 28 section 213 places the secondary unit on the address.
 */
export const US_UNIT_PLACEMENT_RULES = [
	{
		id: "us-213-end-of-delivery-line",
		statement: "The secondary unit designator and number go at the end of the delivery address line.",
		citation: {
			...SECTION_213,
			section: "213 Secondary Address Unit Designators",
			quote: "The preferred location is at the end of the Delivery Address Line.",
			transcription: null,
		},
	},
	{
		id: "us-213-3-line-above",
		statement: "When the delivery address line cannot hold it, the secondary unit goes on the line immediately above.",
		citation: {
			...SECTION_213,
			section: "213.3 Alternate Location",
			quote:
				"If all Delivery Address Line information cannot be continued in the Delivery Address Line above the " +
				"city, state, and ZIP Code, place secondary address information on the line immediately above the " +
				"Delivery Address Line.",
			transcription: null,
		},
	},
] as const
