/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Layouts read from UPU's Postal Addressing Systems compendium, one description per member country.
 *
 * A description is a few pages UPU collects from the designated postal operator: the postcode, where
 * the address sits on the envelope, and printed examples with each line labeled (`thoroughfare +
 * premises`, `post office + postcode`). It is not an S42 template and specifies no approved crosswalk.
 * It states what the operator prints.
 *
 * This table includes a country only where libaddressinput states no `fmt`, or where its `fmt` omits the
 * locality line in the operator's own examples. The United Arab Emirates uses `%N%n%O%n%A%n%S`.
 * Each layout transcribes the examples' line order. The dependent-locality line follows
 * the generated tables' convention: it renders a district where a row has one, and an address without
 * one prints the same lines the examples print.
 *
 * Bonaire, Sint Eustatius and Saba and Sint Maarten are absent: their descriptions (`besEn.pdf` 05/2014 and
 * `sxmEn.pdf` 11/2011) state only the 2010 dissolution of the Netherlands Antilles and print no address.
 */

import {
	addr,
	numberFirstCommaStreet,
	numberFirstStreet,
	numberLastStreet,
	SLOTS,
	type AddressLayout,
} from "#address/layout"

const { attention, country, dependent_locality, locality, postcode, region, venue } = SLOTS

/**
 * What one country's description states about itself, and what this layout cannot represent.
 */
export interface UPUPostalAddressingRecord {
	/**
	 * The date printed in the description's footer, as `YYYY-M`.
	 */
	documentDate: string
	/**
	 * The description's URL on upu.int.
	 */
	url: string
	/**
	 * The sha256 of the PDF as retrieved on 2026-10-18.
	 */
	sha256: string
	/**
	 * Where the description puts the postcode, or `absent` if it states none.
	 */
	postcode: "before-locality" | "after-locality" | "after-region" | "absent"
	/**
	 * Details in the description this layout cannot represent.
	 */
	unexpressed: readonly string[]
}

/**
 * Per-country description metadata.
 */
export const UPU_PAS_LAYOUT_RECORDS: Readonly<Record<string, UPUPostalAddressingRecord>> = {
	AE: {
		documentDate: "2014-9",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/areEn.pdf",
		sha256: "b6927cc8bae0a217610307c2346868255351a432d3f060f9a0177725e725bc4d",
		postcode: "absent",
		unexpressed: [
			"delivery to P.O. Boxes only, which the description states for every address",
			"the emirate line, which the example leaves out because its city (DUBAI) names the emirate too; the region line here is libaddressinput's `%S`",
		],
	},
	AO: {
		documentDate: "2004-9",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/agoEn.pdf",
		sha256: "8a85d5bc908767cea0a5816482b8907a4abe3e86073c177060bf7252a9b9309b",
		postcode: "absent",
		unexpressed: ["the floor, printed after the house number with a dash (`92 – 7 o`)"],
	},
	AW: {
		documentDate: "2019-1",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/abwEn.pdf",
		sha256: "29379581a003bf1c82c75d2ea5b4dae420376f34b7da33def08eabd1963997c1",
		postcode: "absent",
		unexpressed: ["the `#` written before a house number (`L.G. Smith Boulevard #160`)"],
	},
	BZ: {
		documentDate: "2021-5",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/blzEn.pdf",
		sha256: "a6f77003af704e7b46e30d50a2f5cfaf06f25793153968af773993a21a0cf61e",
		postcode: "absent",
		unexpressed: [
			"two spaces between the street and the apartment number",
			"the country line `BELIZE C.A.`, which appends Central America",
		],
	},
	CD: {
		documentDate: "2022-9",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/codEn.pdf",
		sha256: "e66cfd3ae8589b582a3d79750cc43f9282d2d759c7ff5c6bb0a843dc83586c20",
		postcode: "after-region",
		unexpressed: [
			"the urban examples' number after the street with `N°` (`Avenue de la Poste N°1`); the coding example's `95, Blvd du 30 juin` is the order kept",
			"the rural village, sector and territory lines (`Village NGIEME`, `Secteur de Niadi Nkara`, `Territoire de Bulungu`), of which one district line is kept",
		],
	},
	CW: {
		documentDate: "2026-9",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/cuwEn.pdf",
		sha256: "f65a047ef09bb2615799d3924dcd47c9ae3b40f19cecaa62ecd5863aa6d7cfe6",
		postcode: "absent",
		unexpressed: ["none: each example prints a street with its number, the locality and the country"],
	},
	GH: {
		documentDate: "2023-3",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/ghaEn.pdf",
		sha256: "d17abceeea47c280db128fb503e36102606d0f1b8735318141b36e5813bbd764",
		postcode: "after-locality",
		unexpressed: [
			"the digital address, the postcode extended by four digits (`GA-183-8164`), which takes the postcode's place",
			"line 4, the district or district capital, printed `in some addresses` between the locality and the region",
			"a telephone number printed as the last line",
		],
	},
	RW: {
		documentDate: "2005-3",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/rwaEn.pdf",
		sha256: "6013d3bf246d19798ae3c39115834be48ac73690838ad636f36e102b79ecc1ad",
		postcode: "absent",
		unexpressed: [
			"the one example is a P.O. Box (`B.P. 3425`); the street line takes the box's place above the locality, where every other description here prints it",
		],
	},
}

/**
 * Layouts by ISO 3166-1 alpha-2, read from each country's description.
 *
 * Each comment quotes the example's lines with the description's own labels.
 */
export const UPU_PAS_ADDRESS_LAYOUTS: Readonly<Record<string, AddressLayout>> = {
	// MR.
	// OMAR HUSSAIN / PO BOX 111 / DUBAI / UNITED ARAB EMIRATES.
	AE: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${region}
${country}`,

	// Sr.
	// Jõao Pembele / Rua Frederik Engels 92 – 7 o / LUANDA / ANGOLA.
	AO: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${locality}
${country}`,

	// addressee / premises (Sun Plaza Suite 110) / thoroughfare + no of thoroughfare
	// (L.G. Smith Boulevard #160) / locality (ORANJESTAD) / country.
	AW: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${locality}
${country}`,

	// Mr. Jessel Monique Lauriano / C Street Apt 2 / KINGS PARK, BELIZE CITY /
	// BELIZE C.A. `Use comma to separate area by city`.
	BZ: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}, ${locality}
${country}`,

	// addressee / thoroughfare + premises / sub-locality (QUAR RESIDENTIEL 12ème Rue) /
	// locality (COM LIMETE) / postcode + province (1004131 KINSHASA) / country.
	CD: addr`${attention}
${venue}
${numberFirstCommaStreet}
${dependent_locality}
${locality}
${postcode} ${region}
${country}`,

	// addressee / thoroughfare + premises (Kaya Muizenberg 5) / locality (WILLEMSTAD) / country.
	CW: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${locality}
${country}`,

	// addressee / n° of thoroughfare + thoroughfare (No. 7 Asafoatse Nettey Road) / post
	// office + digital address (Accra-Central GA-183-8164) / region (GREATER ACCRA) / country.
	GH: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality} ${postcode}
${region}
${country}`,

	// M. Pierre Simon / B.P. 3425 / KIGALI / RWANDA.
	RW: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${country}`,
}
