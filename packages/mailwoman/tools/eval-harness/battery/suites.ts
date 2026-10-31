/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The comparison battery scores frozen suites. Some rows measure our labeling rather than a model, and some expected
 *   answers are corrected before scoring.
 *
 *   Each suite is a dataset manifest beside its rows file in {@linkcode batterySuiteDirectory}. A row is "label
 *   convention" when the expected labels follow a choice of ours that a writer of the address would not make, so a
 *   the model's score measures how well it learned that choice. The report groups those rows and excludes them from the
 *   decision totals.
 *
 *   The five `osm-` suites are read at `v2`: `v1`'s rows with Hong Kong and Macau re-rendered by `formatAddressRow` at
 *   47ebdd8e1. That renderer prints a value pairing a Chinese name with its English or Portuguese name in the Latin
 *   order (`15 明安街 Ming On Street, Hung Hom, Kowloon` where `v1` had `Hong KongKowloonHung Hom明安街 Ming On Street15`).
 */

import { dataRootPath } from "@mailwoman/core/data-root"

import type { BatterySpan } from "#tools/eval-harness/battery/classify"

/**
 * Where the frozen suites' manifests and rows files sit:
 * `$MAILWOMAN_DATA_ROOT/corpus/heldout/osm-suites`, read when the path is requested.
 */
export function batterySuiteDirectory() {
	return dataRootPath("corpus", "heldout", "osm-suites")
}

/**
 * One suite row, in the corpus parquet schema.
 */
export interface BatterySuiteRow {
	source_id: string
	raw: string
	country: string
	span_starts: number[]
	span_ends: number[]
	span_tags: string[]
}

/**
 * One frozen suite and the rule that marks its label-convention rows.
 */
export interface BatterySuiteSpec {
	id: string
	describes: string
	/**
	 * Which rows file the battery reads, `<id>-<rows>.rows.jsonl`.
	 */
	rows: "v1" | "v2"
	/**
	 * The label-convention group a row falls in, or `null` for a decision row.
	 */
	labelConvention: (row: BatterySuiteRow) => string | null
}

/**
 * The label-convention groups a suite rule can name, each with the reason its rows follow our labeling.
 */
export const LABEL_CONVENTION_GROUPS: Readonly<Record<string, string>> = {
	"bare-unit": "OSM's bare addr:unit renders with no designator (`107 Dela Rosa Street 9, Makati`)",
	"place-without-locality":
		"with no locality in the row, the OSM adapter's dependent_locality for the place (`33, Los Pinos`) is our convention; locality reads it as well",
	"au-metro-city": "Photon's Australian `city` is the metro area, so the suburb is labeled dependent_locality",
	"au-postal-locality": "Photon's Australian place is the postal locality, labeled dependent_locality",
}

const decisionRow = () => null

/**
 * The ten frozen suites, five built from the OSM corpus extracts and five from the Photon planet index.
 *
 * The five `osm-` suites are built by `osm-suites/build.run.ts`, and each row was
 * checked absent from both training corpora's OSM files by id and group through
 * the overlap audit in `heldout/dataset/overlap.ts`.
 * That audit compares no text, so a training row holding the same address under another id is not detected.
 *
 * The five `photon-` suites were sampled by a script that was not committed.
 * Each frozen manifest's `sampling.order` and `drawnFrom` record the rule and the inputs:
 * rows ordered by a SHA-256 of the suite name, the OSM id and the house number, and rows whose
 * house number and postcode match a training row containing the street's longest word left out.
 *
 * A Photon suite can therefore be read and scored, and cannot be rebuilt.
 */
