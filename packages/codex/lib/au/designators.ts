/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Australian designators: Postal Delivery Types, sub-unit types, level types and the English relation words.
 *   Every row reads from `delivery-service.ts`, `unit-type.ts` and `level-designator.ts`, grouping the
 *   delivery types that share an abbreviation (`CARE PO`, `RMB`).
 *
 * @see {@link https://auspost.com.au/content/dam/auspost_corp/media/documents/Barcode_hints_tips.pdf Australia Post barcode addressing booklet}
 * @see {@link https://auspost.com.au/sending/guidelines/addressing-guidelines Australia Post addressing guidelines}
 * @see {@link https://en.wiktionary.org/wiki/in Wiktionary, in}
 * @see {@link https://en.wiktionary.org/wiki/me Wiktionary, me}
 * @see {@link https://en.wiktionary.org/wiki/near Wiktionary, near}
 * @see {@link https://en.wiktionary.org/wiki/next_to Wiktionary, next to}
 */

import { AU_DELIVERY_SERVICE_DESIGNATORS, type AuDeliveryServiceAbbreviation } from "#au/delivery/service"
import { AU_LEVEL_DESIGNATOR_VARIANTS, AU_LEVEL_DESIGNATORS, type AuLevelCode } from "#au/level-designator"
import { AU_UNIT_TYPE_RULES } from "#au/unit-type"
import type { DesignatorConcept, PostalDesignatorRow, PostalDesignatorTable } from "#postal/designator"

const BOOKLET = "https://auspost.com.au/content/dam/auspost_corp/media/documents/Barcode_hints_tips.pdf"

const DELIVERY_CONCEPTS: Readonly<Record<AuDeliveryServiceAbbreviation, DesignatorConcept>> = {
	"GPO BOX": "post_office_box",
	"PO BOX": "post_office_box",
	"LOCKED BAG": "private_bag",
	"PRIVATE BAG": "private_bag",
	CMB: "special_routing",
	CMA: "special_routing",
	CPA: "special_routing",
	"CARE PO": "poste_restante",
	MS: "rural_route",
	RSD: "rural_route",
	RMB: "rural_route",
	RMS: "rural_route",
}

const UNIT_CONCEPTS: Readonly<Record<string, DesignatorConcept>> = {
	APARTMENT: "apartment",
	OFFICE: "office",
	PENTHOUSE: "penthouse",
	ROOM: "room",
	SUITE: "suite",
}

const LEVEL_CONCEPTS: Readonly<Record<AuLevelCode, DesignatorConcept>> = {
	L: "floor",
	G: "ground_floor",
	B: "basement",
	M: "mezzanine",
	LG: "basement",
	UG: "mezzanine",
	OD: "rooftop",
	P: "floor",
	RT: "rooftop",
}

function row(
	spelling: string,
	concept: DesignatorConcept,
	source: string,
	options: Partial<Pick<PostalDesignatorRow, "abbreviations" | "position">> = {}
): PostalDesignatorRow {
	return {
		spelling,
		abbreviations: options.abbreviations ?? [],
		script: "Latn",
		position: options.position ?? "prefix",
		concept,
		language: "en",
		source,
	}
}

const namesByAbbreviation = new Map<AuDeliveryServiceAbbreviation, string[]>()
const requiresNumberByAbbreviation = new Map<AuDeliveryServiceAbbreviation, boolean>()

for (const { name, abbreviation, requiresNumber } of AU_DELIVERY_SERVICE_DESIGNATORS) {
	namesByAbbreviation.set(abbreviation, [...(namesByAbbreviation.get(abbreviation) ?? []), name])
	requiresNumberByAbbreviation.set(abbreviation, requiresNumber)
}

const DELIVERY_ROWS = [...namesByAbbreviation].map(([abbreviation, names]) =>
	row(abbreviation, DELIVERY_CONCEPTS[abbreviation], BOOKLET, {
		abbreviations: names,
		position: requiresNumberByAbbreviation.get(abbreviation) ? "prefix" : "standalone",
	})
)

const UNIT_ROWS = AU_UNIT_TYPE_RULES.map((rule) =>
	row(rule.abbreviation ?? rule.designator, UNIT_CONCEPTS[rule.designator] ?? "unit", BOOKLET, {
		abbreviations: rule.abbreviation ? [rule.designator] : [],
	})
)

const LEVEL_ROWS = AU_LEVEL_DESIGNATORS.map((level) =>
	row(level.abbreviation, LEVEL_CONCEPTS[level.code], BOOKLET, {
		abbreviations: [level.name, ...AU_LEVEL_DESIGNATOR_VARIANTS[level.code]].filter(
			(spelling) => spelling !== level.abbreviation
		),
		position: level.requiresNumber ? "prefix" : "standalone",
	})
)

/**
 * The Australian designator table, read from the codex modules.
 *
 * The delivery rows follow Australia Post's Postal Delivery Type table.
 */
export const AU_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "AU",
	rows: [
		...DELIVERY_ROWS,
		...UNIT_ROWS,
		...LEVEL_ROWS,
		row("near", "near", "https://en.wiktionary.org/wiki/near"),
		row("next to", "beside", "https://en.wiktionary.org/wiki/next_to"),
		row(
			"near me",
			"near_asker",
			"composed from the near row and the first-person pronoun (Wiktionary https://en.wiktionary.org/wiki/me)",
			{ position: "standalone" }
		),
		row("in", "in", "https://en.wiktionary.org/wiki/in"),
	],
}
