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

import { ConventionSource, type LayoutCitation } from "#address/convention-claims"
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
	withSoftBreakBefore,
	type AddressLayout,
} from "#address/layout"
import { documentedPostcodeSlot } from "#labels/postcode/documented-forms"

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
 * A record read from the description `citation` cites, admitted for `admittedBecause`.
 */
export function described(
	admittedBecause: UPUAdmission,
	postcodeAt: UPUPostalAddressingRecord["postcode"],
	citation: LayoutCitation
): UPUPostalAddressingRecord {
	return { ...citation, source: ConventionSource.PostalAddressingSystems, admittedBecause, postcode: postcodeAt }
}

/**
 * The addressee, the street with its number after the name, the district and the locality:
 * the lines of every description below that prints no postcode and no region.
 */
const NUMBER_LAST_LOCALITY = addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${locality}
${country}`

/**
 * {@linkcode NUMBER_LAST_LOCALITY} with the number before the street name.
 */
const NUMBER_FIRST_LOCALITY = addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${country}`

/**
 * {@linkcode NUMBER_LAST_LOCALITY} with the number before the street name and a comma after it.
 */
const NUMBER_FIRST_COMMA_LOCALITY = addr`${attention}
${venue}
${numberFirstCommaStreet}
${dependent_locality}
${locality}
${country}`

/**
 * The locality followed by its postcode on one line, below a number-first street.
 */
const LOCALITY_THEN_POSTCODE = addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality} ${postcode}
${country}`

/**
 * The postcode before the locality on one line, the region below them.
 */
const POSTCODE_LOCALITY_REGION = addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${postcode} ${locality}
${region}
${country}`

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

	// addressee / street + premises ‘- ’ door (Laisvės pr. 40-12) / country code -
	// postcode + locality (LT–04340 Vilnius) / country.
	LT: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${documentedPostcodeSlot("LT")} ${locality}
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

	// Mr. Mohamed Ali Khalifa / Av.
	// Al Ghazaly 12 / TRIPOLI / LIBYA.
	LY: NUMBER_LAST_LOCALITY,

	// M. Kalilou Sissoko / Rue 406 – porte 39 / Magnabougou / BAMAKO / MALI.
	ML: NUMBER_LAST_LOCALITY,

	// addressee / house number + street (No. 5/60, Aye Myittar street,) / quarter name / town
	// (or) township name + "," postcode (Pyigyitagon Township, 0505001) / state or region / country.
	MM: addr`${attention}
${venue}
${numberFirstCommaStreet}
${dependent_locality}
${locality}, ${postcode}
${region}
${country}`,

	// B.P. 35 / NOUAKCHOTT / MAURITANIA.
	MR: NUMBER_FIRST_COMMA_LOCALITY,

	// addressee / premise + street (38 Triq it-Tempji Neolitici) / locality
	// (IL-HAMRUN) / postcode (HMR 1428) / country.
	MT: withSoftBreakBefore(
		addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${postcode}
${country}`,
		"postcode"
	),

	// addressee / premises "," + street (10, rue Claude Delaître) / sub-locality
	// (Les Guibies) / locality + postcode (PORT LOUIS 11213) / country.
	MU: addr`${attention}
${venue}
${numberFirstCommaStreet}
${dependent_locality}
${locality} ${postcode}
${country}`,

	// addressee / street + premises (21 Dunduzu Avenue) / postcode + locality (102010 KASUNGU) / country.
	MW: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${postcode} ${locality}
${country}`,

	// José Matola / Av.
	// Mártires da Machava / 252, 5o andar, flat 3 / 1100 MAPUTO / MAPUTO / MOZAMBIQUE.
	MZ: addr`${attention}
${venue}
${numberLastCommaStreet}
${dependent_locality}
${postcode} ${locality}
${region}
${country}`,

	// addressee / sub-locality (Bello Horizonte C-IV-45) / postcode (11147) / locality,
	// province (Managua, Managua) / country.
	NI: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${postcode}
${locality}, ${region}
${country}`,

	// addressee / district (BOE DISTRICT) / postcode (NRU68) / country.
	NR: addr`${attention}
${venue}
${numberFirstStreet}
${locality}
${region}
${postcode}
${country}`,

	// addressee / street (Tapeu-Porritt Rd) / locality (Alofi) / postcode (9974) / country.
	NU: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${postcode}
${country}`,

	// addressee / street, premise, sub-locality (Av. Larco 1301, Miraflores) /
	// postcode (15074) / province (LIMA) / country.
	PE: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${locality}
${postcode}
${region}
${country}`,

	// addressee / locality (Dahiyat al Bareed) / thoroughfare (Gabriel Almataran) / town
	// (Ar Ram) / locality + postcode (JERUSALEM P126xxxx) / country.
	PS: addr`${attention}
${venue}
${dependent_locality}
${numberFirstStreet}
${locality}
${region} ${postcode}
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

	// addressee / building number + street (3909 Abdullhamid Alkatib St) / additional number +
	// district name (7318 Azahrah Dist.) / postcode (12987) / locality (RIYADH) / country.
	SA: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${postcode}
${locality}
${country}`,

	// Ms. R. Pana / P.O. Box 1925 / HONIARA / SOLOMON ISLANDS.
	SB: NUMBER_LAST_LOCALITY,

	// Mr. Mohamed Ahmed Ali / Immeuble de la fraternité / Rue Al-Comhouriya /
	// B.P. 211 / 11111 / KHARTOUM / SUDAN.
	SD: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${postcode}
${locality}
${country}`,

	// Mr. John Kamara / 7A Ross Road Cline / FREETOWN / SIERRA LEONE.
	SL: NUMBER_FIRST_LOCALITY,

	// The operator's contact block: POST OFFICE BOX 33 / JUBA / SOUTH SUDAN (REP.).
	SS: NUMBER_LAST_LOCALITY,

	// Sra.
	// Eugenia Fernandes / RIBEIRA AFONSO / SAO TOME AND PRINCIPE.
	ST: NUMBER_LAST_LOCALITY,

	// addressee / street + premises (6a AVENIDA NORTE 165) / postcode + locality
	// (2201 SAN SALVADOR) / country.
	// The envelope prints the department after the locality: `1120 SOYAPANGO, SAN SALVADOR`.
	SV: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${postcode} ${locality}, ${region}
${country}`,

	// addressee / floor, apartment, building / street name and number (`Rue Youssef Al Azamah, no 25`)
	// / district number and name (06/Saroufa) / 0100 DAMASCUS / SYRIAN ARAB REP.
	SY: addr`${attention}
${venue}
${numberLastCommaStreet}
${dependent_locality}
${postcode} ${locality}
${country}`,

	// Ms HALIME ABDELKADER / BP 4148 / NDJAMENA / CHAD.
	TD: NUMBER_LAST_LOCALITY,

	// M. Nicolas Ayi Patatu / B.P. 526 / LOME / TOGO.
	TG: NUMBER_FIRST_COMMA_LOCALITY,

	// addressee / house No. + street name, sub-district / district, province
	// (Amphoe Tanyaburi, Pathumthani) / postcode (12130) / country.
	TH: withSoftBreakBefore(
		addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}, ${region}
${postcode}
${country}`,
		"postcode"
	),

	// `See New Zealand.`: New Zealand's lines without a postcode, because Tokelau has none.
	TK: NUMBER_FIRST_LOCALITY,

	// addressee / thoroughfare + no. of thoroughfare (TRAVESSA LAVANDARIA NO.12) / region +
	// locality + postcode (BAIRO PITE – DILI TL11212) / P.O. box / country.
	TL: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality} – ${locality} ${postcode}
