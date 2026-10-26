/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   United States designators: delivery services, rural forms, secondary units, floors and the English
 *   relation words. Unit, floor and PO Box rows read from `unit-designator.ts`, `floor-designator.ts` and
 *   `po-box.ts`. Rural, General Delivery and Bin rows are the forms those modules lack.
 *
 * @see {@link https://pe.usps.com/text/pub28/28apc_003.htm USPS Publication 28, Appendix C2 secondary unit designators}
 * @see {@link https://pe.usps.com/text/pub28/28c2_036.htm USPS Publication 28 section 281, Post Office Box address format}
 * @see {@link https://pe.usps.com/text/pub28/28c2_038.htm USPS Publication 28 section 283, Caller, Firm Caller, Bin, Lockbox and Drawer}
 * @see {@link https://pe.usps.com/text/pub28/28c2_021.htm USPS Publication 28 section 24, Rural Route addresses}
 * @see {@link https://pe.usps.com/text/pub28/28c2_027.htm USPS Publication 28 section 25, Highway Contract Route addresses}
 * @see {@link https://pe.usps.com/text/pub28/28c2_032.htm USPS Publication 28 section 26, General Delivery addresses}
 * @see {@link https://secure.ssa.gov/poms.nsf/lnx/0202605900 SSA POMS GN 02605.900, address standardization}
 * @see {@link https://pe.usps.com/text/pub28/28c2_019.htm USPS Publication 28 section 238, Military addresses (PSC)}
 * @see {@link https://en.wiktionary.org/wiki/in Wiktionary, in}
 * @see {@link https://en.wiktionary.org/wiki/me Wiktionary, me}
 * @see {@link https://en.wiktionary.org/wiki/near Wiktionary, near}
 * @see {@link https://en.wiktionary.org/wiki/next_to Wiktionary, next to}
 */

import type { DesignatorConcept, PostalDesignatorRow, PostalDesignatorTable } from "#postal-designator"
import { US_FLOOR_DESIGNATORS } from "#us/floor-designator"
import { US_PO_BOX_DESIGNATORS } from "#us/po-box"
import { US_UNIT_DESIGNATOR_VARIANTS, type USUnitDesignator } from "#us/unit-designator"

const UNIT_SOURCE = "https://pe.usps.com/text/pub28/28apc_003.htm"
const PO_BOX_SOURCE = "https://pe.usps.com/text/pub28/28c2_036.htm"
const CALLER_SOURCE = "https://pe.usps.com/text/pub28/28c2_038.htm"

const RURAL_ROUTE_SOURCE =
	"https://pe.usps.com/text/pub28/28c2_021.htm and https://secure.ssa.gov/poms.nsf/lnx/0202605900"

const HIGHWAY_CONTRACT_SOURCE =
	"https://pe.usps.com/text/pub28/28c2_027.htm and https://secure.ssa.gov/poms.nsf/lnx/0202605900"

const GENERAL_DELIVERY_SOURCE = "https://pe.usps.com/text/pub28/28c2_032.htm"

const NEAR_ASKER_SOURCE =
	"composed from the near row and the first-person pronoun (Wiktionary https://en.wiktionary.org/wiki/me)"

const UNIT_CONCEPTS = {
	APARTMENT: "apartment",
	BASEMENT: "basement",
	BUILDING: "building",
	DEPARTMENT: "unit",
	FLOOR: "floor",
	FRONT: "unit",
	HANGAR: "unit",
	KEY: "unit",
	LOBBY: "ground_floor",
	LOT: "unit",
	LOWER: "unit",
	OFFICE: "office",
	PENTHOUSE: "penthouse",
	PIER: "unit",
	REAR: "unit",
	ROOM: "room",
	SIDE: "unit",
	SLIP: "unit",
	SPACE: "unit",
	STOP: "unit",
	SUITE: "suite",
	TRAILER: "unit",
	UNIT: "unit",
	UPPER: "unit",
} as const satisfies Record<USUnitDesignator, DesignatorConcept>

const FLOOR_CLASS_UNITS: ReadonlySet<string> = new Set(US_FLOOR_DESIGNATORS.map((floor) => floor.name))

const FLOOR_CONCEPTS: Readonly<Record<string, DesignatorConcept>> = {
	FLOOR: "floor",
	BASEMENT: "basement",
	PENTHOUSE: "penthouse",
	LOBBY: "ground_floor",
}

const STANDARD_PO_BOX_PHRASES: ReadonlySet<string> = new Set(["POST OFFICE BOX", "PO BOX", "P O BOX"])

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

const UNIT_ROWS = (Object.keys(US_UNIT_DESIGNATOR_VARIANTS) as USUnitDesignator[])
	.filter((name) => !FLOOR_CLASS_UNITS.has(name))
	.map((name) => {
		const [abbreviation, ...variants] = US_UNIT_DESIGNATOR_VARIANTS[name]

		return row(abbreviation, UNIT_CONCEPTS[name], UNIT_SOURCE, { abbreviations: [name, ...variants] })
	})

const FLOOR_ROWS = US_FLOOR_DESIGNATORS.map((floor) =>
	row(floor.abbreviation, FLOOR_CONCEPTS[floor.name]!, UNIT_SOURCE, {
		abbreviations: [floor.name, ...floor.variants],
		position: floor.requiresNumber ? "prefix" : "standalone",
	})
)

const PO_BOX_ROWS = US_PO_BOX_DESIGNATORS.filter((designator) => designator !== "BOX").map((designator) =>
	row(designator, "post_office_box", STANDARD_PO_BOX_PHRASES.has(designator) ? PO_BOX_SOURCE : CALLER_SOURCE)
)

/**
 * The United States designator table, read from USPS Publication 28 and the SSA POMS.
 */
export const US_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "US",
	rows: [
		...PO_BOX_ROWS,
		row("BIN", "post_office_box", CALLER_SOURCE),
		row("GENERAL DELIVERY", "poste_restante", GENERAL_DELIVERY_SOURCE, { position: "standalone" }),
		row("RR", "rural_route", RURAL_ROUTE_SOURCE, { abbreviations: ["RURAL ROUTE", "RFD", "RD"] }),
		row("HC", "rural_route", HIGHWAY_CONTRACT_SOURCE, { abbreviations: ["HIGHWAY CONTRACT", "STAR ROUTE"] }),
		...UNIT_ROWS,
		...FLOOR_ROWS,
		row("near", "near", "https://en.wiktionary.org/wiki/near"),
		row("PSC", "special_routing", "https://pe.usps.com/text/pub28/28c2_019.htm", {
			abbreviations: ["POSTAL SERVICE CENTER"],
		}),
		row("next to", "beside", "https://en.wiktionary.org/wiki/next_to"),
		row("near me", "near_asker", NEAR_ASKER_SOURCE, { position: "standalone" }),
		row("in", "in", "https://en.wiktionary.org/wiki/in"),
	],
}
