/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Layouts for countries where libaddressinput has `fmt: null`.
 *
 * These were read from each country's UPU Standardized Address Format
 * Description (SAFD), using its line-structure table and examples.
 *
 * SAFD-based layouts are kept separate from generated `fmt` layouts.
 * If they differ, both are kept as-is.
 *
 * Of these eight countries, Botswana, Qatar, and Zimbabwe have no
 * postcode element. Three place postcode before locality, two after.
 */

import { addr, numberFirstCommaStreet, numberFirstStreet, SLOTS, type AddressLayout } from "#address/layout"

const { attention, country, dependent_locality, locality, postcode, region, venue } = SLOTS

/**
 * Metadata read from one country's SAFD.
 */
export interface S42LayoutRecord {
	/**
	 * SAFD `APPROVAL DATE`, as `YYYY-M`.
	 */
	approvedAt: string
	/**
	 * SAFD `LAST REVIEWED DATE`, as `YYYY-M`.
	 */
	reviewedAt: string
	/**
	 * SAFD `SAMPLE SIZE`.
	 *
	 * Note: Zimbabwe says 0 even though examples are printed.
	 */
	sampleSize: number
	/**
	 * Where postcode appears, or `absent` if none is defined.
	 */
	postcode: "before-locality" | "after-locality" | "absent"
	/**
	 * Details in the SAFD this layout cannot represent.
	 */
	unexpressed: readonly string[]
}

/**
 * Per-country SAFD metadata and known details that are not representable here.
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
 * SAFD layouts kept for comparison, not rendering.
 *
 * `layoutForCountry` uses {@linkcode S42_ADDRESS_LAYOUTS}, not this table.
 *
 * Includes the eight countries below plus GB.
 */
export const S42_READ_LAYOUTS: Readonly<Record<string, AddressLayout>> = {
	// SAFD lines: PO-BOX, SUB-BLDG-NAME, BLDG-NAME, BLDG-NO-THORO, DEP-LOC,
	// POST-TOWN, COUNTY, POSTCODE, COUNTRY.
	// `BLDG-NO-THORO-LINE` prints `prem id & prim thoro name & succ prim thoro type`.
	// Postcode is on its own line under county.
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
 * Layouts by ISO 3166-1 alpha-2, read from each country's SAFD.
 *
 * Comments list SAFD line order for quick checking.
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
	// `postcode and town` prints `postcode & town`.
	DJ: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${postcode} ${locality}
${country}`,

	// SAFD lines: post office box, building details, building, thoroughfare,
	// postcode and town, external country.
	// `thoroughfare` prints `prem id & ', ' & thoro` (number with comma).
	// `external country` prints `region & ', ' & country name`.
	KM: addr`${attention}
${venue}
${numberFirstCommaStreet}
${postcode} ${locality} ${dependent_locality}
${region}, ${country}`,

	// SAFD lines: PO-BOX, BLDG, STREET-ADDRESS, TOWN, POST OFFICE, POSTCODE, COUNTRY.
	// `POSTCODE-LINE` prints `town & postcode`.
	LC: addr`${attention}
${venue}
${numberFirstStreet}
${locality} ${postcode}
${country}`,

	// SAFD lines: post office box, building, street, district, TEL NO, TOWN, country.
	// Qatar registers no postcode element.
	// Its `thoro` includes street name and number together.
	QA: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${country}`,

	// `postcode and town` prints `town & postcode`.
	// District levels 1 and 2 both map to one tag here.
	TT: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality} ${postcode}
${country}`,

	// `POSTCODE-REGION-LINE` prints `postcode & region`, using `locality` here.
	// Uganda maps `region → Locality` and `town → Village name`.
	UG: addr`${attention}
${venue}
${numberFirstStreet}
${postcode} ${locality}
${country}`,

	// Zimbabwe registers no postcode element.
	// `STREET-ADDRESS` carries district level 2, `DISTRICT-1-LINE` level 1.
	ZW: addr`${attention}
${venue}
${numberFirstStreet}
${dependent_locality}
${locality}
${country}`,
}