${country}`,

	// addressee / street + premise (koche Amyderya, j. 24) / locality / province (LEBAP) / postcode (746150).
	TM: addr`${attention}
${venue}
${numberLastCommaStreet}
${dependent_locality}
${locality}
${region}
${postcode}
${country}`,

	// The operator's contact block: Tonga Post / General Post Office / NUKU’ALOFA / TONGA.
	TO: NUMBER_FIRST_LOCALITY,

	// addressee / sub-locality (Doğanbey Mah.) / street + premise (Şehitteğmenkalmaz Cad. 28/A)
	// / postcode + locality/province (06101 ULUS/ANKARA) / country.
	TR: addr`${attention}
${venue}
${dependent_locality}
${numberLastStreet}
${postcode} ${locality}/${region}
${country}`,

	// addressee / road name (Te Vao Road) / postcode + locality (TUV150 Vaiaku)
	// / island name (Funafuti) / country.
	TV: POSTCODE_LOCALITY_REGION,

	// addressee / premise + street (22 Ally Hassan Mwinyi) / postcode + locality
	// (14111 MSASANI) / province (DAR ES SALAM) / country.
	TZ: POSTCODE_LOCALITY_REGION,

	// addressee / street + premises + door (Chaná 1215, apto. 152) / postcode –
	// locality + province (70200 – ROSARIO, COLONIA) / country.
	// `The locality is separated from the postcode by a dash`.
	UY: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${postcode} – ${locality}, ${region}
${country}`,

	// addressee / building (Palazzo San Calisto) / thoroughfare (Piazza San Calisto)
	// / postcode + locality (00120 Città del Vaticano) / country.
	// The description adopts Italy's format, and Italy writes the number after the street name.
	VA: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${postcode} ${locality}
${country}`,

	// addressee / thoroughfare (HALIFAX STREET) / locality (KINGSTOWN) / postcode (VC0120) / country.
	VC: withSoftBreakBefore(
		addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${locality}
${postcode}
${country}`,
		"postcode"
	),

	// addressee / P.O. Box number / building number + thoroughfare (#10 Road Town)
	// / post town + postcode (TORTOLA VG1110) / country.
	VG: LOCALITY_THEN_POSTCODE,

	// The operator's contact block: Vanuatu Post Limited / P.O. Box 43 / PORT VILA / VANUATU.
	VU: NUMBER_LAST_LOCALITY,

	// addressee / sub-locality (Manono Tai) / locality + postcode (Manono WS1190) / country.
	WS: addr`${attention}
${venue}
${numberLastStreet}
${dependent_locality}
${locality} ${prefixedSlot("postcode", "WS")}
${country}`,

	// `See contact address`: Organisme général des postes / B.P. 1993 / SANA'A / YEMEN.
	YE: NUMBER_FIRST_COMMA_LOCALITY,

	// addressee / premise + street (21 Independence Avenue) / locality + postcode (KITWE 23456) / country.
	ZM: LOCALITY_THEN_POSTCODE,
}
