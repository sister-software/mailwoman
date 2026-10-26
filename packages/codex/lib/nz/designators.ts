/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   New Zealand designators: delivery-service types, Unit Types, rural delivery, level and the English relation
 *   words. Delivery and unit rows read from `delivery-service.ts` and `unit-type.ts`. A row whose type NZ Post's
 *   how-to-address page names takes that page as its source, and every other row takes ADV358.
 *
 * @see {@link https://www.nzpost.co.nz/personal/sending-in-nz/how-to-address-mail NZ Post, how to address mail}
 * @see {@link https://www.nzpost.co.nz/sites/nz/files/2021-10/adv358-address-standards.pdf NZ Post Address Standards (ADV358, June 2011)}
 * @see {@link https://en.wiktionary.org/wiki/in Wiktionary, in}
 * @see {@link https://en.wiktionary.org/wiki/me Wiktionary, me}
 * @see {@link https://en.wiktionary.org/wiki/near Wiktionary, near}
 * @see {@link https://en.wiktionary.org/wiki/next_to Wiktionary, next to}
 */

import { NZ_DELIVERY_SERVICE_TYPES, type NZDeliveryServiceTypeName } from "#nz/delivery-service"
import { NZ_UNIT_TYPE_RULES } from "#nz/unit-type"
import type { DesignatorConcept, PostalDesignatorRow, PostalDesignatorTable } from "#postal-designator"

const HOW_TO_ADDRESS = "https://www.nzpost.co.nz/personal/sending-in-nz/how-to-address-mail"
const ADV358 = "https://www.nzpost.co.nz/sites/nz/files/2021-10/adv358-address-standards.pdf"

const DELIVERY_CONCEPTS: Readonly<Record<NZDeliveryServiceTypeName, DesignatorConcept>> = {
	"PO Box": "post_office_box",
	"Private Bag": "private_bag",
	"Response Bag": "private_bag",
	CMB: "special_routing",
	"Counter Delivery": "poste_restante",
	"Poste Restante": "poste_restante",
}

const HOW_TO_ADDRESS_DELIVERY: ReadonlySet<string> = new Set([
	"PO Box",
	"Private Bag",
	"Counter Delivery",
	"Poste Restante",
])

const HOW_TO_ADDRESS_UNITS: ReadonlySet<string> = new Set(["Apartment", "Flat", "Unit"])

const UNIT_CONCEPTS: Readonly<Record<string, DesignatorConcept>> = {
	Apartment: "apartment",
	Room: "room",
	Suite: "suite",
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

const DELIVERY_ROWS = NZ_DELIVERY_SERVICE_TYPES.map((type) =>
	row(type.type, DELIVERY_CONCEPTS[type.type], HOW_TO_ADDRESS_DELIVERY.has(type.type) ? HOW_TO_ADDRESS : ADV358, {
		position: type.identifier === "not-used" ? "standalone" : "prefix",
	})
)

const UNIT_ROWS = NZ_UNIT_TYPE_RULES.map((rule) =>
	row(
		rule.abbreviation ?? rule.designator,
		UNIT_CONCEPTS[rule.designator] ?? "unit",
		HOW_TO_ADDRESS_UNITS.has(rule.designator) ? HOW_TO_ADDRESS : ADV358,
		{
			abbreviations: rule.abbreviation ? [rule.designator] : [],
		}
	)
)

/**
 * The New Zealand designator table, read from NZ Post's addressing pages and ADV358.
 */
export const NZ_POSTAL_DESIGNATORS: PostalDesignatorTable = {
	country: "NZ",
	rows: [
		...DELIVERY_ROWS,
		row("RD", "rural_route", HOW_TO_ADDRESS, { abbreviations: ["Rural Delivery"] }),
		...UNIT_ROWS,
		row("L", "floor", HOW_TO_ADDRESS, { abbreviations: ["Level"] }),
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
