// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Layouts read from UPU's Postal Addressing Systems compendium, one description per member country.
 *
 * A description is a few pages UPU collects from the designated postal operator: the postcode, where
 * the address sits on the envelope, and printed examples with each line labeled (`thoroughfare +
 * premises`, `post office + postcode`). It isn't an S42 template and specifies no approved crosswalk.
 * It states what the operator prints.
 *
 * This table includes a country only where libaddressinput states no `fmt`,
 * where its `fmt` omits the locality line in the operator's own examples, or where its
 * `fmt` orders the locality line differently from every example the operator prints.
 * The United Arab Emirates uses `%N%n%O%n%A%n%S`, and Romania's `%Z %S %C` writes the
 * county between the postcode and the locality, a line none of its examples prints.
 *
 * Each layout transcribes the examples' line order.
 * The dependent-locality line follows the generated tables' convention: it renders a district
 * where a row has one, and an address without one prints the same lines the examples print.
 *
 * Bonaire, Sint Eustatius and Saba and Sint Maarten are absent: their descriptions
 * (`besEn.pdf` 05/2014 and `sxmEn.pdf` 11/2011) state only the 2010 dissolution
 * of the Netherlands Antilles and print no address.
 */

import { ConventionSource, type LayoutCitation } from "#address/convention-claims"
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
 * The three reasons a UPU description replaces a country's libaddressinput skeleton.
 */
export const UPUAdmission = {
	NoFormat: "no-fmt",
	FormatOmitsLocality: "fmt-omits-locality",
	FormatContradictsOrder: "fmt-contradicts-order",
} as const

export type UPUAdmission = (typeof UPUAdmission)[keyof typeof UPUAdmission]

/**
 * What one country's description states about itself, and what this layout cannot represent.
 *
 * The record is the layout's citation: `documentDate` is the date in the description's
 * footer, and `url` is the description on upu.int.
 */
export interface UPUPostalAddressingRecord extends LayoutCitation {
	readonly source: typeof ConventionSource.PostalAddressingSystems
	/**
	 * Why the table holds the country: libaddressinput states no `fmt`, its `fmt` omits the locality
	 * the examples print, or its `fmt` orders the locality line differently from every example.
	 */
	admittedBecause: UPUAdmission
	/**
	 * Where the description puts the postcode, or `absent` if it states none.
	 */
	postcode: "before-locality" | "after-locality" | "after-region" | "absent"
}

/**
 * Per-country description metadata.
 */
