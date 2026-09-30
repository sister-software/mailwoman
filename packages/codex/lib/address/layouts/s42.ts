/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Layouts for the jurisdictions whose libaddressinput record states `fmt: null`, derived from the UPU's own
 *   Standardized Address Format Description for each one.
 *
 *   A SAFD is the public rendering of a country's approved S42 template. It carries the metadata the template was
 *   registered with, a mapping of S42 element names to the country's own field names, a `STRUCTURE OF ADDRESS LINES`
 *   table, and worked examples that print an address beside its element decomposition. The line structure and the
 *   examples are what these layouts are read from.
 *
 *   These entries therefore have a different provenance from every other layout table here. The generated tables
 *   restate libaddressinput's `fmt`, which is a derived implementation observation. A SAFD is the postal operator's
 *   own submission, approved by the UPU, so it is the `approved-crosswalk` observation that
 *   `#address/convention-claims` names. Where the two disagree, both readings stay recorded rather than being
 *   reconciled.
 *
 *   Three of the eight record no postcode element at all: Botswana, Qatar and Zimbabwe. Three print the postcode
 *   before the locality and two after it, which is the fact libaddressinput's null `fmt` left unstated for all eight.
 */

import { addr, numberFirstCommaStreet, numberFirstStreet, SLOTS, type AddressLayout } from "#address/layout"

const { attention, country, dependent_locality, locality, postcode, region, venue } = SLOTS

/**
 * One jurisdiction's S42 template as this repository read it.
 *
 * The fields record what the SAFD's own metadata table states.
 * A later reader can then tell a 2012 approval from a 2021 one without opening the document.
 */
export interface S42LayoutRecord {
	/**
	 * The SAFD's `APPROVAL DATE`, as `YYYY-M`.
	 */
	approvedAt: string
	/**
	 * The SAFD's `LAST REVIEWED DATE`, as `YYYY-M`.
	 */
	reviewedAt: string
	/**
	 * The SAFD's `SAMPLE SIZE`, the number of worked examples it carries.
	 *
	 * Zimbabwe's reads 0 while its document prints examples, so this records the metadata
	 * rather than a count of what the document holds.
	 */
	sampleSize: number
	/**
	 * Where the template prints the postcode, or that it registers no postcode element.
	 */
	postcode: "before-locality" | "after-locality" | "absent"
	/**
	 * What the template states that this layout cannot express.
	 */
	unexpressed: readonly string[]
}

/**
 * What each SAFD states about its registration, and what this table drops.
 *
 * `unexpressed` exists because an S42 template distinguishes more than `ComponentTag`.
 * Botswana separates a ward from a neighbourhood.
 *
 * Zimbabwe separates two district positions.
 * This vocabulary has one `dependent_locality` for each pair.
 *
 * Recording the loss here keeps it legible rather than silent.
 */
export const S42_LAYOUT_RECORDS: Readonly<Record<string, S42LayoutRecord>> = {
	BW: {
		approvedAt: "2014-11",
		reviewedAt: "2014-11",
		sampleSize: 57,
		postcode: "absent",
		unexpressed: [
			"district lev 2 pos 1, the ward, which has no tag distinct from the neighbourhood",
			"del serv qualifier, the post office name, printed on its own line above the town",
			"prem id pos 1, the plot or portion number, printed on its own line above the street",
		],
	},
	DJ: {
		approvedAt: "2021-8",
		reviewedAt: "2021-8",
		sampleSize: 25,
		postcode: "before-locality",
		unexpressed: [
			"sec thoro, a second thoroughfare line beneath the first",
			"district lev2, a sub-district above the district",
			"del serv qualifier, printed on the postcode and town line",
		],
	},
	KM: {
		approvedAt: "2021-9",
		reviewedAt: "2021-9",
		sampleSize: 17,
		postcode: "before-locality",
		unexpressed: ["floor and wing, printed as one building-details line above the building"],
	},
	LC: {
		approvedAt: "2019-12",
		reviewedAt: "2019-12",
		sampleSize: 4,
		postcode: "after-locality",
		unexpressed: [
			"del serv qualifier, the post office name, printed with the postcode",
			"door type and door ind, printed with the building",
		],
	},
	QA: {
		approvedAt: "2019-5",
		reviewedAt: "2019-5",
		sampleSize: 40,
		postcode: "absent",
		unexpressed: [
			"prem id, the building number, printed on its own line above the street rather than within it",
			"supp DP data, a telephone number printed as an address line",
		],
	},
	TT: {
		approvedAt: "2012-2",
		reviewedAt: "2018-9",
		sampleSize: 13,
		postcode: "after-locality",
		unexpressed: [
			"district lev 2 pos 1, the sub-community, which has no tag distinct from the community",
			"wing and floor, printed with the building",
		],
	},
	UG: {
		approvedAt: "2012-2",
		reviewedAt: "2015-3",
		sampleSize: 68,
		postcode: "before-locality",
		unexpressed: [
			"town, which Uganda maps to the village name rather than to the city; its examples print the postcode against `region`, which Uganda maps to the locality",
			"district, the zone name, printed with the premises identifier",
		],
	},
	ZW: {
		approvedAt: "2015-4",
		reviewedAt: "2015-4",
		sampleSize: 0,
		postcode: "absent",
		unexpressed: [
			"district lev 1 pos 2, a second district position beneath the first",
			"street no pos 2, a rural plot number printed on its own line",
			"del serv qual, the post office name",
		],
	},
}

