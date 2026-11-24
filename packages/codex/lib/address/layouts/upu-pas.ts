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
 * This table includes a country only where libaddressinput states no `fmt`, where its
 * `fmt` omits the locality line in the operator's own examples, or where its `fmt`
 * and street order print a line or a field in a place no example the operator prints puts it.
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

import type { ConventionSource, LayoutCitation } from "#address/convention-claims"
import {
	addr,
	fixedSlot,
	numberFirstCommaStreet,
	numberFirstStreet,
	numberLastCommaStreet,
	numberLastStreet,
	prefixedSlot,
	SLOTS,
	unitLineNumberFirstStreet,
	withPoBoxBelow,
	type AddressLayout,
} from "#address/layout"

const { attention, country, dependent_locality, locality, postcode, region, subregion, venue } = SLOTS

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
 * The record is the layout's citation, kept in `description-records.ts`.
 * Its `documentDate` is the date in the description's footer, and `url` is the description on upu.int.
 */
export interface UPUPostalAddressingRecord extends LayoutCitation {
	readonly source: typeof ConventionSource.PostalAddressingSystems
	/**
	 * Why the table holds the country: libaddressinput states no `fmt`, its `fmt` omits the locality
	 * the examples print, or its rendering prints a line or a field where no example puts it.
	 */
	admittedBecause: UPUAdmission
	/**
	 * Where the description puts the postcode, or `absent` if it states none.
	 */
	postcode: "before-locality" | "after-locality" | "after-region" | "absent"
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
${country}`,

	// addressee / premise number + thoroughfare name (16, Ziarat-e-Abolfazl St) / locality
	// (Murad Khani) / postcode + province (100208 KABUL) / country.
	// Rural examples print postcode + rural district (265101 HESARAK), then the province (NANGARHAR).
	AF: addr`${attention}
${venue}
${numberFirstCommaStreet}
${dependent_locality}
${postcode} ${locality}
${region}
${country}`,

	// addressee / street + premise + apartment number (Saryan str 22 apt 25) /
	// postcode + locality (0002 YEREVAN) / country.
	AM: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${postcode} ${locality}
${country}`,

	// Sr.
	// Jõao Pembele / Rua Frederik Engels 92 – 7 o / LUANDA / ANGOLA.
	AO: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${locality}
${country}`,

	// SIGNUM SRL / JUAN LOPEZ / street name and number (SAN MARTIN 230) / floor + department
	// (PISO 4 DPTO. A) / postcode + locality (Y5900FNF VILLA MARIA) / ARGENTINA.
	AR: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${postcode} ${locality}
${country}`,

	// addressee / premises (Sun Plaza Suite 110) / thoroughfare + no of thoroughfare
	// (L.G. Smith Boulevard #160) / locality (ORANJESTAD) / country.
	AW: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${locality}
${country}`,

	// addressee / street + premises (Rashid Behbudov küç. 55) / postcode + locality (AZ1014 Baku) / country.
	// The rural example prints subprovince (Babək rayonu) and province below.
	AZ: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
AZ ${postcode} ${locality}
${subregion}
${region}
${country}`,

	// addressee / premise / premise + thoroughfare (566 Avenue de la Nation) / locality –
	// quarter (Dapoya) / p.o. box + post office / postcode + locality (10000 OUAGADOUGOU) / country.
	BF: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${postcode} ${locality}
${country}`,

	// addressee / P.O. box (BP 1915) / commune (MUKAZA) / province (BUJUMBURA) / country.
	BI: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${region}
${country}`,

	// addressee / P.O. box number (10 BP 648) / locality (COTONOU) / telephone number / country.
	BJ: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${country}`,

	// addressee / unit/apt. name or number (Upper Apt # 1) / street n° and name
	// (9 Leafy Lane) / parish name + postcode (SMITH'S FL 07) / BERMUDA.
	BM: addr`${attention}
${venue}
${unitLineNumberFirstStreet}
${dependent_locality}
${locality} ${postcode}
${country}`,

	// title / addressee / street + house number (CALLE AZURDUY 158) / locality (SUCRE) / country.
	BO: addr`${attention}
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