export const UPU_PAS_LAYOUT_RECORDS: Readonly<Record<string, UPUPostalAddressingRecord>> = {
	AE: {
		admittedBecause: UPUAdmission.FormatOmitsLocality,
		documentDate: "2014-9",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/areEn.pdf",
		sha256: "b6927cc8bae0a217610307c2346868255351a432d3f060f9a0177725e725bc4d",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [["MR. OMAR HUSSAIN", "PO BOX 111", "DUBAI", "UNITED ARAB EMIRATES"]],
		postcode: "absent",
		unexpressed: [
			"delivery to P.O. Boxes only, which the description states for every address",
			"the emirate line, which the example leaves out because its city (DUBAI) names the emirate too; the region line here is libaddressinput's `%S`",
		],
	},
	AO: {
		admittedBecause: UPUAdmission.NoFormat,
		documentDate: "2004-9",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/agoEn.pdf",
		sha256: "8a85d5bc908767cea0a5816482b8907a4abe3e86073c177060bf7252a9b9309b",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [["Sr. Jõao Pembele", "Rua Frederik Engels 92 – 7 o", "LUANDA", "ANGOLA"]],
		postcode: "absent",
		unexpressed: ["the floor, printed after the house number with a dash (`92 – 7 o`)"],
	},
	AW: {
		admittedBecause: UPUAdmission.NoFormat,
		documentDate: "2019-1",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/abwEn.pdf",
		sha256: "29379581a003bf1c82c75d2ea5b4dae420376f34b7da33def08eabd1963997c1",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [
			["Mr. Brown", "Sun Plaza Suite 110", "L.G. Smith Boulevard #160", "ORANJESTAD", "ARUBA"],
			["EPI College", "Sero Blanco", "ORANJESTAD", "ARUBA"],
		],
		postcode: "absent",
		unexpressed: ["the `#` written before a house number (`L.G. Smith Boulevard #160`)"],
	},
	BZ: {
		admittedBecause: UPUAdmission.NoFormat,
		documentDate: "2021-5",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/blzEn.pdf",
		sha256: "a6f77003af704e7b46e30d50a2f5cfaf06f25793153968af773993a21a0cf61e",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [["Mr. Jessel Monique Lauriano", "C Street Apt 2", "KINGS PARK, BELIZE CITY", "BELIZE C.A."]],
		postcode: "absent",
		unexpressed: [
			"two spaces between the street and the apartment number",
			"the country line `BELIZE C.A.`, which appends Central America",
		],
	},
	CD: {
		admittedBecause: UPUAdmission.NoFormat,
		documentDate: "2022-9",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/codEn.pdf",
		sha256: "e66cfd3ae8589b582a3d79750cc43f9282d2d759c7ff5c6bb0a843dc83586c20",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [
			[
				"M MAKILA MUWULU Jean Fédor",
				"95, Blvd du 30 juin, Building INSS",
				"1003071 KINSHASA",
				"RÉPUBLIQUE DÉMOCRATIQUE DU CONGO",
			],
			[
				"M DUALE NKANU Béni",
				"S/c M MAKILA MUWULU Jean Fédor",
				"Avenue de la Poste N°1",
				"QUAR RESIDENTIEL 12ème Rue",
				"COM LIMETE",
				"1004131 KINSHASA",
				"RÉPUBLIQUE DÉMOCRATIQUE DU CONGO",
			],
		],
		postcode: "after-region",
		unexpressed: [
			"the urban examples' number after the street with `N°` (`Avenue de la Poste N°1`); the coding example's `95, Blvd du 30 juin` is the order kept",
			"the rural village, sector and territory lines (`Village NGIEME`, `Secteur de Niadi Nkara`, `Territoire de Bulungu`), of which one district line is kept",
		],
	},
	CW: {
		admittedBecause: UPUAdmission.NoFormat,
		documentDate: "2026-9",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/cuwEn.pdf",
		sha256: "f65a047ef09bb2615799d3924dcd47c9ae3b40f19cecaa62ecd5863aa6d7cfe6",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [
			["John Doe", "Kaya Muizenberg 5", "WILLEMSTAD", "CURAÇAO"],
			["Acme Corporation", "Gosieweg 153", "WILLEMSTAD", "CURAÇAO"],
		],
		postcode: "absent",
		unexpressed: ["none: each example prints a street with its number, the locality and the country"],
	},
	GH: {
		admittedBecause: UPUAdmission.NoFormat,
		documentDate: "2023-3",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/ghaEn.pdf",
		sha256: "d17abceeea47c280db128fb503e36102606d0f1b8735318141b36e5813bbd764",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [
			["Mr Derick Yeboah", "No. 7 Asafoatse Nettey Road", "Accra-Central GA-183-8164", "GREATER ACCRA", "GHANA"],
			["Mr Derick Yeboah", "DTD 1234", "Sakumono GT-372", "Tema", "GREATER ACCRA", "GHANA", "Tel: +233 22 111 1122"],
		],
		postcode: "after-locality",
		unexpressed: [
			"the digital address, the postcode extended by four digits (`GA-183-8164`), which takes the postcode's place",
			"line 4, the district or district capital, printed `in some addresses` between the locality and the region",
			"a telephone number printed as the last line",
		],
	},
	RW: {
		admittedBecause: UPUAdmission.NoFormat,
		documentDate: "2005-3",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/rwaEn.pdf",
		sha256: "6013d3bf246d19798ae3c39115834be48ac73690838ad636f36e102b79ecc1ad",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [["M. Pierre Simon", "B.P. 3425", "KIGALI", "RWANDA"]],
		postcode: "absent",
		unexpressed: [
			"the one example is a P.O. Box (`B.P. 3425`); the street line takes the box's place above the locality, where every other description here prints it",
		],
	},
	KI: {
		admittedBecause: UPUAdmission.FormatContradictsOrder,
		documentDate: "2020-10",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/kirEn.pdf",
		sha256: "d6b0f0420517f1a287d5aa4c8128b2e18f05ffbe076b9f2493a4474ca33b5d42",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [
			["Mr. Teekia Rui", "Vaticano", "Butaritari KI0102", "KIRIBATI"],
			["Ms. Josephine Matiota", "PO Box 487", "Betio", "Sth Tarawa KI0108", "KIRIBATI"],
			["Ms. Meerite Toantei", "Abaunamou", "Teaoraereke", "Sth Tarawa KI0107", "KIRIBATI"],
		],
		postcode: "after-locality",
		unexpressed: [
			"the island group (Gilbert, Phoenix, Line), which no example prints; libaddressinput's `%S` printed it above the village",
			"the village or town line, which the examples label `village`, `town` or `delivery post office`; it renders here as the district line above the island",
			"the what3words line of the household example (`truly.ramping.sheriffs`)",
		],
	},
	LV: {
		admittedBecause: UPUAdmission.FormatContradictsOrder,
		documentDate: "2023-9",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/lvaEn.pdf",
		sha256: "251b08b058d31783d47b417ad7ced517f140d51de06b09df3acb0752991f8dc3",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [
			["Jānis Bērziņš", "Kr. Barona street 7, dz. 1", "RIGA, LV–1050", "LATVIA"],
			["Jānis Berziņš", "Valdemāra street 42, Ainaži,", "SALACGRIVAS NOV., LV–4035", "LATVIA"],
		],
		postcode: "after-locality",
		unexpressed: [
			"the sub-locality example's line break: `Valdemāra street 42, Ainaži,` then `SALACGRIVAS NOV., LV–4035`; the national register's one-line form (`Dzirnavu iela 1, Mazsalaca, Valmieras nov., LV-4215`) is the one kept",
			"the apartment after the number (`dz. 1`)",
		],
	},
	RO: {
		admittedBecause: UPUAdmission.FormatContradictsOrder,
		documentDate: "2007-10",
		url: "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/rouEn.pdf",
		sha256: "a59ca12648bd36f39d90be6f5f40bb50193462267d7f4e2dc3741e99f21babfa",
		source: ConventionSource.PostalAddressingSystems,
		retrievedAt: "2026-11-24",
		examples: [
			["Posta Romana S.A.", "Calea Giulesti 6–8", "060274 BUCHAREST", "ROMANIA"],
			["ASTRA", "Drumul Taberei nr. 35, bl. F5, sc. 2, parter, ap. 23", "Sector 6", "061357 BUCHAREST", "ROMANIA"],
		],
		postcode: "before-locality",
		unexpressed: [
			"the county (județ), which no example prints; libaddressinput's `%Z %S %C` wrote it between the postcode and the locality",
			"the block, staircase, floor and apartment after the number (`bl. F5, sc. 2, parter, ap. 23`)",
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

	// addressee / village (Vaticano) / name of island + postcode (Butaritari KI0102) /
	// country. addressee / P.O. box number (PO Box 487) / delivery post office (Betio)
	// / name of island + postcode (Sth Tarawa KI0108) / country.
	KI: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${locality} ${postcode}
${country}`,

	// addressee / street + premises (Kr. Barona street 7, dz. 1) / locality + postcode (RIGA, LV–1050)
	// / country. addressee / street + premises + sub-locality (Valdemāra street 42, Ainaži,)
	// / locality + postcode (SALACGRIVAS NOV., LV–4035) / country.
	LV: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${locality}, ${region}, ${postcode}
${country}`,

	// Posta Romana S.A. / Calea Giulesti 6–8 / 060274 BUCHAREST / ROMANIA.
	// ASTRA / Drumul Taberei nr. 35, bl.
	// F5, sc. 2, parter, ap. 23 / Sector 6 / 061357 BUCHAREST / ROMANIA.
	RO: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${postcode} ${locality}
${country}`,
}
