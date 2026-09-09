/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The curated rows of the four target families that had no board (#1931 task 6), each authored from the set its
 *   issue attests. The SELECTION is by hand and every row says which family it pins; the POINTS are never typed: a row
 *   that names a place carries the gazetteer lookup (`name`, `country`, `parent`) and `family-board.run.ts` reads the
 *   coordinate off the admin gazetteer, refusing a name it cannot find or finds twice.
 *
 *   - **F3, district plus city (#1914).** `Camden, London` tags the district `street` and answers the parent city's
 *     point, 5 of 5 probes. The truth is the district's own record with `dependent_locality` asserted, at 2 km: London's
 *     point is 5.6 km from Camden's, Berlin's 2.6 km from Kreuzberg's, so the coordinate separates the two answers where
 *     it can and the component assertion separates them where it cannot (Le Marais sits 0.4 km from Paris's point).
 *   - **F5, «locality» «postcode» (#1821).** `Barcelona 6001, Anzoátegui, Venezuela` reads as street plus house number.
 *     New Zealand and South Africa write the same order, so the family is attested on three countries, each row
 *     asserting the postcode and the locality, at the locality's 25 km. `Auckland` is also a region 42 km from the city.
 *   - **F7, the possessive qualifier (#1754).** `St Mary's, Oxford` decodes to one component and answers Georgia. The
 *     issue's own hierarchy (`locality=Oxford › dependent_locality=St Mary's`) is asserted against Oxford's point; the
 *     other rows are possessives the gazetteer knows: neighbourhoods of London and New York, and towns whose own name
 *     carries the apostrophe (`King's Lynn`, `Lee's Summit`, `St. John's`).
 *   - **F9, Commonwealth and military po_box (#517).** The postal arena's last 0% class, parse-only: `GPO Box`,
 *     `Locked Bag`, `Private Bag`, and the military line `PSC 802 Box 74, APO AE 09499` under the synthesizer's gold
 *     convention (the unit line is `po_box`, APO/FPO/DPO the locality, AA/AE/AP the region).
 *
 *   A lowercase leg rides with each family, the user register every eval carries.
 */

export type TargetFamily = "F3" | "F5" | "F7" | "F9"

/**
 * A gazetteer lookup: the record whose point is the row's truth.
 */
export interface PlaceLookup {
	name: string
	country: string
	/**
	 * A name the record must sit under (`London` for `Camden`); empty when the name alone is unambiguous.
	 */
	parent?: string
	/**
	 * Restrict to these placetypes when the name answers more than one record.
	 */
	placetypes?: readonly string[]
}

export interface FamilyRow {
	family: TargetFamily
	id: string
	input: string
	country: string
	addressKind: string
	expectComponents: Record<string, string>
	/**
	 * Absent for a parse-only row (the po_box family).
	 */
	place?: PlaceLookup
	toleranceM?: number
	note?: string
}

/**
 * The district is the truth; the parent city's point is the defect's answer.
 */
const DISTRICT_TOLERANCE_M = 2000

/**
 * A locality's own tolerance on this board.
 */
const LOCALITY_TOLERANCE_M = 25_000

/**
 * The qualifier rows assert the larger place's point where the smaller one has no record (`St Mary's`).
 */
const QUALIFIER_TOLERANCE_M = 10_000

/**
 * The id's tail: the input lower-cased, every run of non-alphanumerics one dash. A lowercase leg (an input that is
 * already its own lowercase) carries `-lower`, so it and its cased twin keep distinct ids.
 */
function slugOf(input: string): string {
	const slug = input
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/gu, "-")
		.replaceAll(/^-|-$/gu, "")

	return input === input.toLowerCase() ? `${slug}-lower` : slug
}

function district(
	cc: string,
	districtName: string,
	city: string,
	options: { placetypes?: readonly string[]; input?: string } = {}
): FamilyRow {
	const input = options.input ?? `${districtName}, ${city}`
	const slug = slugOf(input)

	return {
		family: "F3",
		id: `${cc.toLowerCase()}-f3-${slug}`,
		input,
		country: cc,
		addressKind: "district_city",
		expectComponents: { dependent_locality: districtName, locality: city },
		place: {
			name: districtName,
			country: cc,
			parent: city,
			...(options.placetypes ? { placetypes: options.placetypes } : {}),
		},
		toleranceM: DISTRICT_TOLERANCE_M,
	}
}

function localityPostcode(
	cc: string,
	input: string,
	expect: Record<string, string>,
	lookupName: string = expect["locality"]!
): FamilyRow {
	const slug = slugOf(input)

	return {
		family: "F5",
		id: `${cc.toLowerCase()}-f5-${slug}`,
		input,
		country: cc,
		addressKind: "locality_postcode_trailing",
		expectComponents: expect,
		place: { name: lookupName, country: cc, placetypes: ["locality"] },
		toleranceM: LOCALITY_TOLERANCE_M,
	}
}

function possessive(
	cc: string,
	input: string,
	expect: Record<string, string>,
	place: PlaceLookup,
	toleranceM: number
): FamilyRow {
	const slug = slugOf(input)

	return {
		family: "F7",
		id: `${cc.toLowerCase()}-f7-${slug}`,
		input,
		country: cc,
		addressKind: "possessive_qualifier",
		expectComponents: expect,
		place,
		toleranceM,
	}
}

function poBox(
	cc: string,
	input: string,
	expect: Record<string, string>,
	kind: "po_box_commonwealth" | "po_box_military"
): FamilyRow {
	const slug = slugOf(input)

	return {
		family: "F9",
		id: `${cc.toLowerCase()}-f9-${slug}`,
		input,
		country: cc,
		addressKind: kind,
		expectComponents: expect,
	}
}

/**
 * The board: every row of the four families, in family order. The header says where each family's rows come from.
 */
export const FAMILY_ROWS: readonly FamilyRow[] = [
	// F3 — district plus city.
	district("GB", "Camden", "London", { placetypes: ["borough"] }),
	district("GB", "Camden", "London", { placetypes: ["borough"], input: "camden, london" }),
	district("GB", "Hackney", "London", { placetypes: ["borough"] }),
	district("GB", "Islington", "London", { placetypes: ["borough"] }),
	district("GB", "Clifton", "Bristol"),
	district("GB", "Didsbury", "Manchester"),
	district("GB", "Leith", "Edinburgh"),
	district("DE", "Kreuzberg", "Berlin"),
	district("DE", "Kreuzberg", "Berlin", { input: "kreuzberg, berlin" }),
	district("DE", "Schwabing", "München"),
	district("DE", "Altona", "Hamburg", { placetypes: ["borough"] }),
	district("FR", "Montmartre", "Paris"),
	district("FR", "Le Marais", "Paris"),
	district("FR", "La Croix-Rousse", "Lyon"),
	district("US", "Brooklyn", "New York", { placetypes: ["borough"] }),
	district("US", "Brooklyn", "New York", { placetypes: ["borough"], input: "brooklyn, new york" }),
	district("US", "Hollywood", "Los Angeles"),
	district("US", "Wicker Park", "Chicago"),
	district("US", "Capitol Hill", "Seattle"),
	district("ES", "Triana", "Sevilla"),
	district("IT", "Brera", "Milano"),

	// F5 — «locality» «postcode», the postcode after the city.
	localityPostcode("NZ", "Auckland 1010", { locality: "Auckland", postcode: "1010" }),
	localityPostcode("NZ", "auckland 1010", { locality: "auckland", postcode: "1010" }, "Auckland"),
	localityPostcode("NZ", "Wellington 6011", { locality: "Wellington", postcode: "6011" }),
	localityPostcode("NZ", "Christchurch 8011", { locality: "Christchurch", postcode: "8011" }),
	localityPostcode("NZ", "Dunedin 9016", { locality: "Dunedin", postcode: "9016" }),
	localityPostcode("NZ", "Hamilton 3204", { locality: "Hamilton", postcode: "3204" }),
	localityPostcode(
		"NZ",
		"Queen Street, Auckland 1010",
		{ street: "Queen Street", locality: "Auckland", postcode: "1010" },
		"Auckland"
	),
	localityPostcode("ZA", "Cape Town 8001", { locality: "Cape Town", postcode: "8001" }),
	localityPostcode("ZA", "Johannesburg 2000", { locality: "Johannesburg", postcode: "2000" }),
	localityPostcode("ZA", "Durban 4001", { locality: "Durban", postcode: "4001" }),
	localityPostcode("ZA", "Pretoria 0002", { locality: "Pretoria", postcode: "0002" }),
	localityPostcode(
		"ZA",
		"Long Street, Cape Town 8001",
		{ street: "Long Street", locality: "Cape Town", postcode: "8001" },
		"Cape Town"
	),
	localityPostcode("VE", "Barcelona 6001, Venezuela", {
		locality: "Barcelona",
		postcode: "6001",
		country: "Venezuela",
	}),
	localityPostcode("VE", "Maracaibo 4001, Zulia, Venezuela", {
		locality: "Maracaibo",
		postcode: "4001",
		region: "Zulia",
		country: "Venezuela",
	}),
	localityPostcode("VE", "Valencia 2001, Carabobo, Venezuela", {
		locality: "Valencia",
		postcode: "2001",
		region: "Carabobo",
		country: "Venezuela",
	}),
	localityPostcode("VE", "Caracas 1010, Venezuela", { locality: "Caracas", postcode: "1010", country: "Venezuela" }),
	localityPostcode(
		"VE",
		"caracas 1010, venezuela",
		{ locality: "caracas", postcode: "1010", country: "venezuela" },
		"Caracas"
	),

	// F7 — the possessive qualifier.
	possessive(
		"GB",
		"St Mary's, Oxford",
		{ dependent_locality: "St Mary's", locality: "Oxford" },
		{ name: "Oxford", country: "GB", placetypes: ["locality"] },
		QUALIFIER_TOLERANCE_M
	),
	possessive(
		"GB",
		"st mary's, oxford",
		{ dependent_locality: "st mary's", locality: "oxford" },
		{ name: "Oxford", country: "GB", placetypes: ["locality"] },
		QUALIFIER_TOLERANCE_M
	),
	possessive(
		"GB",
		"St Mary's Church, Oxford",
		{ venue: "St Mary's Church", locality: "Oxford" },
		{ name: "Oxford", country: "GB", placetypes: ["locality"] },
		QUALIFIER_TOLERANCE_M
	),
	possessive(
		"GB",
		"King's Cross, London",
		{ dependent_locality: "King's Cross", locality: "London" },
		{ name: "King's Cross", country: "GB", parent: "London" },
		DISTRICT_TOLERANCE_M
	),
	possessive(
		"GB",
		"king's cross, london",
		{ dependent_locality: "king's cross", locality: "london" },
		{ name: "King's Cross", country: "GB", parent: "London" },
		DISTRICT_TOLERANCE_M
	),
	possessive(
		"GB",
		"Earl's Court, London",
		{ dependent_locality: "Earl's Court", locality: "London" },
		{ name: "Earl's Court", country: "GB", parent: "London" },
		DISTRICT_TOLERANCE_M
	),
	possessive(
		"GB",
		"Queen's Park, London",
		{ dependent_locality: "Queen's Park", locality: "London" },
		{ name: "Queen's Park", country: "GB", parent: "London" },
		DISTRICT_TOLERANCE_M
	),
	possessive(
		"GB",
		"King's Lynn, Norfolk",
		{ locality: "King's Lynn", region: "Norfolk" },
		{ name: "King's Lynn", country: "GB", placetypes: ["locality"] },
		QUALIFIER_TOLERANCE_M
	),
	possessive(
		"GB",
		"Bishop's Stortford, Hertfordshire",
		{ locality: "Bishop's Stortford", region: "Hertfordshire" },
		{ name: "Bishop's Stortford", country: "GB", placetypes: ["locality"] },
		QUALIFIER_TOLERANCE_M
	),
	possessive(
		"GB",
		"St David's, Pembrokeshire",
		{ locality: "St David's", region: "Pembrokeshire" },
		{ name: "St David's", country: "GB", placetypes: ["locality"] },
		QUALIFIER_TOLERANCE_M
	),
	possessive(
		"US",
		"Hell's Kitchen, New York",
		{ dependent_locality: "Hell's Kitchen", locality: "New York" },
		{ name: "Hell's Kitchen", country: "US", parent: "New York" },
		DISTRICT_TOLERANCE_M
	),
	possessive(
		"US",
		"Lee's Summit, Missouri",
		{ locality: "Lee's Summit", region: "Missouri" },
		{ name: "Lee's Summit", country: "US", placetypes: ["locality"] },
		QUALIFIER_TOLERANCE_M
	),
	possessive(
		"CA",
		"St. John's, Newfoundland and Labrador",
		{ locality: "St. John's", region: "Newfoundland and Labrador" },
		{ name: "St. John's", country: "CA", placetypes: ["locality"] },
		QUALIFIER_TOLERANCE_M
	),

	// F9 — Commonwealth and military po_box, parse-only.
	poBox(
		"AU",
		"GPO Box 1234, Sydney NSW 2001",
		{ po_box: "GPO Box 1234", locality: "Sydney", region: "NSW", postcode: "2001" },
		"po_box_commonwealth"
	),
	poBox(
		"AU",
		"gpo box 1234, sydney nsw 2001",
		{ po_box: "gpo box 1234", locality: "sydney", region: "nsw", postcode: "2001" },
		"po_box_commonwealth"
	),
	poBox(
		"AU",
		"Locked Bag 20, Melbourne VIC 3001",
		{ po_box: "Locked Bag 20", locality: "Melbourne", region: "VIC", postcode: "3001" },
		"po_box_commonwealth"
	),
	poBox(
		"AU",
		"PO Box 100, Brisbane QLD 4001",
		{ po_box: "PO Box 100", locality: "Brisbane", region: "QLD", postcode: "4001" },
		"po_box_commonwealth"
	),
	poBox(
		"AU",
		"Locked Bag 4, Canberra ACT 2601",
		{ po_box: "Locked Bag 4", locality: "Canberra", region: "ACT", postcode: "2601" },
		"po_box_commonwealth"
	),
	poBox(
		"AU",
		"GPO Box 2, Perth WA 6001",
		{ po_box: "GPO Box 2", locality: "Perth", region: "WA", postcode: "6001" },
		"po_box_commonwealth"
	),
	poBox(
		"NZ",
		"Private Bag 92019, Auckland 1142",
		{ po_box: "Private Bag 92019", locality: "Auckland", postcode: "1142" },
		"po_box_commonwealth"
	),
	poBox(
		"NZ",
		"PO Box 5, Wellington 6140",
		{ po_box: "PO Box 5", locality: "Wellington", postcode: "6140" },
		"po_box_commonwealth"
	),
	poBox(
		"NZ",
		"Private Bag 4800, Christchurch 8140",
		{ po_box: "Private Bag 4800", locality: "Christchurch", postcode: "8140" },
		"po_box_commonwealth"
	),
	poBox(
		"GB",
		"PO Box 123, London SW1A 1AA",
		{ po_box: "PO Box 123", locality: "London", postcode: "SW1A 1AA" },
		"po_box_commonwealth"
	),
	poBox(
		"US",
		"PSC 802 Box 74, APO AE 09499",
		{ po_box: "PSC 802 Box 74", locality: "APO", region: "AE", postcode: "09499" },
		"po_box_military"
	),
	poBox(
		"US",
		"psc 802 box 74, apo ae 09499",
		{ po_box: "psc 802 box 74", locality: "apo", region: "ae", postcode: "09499" },
		"po_box_military"
	),
	poBox(
		"US",
		"CMR 402 Box 1234, APO AE 09180",
		{ po_box: "CMR 402 Box 1234", locality: "APO", region: "AE", postcode: "09180" },
		"po_box_military"
	),
	poBox(
		"US",
		"Unit 2050 Box 4190, DPO AP 96278",
		{ po_box: "Unit 2050 Box 4190", locality: "DPO", region: "AP", postcode: "96278" },
		"po_box_military"
	),
	poBox(
		"US",
		"PSC 3 Box 4120, APO AA 34002",
		{ po_box: "PSC 3 Box 4120", locality: "APO", region: "AA", postcode: "34002" },
		"po_box_military"
	),
	poBox(
		"US",
		"Unit 8400 Box 0001, DPO AE 09498",
		{ po_box: "Unit 8400 Box 0001", locality: "DPO", region: "AE", postcode: "09498" },
		"po_box_military"
	),
]