	// addressee / mailee / telephone / organization / p.o. box (BP 729) / locality (BANGUI) / country.
	CF: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${country}`,

	// M. Joseph Mbemba / 12, rue Kakamoueka / BRAZZAVILLE / CONGO (REP.).
	CG: addr`${attention}
${venue}
${numberFirstCommaStreet}
${dependent_locality}
${locality}
${country}`,

	// organisation / street, locality (Maire Nui Drive, Avarua) / island (RAROTONGA) / country.
	CK: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${region}
${country}`,

	// M. Pierre Marie / BP 6000 / YAOUNDE / CAMEROON.
	CM: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${country}`,

	// addressee / street + premises / sub-locality (Alqueria La Fragua) / locality +
	// postcode (Localidad de Kennedy 110841) / province (BOGOTA D.C.).
	CO: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${locality} ${postcode}
${region}
${country}`,

	// recipient name / street and street number (Ca 15 Av 37 # 55) / province, canton,
	// district (Heredia, San Rafael, San Rafael) / postcode (40501) / name of the country.
	CR: addr`${attention}
${venue}
${numberLastStreet}
${region}, ${locality}, ${dependent_locality}
${postcode}
${country}`,

	// thoroughfare type and name (Ave Independencia s/n) / cross streets / postal zone
	// (Habana 6) / postcode + locality (CP 10600 CIUDAD HABANA) / CUBA.
	CU: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${prefixedSlot("postcode", "CP ")} ${locality}
${country}`,

	// Luis Felipe Ramos / street name + zone (Rua 5 de Julho 138/Platô) / p.o. box (C.P. 38)
	// / postcode + locality name (7600 PRAIA) / island name (SANTIAGO) / country.
	CV: addr`${attention}
${venue}
${withPoBoxBelow(numberLastStreet)}
${dependent_locality}
${postcode} ${locality}
${region}
${country}`,

	// addressee / thoroughfare + premises (Kaya Muizenberg 5) / locality (WILLEMSTAD) / country.
	CW: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${locality}
${country}`,

	// addressee / street name, house number, floor, district (Kastanievej 15, 2, Agerskov)
	// / postcode + locality (8660 SKANDERBORG) / country.
	DK: addr`${attention}
${venue}
${numberLastStreet}, ${dependent_locality}
${postcode} ${locality}
${country}`,

	// Mr. Alvin Thomas / Bay Front / ROSEAU / DOMINICA.
	DM: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${country}`,

	// addressee / street + premises + intersection / building details / sub-locality
	// (Conocoto) / postcode + locality (170303 - QUITO) / country.
	EC: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${postcode} - ${locality}
${country}`,

	// Mr. Samuel Habte / Awet Street 4 / ASMARA / ERITREA.
	ER: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${locality}
${country}`,

	// MR.
	// JOHN DAVID / 14 VIRIA STREET / VATUWAQA / town name (SUVA) / FIJI.
	FJ: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${country}`,

	// addressee / delivery information and locality / postcode and delivery office (05 TCHIBANGA 01) / GABON.
	GA: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${postcode} ${locality}
${country}`,

	// addressee / village (Woburn) / municipality (ST. GEORGE'S) / island + region.
	GD: addr`${attention}
${venue}
${numberFirstStreet}
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
${subregion}
${region}
${country}`,

	// addressee / premise + street (109 Gardiner’s Road) / locality (Gibraltar)
	// / postcode (GX11 1AA) / country.
	GI: addr`${attention}
${venue}
${numberFirstStreet}
${fixedSlot("locality", "Gibraltar")}
${postcode}
${country}`,

	// Mr. A. Ceesay / 21 Liberation Avenue / BANJUL / GAMBIA.
	GM: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${country}`,