export const BATTERY_SUITES: readonly BatterySuiteSpec[] = [
	{
		id: "osm-units",
		describes: "OSM rows with addr:unit, 57 countries",
		rows: "v2",
		labelConvention: () => "bare-unit",
	},
	{
		id: "osm-district-before-city",
		describes: "a dependent locality before the locality, 48 countries",
		rows: "v2",
		labelConvention: decisionRow,
	},
	{
		id: "osm-region-after-locality",
		describes: "a region after the locality, 16 countries",
		rows: "v2",
		labelConvention: decisionRow,
	},
	{
		id: "osm-place-without-street",
		describes: "a house number in a named place with no street, 56 countries",
		rows: "v2",
		labelConvention: (row) =>
			row.span_tags.includes("dependent_locality") && !row.span_tags.includes("locality")
				? "place-without-locality"
				: null,
	},
	{
		id: "osm-venue-with-address",
		describes: "a named OSM POI with its address, 84 countries",
		rows: "v2",
		labelConvention: decisionRow,
	},
	{
		id: "photon-plain-address",
		describes: "number, street, locality, postcode in NO, DE, US, AU",
		rows: "v1",
		labelConvention: decisionRow,
	},
	{
		id: "photon-district-before-city",
		describes: "a district before the city in NO, DE, AU",
		rows: "v1",
		// country-branch: Photon's AU `city` is the metro area, until a Photon field map exists.
		labelConvention: (row) => (row.country === "AU" ? "au-metro-city" : null),
	},
	{
		id: "photon-region-after-locality",
		describes: "a state after the locality in US, AU",
		rows: "v1",
		labelConvention: decisionRow,
	},
	{
		id: "photon-place-without-street",
		describes: "a house number in a named place with no street in DE, AU",
		rows: "v1",
		// country-branch: Photon's AU place is the postal locality, until a Photon field map exists.
		labelConvention: (row) => (row.country === "AU" ? "au-postal-locality" : null),
	},
	{
		id: "photon-venue-with-address",
		describes: "a named POI with its address in NO, DE, US, AU",
		rows: "v1",
		labelConvention: decisionRow,
	},
]

/**
 * Corrections applied to the expected and predicted field maps before they are compared,
 * each for an expected answer that depends on a rendering choice the text does not show.
 */
export const CORRECTION_GROUPS: Readonly<Record<string, string>> = {
	"postcode-country-prefix":
		"a postcode written with the country's code (`MD-5938`, `HT4310`): the label takes the prefix in, a reading of `5938` is equally the code; both sides compare with the prefix removed",
	"region-country-same-name":
		"a trailing name that is both the region and the country (`…, San Miguelito, Panamá`): region and country readings of it are equal",
	"layout-country-code":
		"the layout prints the country code as a literal outside every expected span (`San Juan PR 00912`): a region or country reading of that literal is dropped",
}

/**
 * Applies {@linkcode CORRECTION_GROUPS} to one row, editing both maps in place,
 * and returns the groups that changed either map.
 */
export function correctBatteryFields(
	row: Pick<BatterySuiteRow, "country" | "span_starts" | "span_ends">,
	expected: Map<string, string>,
	got: Map<string, string>,
	spans: readonly BatterySpan[]
): string[] {
	const applied: string[] = []
	const cc = row.country.toLowerCase()
	const prefix = new RegExp(`^${cc}[-\\s]?(?=\\d)`, "u")

	for (const map of [expected, got]) {
		const postcode = map.get("postcode")

		if (postcode && prefix.test(postcode)) {
			map.set("postcode", postcode.replace(prefix, ""))

			if (!applied.includes("postcode-country-prefix")) {
				applied.push("postcode-country-prefix")
			}
		}
	}

	for (const [labeled, read] of [
		["region", "country"],
		["country", "region"],
	] as const) {
		const value = expected.get(labeled)

		if (value && !got.has(labeled) && got.get(read) === value) {
			got.delete(read)
			got.set(labeled, value)
			applied.push("region-country-same-name")
		}
	}

	const covered = (start: number, end: number) => row.span_starts.some((s, i) => s < end && row.span_ends[i]! > start)

	for (const [tag, start, end, value] of spans) {
		if ((tag !== "region" && tag !== "country") || expected.has(tag) || covered(start, end)) continue

		if (value.trim().toLowerCase() !== cc || got.get(tag) !== cc) continue

		got.delete(tag)
		applied.push("layout-country-code")
	}

	return applied
}
