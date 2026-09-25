/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Defines the hand-curated board rows for target families F3, F5, F7 and F9.
 */

/**
 * Identifies one of the target families on the family board.
 */
export type TargetFamily = "F3" | "F5" | "F7" | "F9"

/**
 * Describes the gazetteer record whose point is a row's expected coordinate.
 */
export interface PlaceLookup {
	name: string
	country: string
	/**
	 * Sets a name the record must sit under, such as `London` for `Camden`.
	 */
	parent?: string
	/**
	 * Restricts the lookup to these placetypes when the name matches more than one record.
	 */
	placetypes?: readonly string[]
}

/**
 * Describes one family-board row.
 */
export interface FamilyRow {
	family: TargetFamily
	id: string
	input: string
	country: string
	addressKind: string
	expectComponents: Record<string, string>
	/**
	 * Holds the gazetteer lookup.
	 * A parse-only row, such as a po_box row, has none.
	 */
	place?: PlaceLookup
	toleranceM?: number
	note?: string
}

/**
 * Sets the tolerance around a district's own point.
 *
 * The parent city's point is the wrong answer, and it usually lies farther away than this.
 */
const DISTRICT_TOLERANCE_M = 2000

/**
 * Sets the tolerance around a locality's point.
 */
const LOCALITY_TOLERANCE_M = 25_000

/**
 * Sets the tolerance for rows checked against the larger place's point,
 * such as `St Mary's, Oxford` against Oxford.
 */
const QUALIFIER_TOLERANCE_M = 10_000

/**
 * Builds an id suffix by lowercasing the input and replacing each run of non-alphanumerics with one dash.
 *
 * An input that is already lowercase gets `-lower`, so it and its cased twin keep distinct ids.
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
 * Lists every family-board row in family order.
 *
 * Coordinates are never typed here.
 * `family-board.run.ts` reads each point from the admin gazetteer and refuses a
 * name it finds zero times or more than once.
 * Each family also has lowercase rows.
 *
 * - F3 rows pair a district with its city and assert `dependent_locality`, because the
 *   defect tags the district as a street and returns the city's point.
 * - F5 rows write the postcode after the locality, as New Zealand, South Africa and Venezuela do.
 * - F7 rows carry a possessive, either as a qualifier such as `St Mary's, Oxford`
 *   or inside a town name such as `King's Lynn`.
 * - F9 rows are parse-only Commonwealth and military PO boxes.
 *   A military row follows the synthesizer's convention: the unit line is `po_box`,
 *   APO/FPO/DPO is the locality and AA/AE/AP is the region.
 */
export const FAMILY_ROWS: readonly FamilyRow[] = [
	// F3 rows pair a district with its city.
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

	// F5 rows write the postcode after the locality.
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

	// F7 rows carry a possessive.
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

	// F9 rows are parse-only Commonwealth and military PO boxes.
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