	// addressee / organization / premises (Portal 5, puerta 29) / province + sub-province +
	// locality (BIOKO NORTE, MALABO, REBOLA) / country.
	GQ: addr`${attention}
${venue}
${numberLastStreet}
${region}, ${subregion}, ${locality}
${country}`,

	// addressee / thoroughfare + zone (6a. Avenida "A" 10-13, zona 1) / premises /
	// postcode + - + locality (01001 - Guatemala) / country + geographical region.
	GT: addr`${attention}
${venue}
${numberLastStreet}, ${dependent_locality}
${postcode} - ${locality}
${country}`,

	// `Guam follows the United States of America postal system. Its state code is GU`.
	GU: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality} ${fixedSlot("region", "GU")} ${postcode}
${country}`,

	// addressee / premises / number of building + district / sub-locality (Lacytown)
	// / locality (Georgetown) / postcode (4130106) / country.
	GY: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${postcode}
${country}`,

	// Sr.
	// Juan C. Martel / CM1102 LAS LAJAS, COMAYAGUA / HONDURAS (REP).
	HN: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${postcode} ${locality}, ${region}
${country}`,

	// addressee / street, premise + sub-loc 3 / sub-loc 2 / sub-loc (Padalarang) /
	// locality + postcode (BANDUNG 40553) / country.
	ID: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${locality} ${postcode}
${country}`,

	// Mr. Ploni Almoni / 16 Yafo Street / 9414219 JERUSALEM / ISRAEL.
	IL: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${postcode} ${locality}
${country}`,

	// addressee / locality, sub-locality (Tehran(city), Tehranpars) / street / premise,
	// floor / province (Tehran Province) / postcode / country.
	IR: addr`${attention}
${venue}
${locality}, ${dependent_locality}
${numberLastStreet}
${region}
${postcode}
${country}`,

	// addressee / region name / district name (Ruelle 5) / street name / street number +
	// apartment number / locality + postcode (AMMAN 11937) / JORDAN.
	JO: addr`${attention}
${venue}
${dependent_locality}
${numberLastStreet}
${locality} ${postcode}
${country}`,

	// addressee / p.o. box number + name of delivery post office / post office
	// code (20100) / town (NAKURU) / country.
	KE: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${postcode}
${locality}
${country}`,

	// addressee / premises + street + door (193, Avenue Chuy, apt. 28) / postcode +
	// locality (720001 BISHKEK) / province (ISSYK-KUL REGION) / country.
	KG: addr`${attention}
${venue}
${numberFirstCommaStreet}
${dependent_locality}
${postcode} ${locality}
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

	// addressee / premises + street (2 Fern Street) / locality subdivision (Greenlands)
	// / locality (Bassetere) / island (St Kitts) / postcode (KN0101).
	KN: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${region}
${postcode}
${country}`,

	// addressee / district name (Al-Sabbahiya) / zone + street name + building no. /
	// postcode + name of town (54404 KUWAIT) / country name.
	KW: addr`${attention}
${venue}
${dependent_locality}
${numberLastStreet}
${postcode} ${locality}
${country}`,

	// addressee / street + premises (ul. Shieli, dom 15) / postcode + village (L16T0H2, selo Abay)
	// / sub-province (Karasayskiy raion) / province (ALMATINSKIY OBLAST) / country.
	KZ: addr`${attention}
${venue}
${numberLastCommaStreet}
${dependent_locality}
${postcode}, ${locality}
${subregion}
${region}
${country}`,

	// addressee / street + premises (Kr. Barona street 7, dz. 1) / locality + postcode (RIGA, LV–1050)
	// / country. addressee / street + premises + sub-locality (Valdemāra street 42, Ainaži,)
	// / locality + postcode (SALACGRIVAS NOV., LV–4035) / country.
	LV: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${locality}, ${region}, ${prefixedSlot("postcode", "LV-")}
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