/**
 * The layout a retrieved SAFD states, for comparison rather than for rendering.
 *
 * `layoutForCountry` reads {@linkcode S42_ADDRESS_LAYOUTS} and never this one.
 * This table sets the crosswalk against libaddressinput and the board.
 *
 * That comparison turns the `upu-s42` observation from `unread` into a stance.
 *
 * It holds the eight layouts below plus the United Kingdom's.
 * The United Kingdom's template was retrieved, and its board entry already states an order.
 * A jurisdiction absent here has a template nobody has read.
 */
export const S42_READ_LAYOUTS: Readonly<Record<string, AddressLayout>> = {
	// SAFD lines: PO-BOX, SUB-BLDG-NAME, BLDG-NAME, BLDG-NO-THORO, DEP-LOC,
	// POST-TOWN, COUNTY, POSTCODE, COUNTRY.
	// `BLDG-NO-THORO-LINE` prints `prem id & prim thoro name & succ prim thoro type`.
	// The postcode takes its own line beneath the county, which the board also states.
	GB: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${region}
${postcode}
${country}`,
}

/**
 * Layouts keyed by ISO 3166-1 alpha-2, read from each jurisdiction's SAFD.
 *
 * Each entry quotes the SAFD's `STRUCTURE OF ADDRESS LINES` rows in print order.
 * A reader can then check the layout against the document without opening it.
 */
export const S42_ADDRESS_LAYOUTS: Readonly<Record<string, AddressLayout>> = {
	// SAFD lines: PLOT, STREET-ADDRESS, PO-BOX, DISTRICT-1, POSTOFFICE-NAME, TOWN, COUNTRY.
	// Botswana registers no postcode element.
	BW: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${country}`,

	// SAFD lines: PO-BOX, thoroughfare 1, thoroughfare 2, sub-district, district,
	// postcode and town, external country.
	// `postcode and town` prints `postcode & town`, which is why 77501 precedes OBOCK.
	DJ: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${postcode} ${locality}
${country}`,

	// SAFD lines: post office box, building details, building, thoroughfare,
	// postcode and town, external country.
	// `thoroughfare` prints `prem id & ', ' & thoro`, so the number carries a comma.
	// `external country` prints `region & ', ' & country name`.
	KM: addr`${attention}
${venue}
${numberFirstCommaStreet}
${postcode} ${locality} ${dependent_locality}
${region}, ${country}`,

	// SAFD lines: PO-BOX, BLDG, STREET-ADDRESS, TOWN, POST OFFICE, POSTCODE, COUNTRY.
	// `POSTCODE-LINE` prints `town & postcode`, which is why LC04 301 follows Castries.
	LC: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${postcode}
${country}`,

	// SAFD lines: post office box, building, street, district, TEL NO, TOWN, country.
	// Qatar registers no postcode element.
	// Its `thoro` carries the street name and the street number together.
	QA: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${country}`,

	// `postcode and town` prints `town & postcode`, so 120110 follows DIEGO MARTIN.
	// The SAFD's district lev 2 sits above district lev 1, and both map to one tag here.
	TT: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality} ${postcode}
${country}`,

	// `POSTCODE-REGION-LINE` prints `postcode & region`, and takes `locality` here.
	// Uganda's own mapping table reads `region → Locality` and `town → Village name`.
	// The S42 element name would tag Kampala as a region, leaving the postcode claim silent.
	UG: addr`${attention}
${venue}
${numberFirstStreet}
${postcode} ${locality}
${country}`,

	// Zimbabwe registers no postcode element.
	// Its STREET-ADDRESS carries district lev 2, and DISTRICT-1-LINE carries district lev 1.
	ZW: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${country}`,
}
