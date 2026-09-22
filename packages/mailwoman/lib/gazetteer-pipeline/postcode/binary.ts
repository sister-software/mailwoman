/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PCB1 postcode-binary derivation.
 *   Extracted from `mailwoman/commands/gazetteer/postcode-binary.tsx`
 *   so it can be tested without DB/terminal dependencies (#1509).
 *
 *   GB outward keys are derived by postcode shape (not by splitting on spaces),
 *   so both spaced and unspaced GB datasets work.
 *
 *   Empty or badly degraded builds are rejected by {@linkcode keyFloorViolation}.
 *
 *   GB output mirrors training lookup behavior: unit keys plus outward district
 *   means from placed unit centroids.
 */

import type { PostcodeBinaryEntry } from "@mailwoman/neural/postcode"

/**
 * GB unit postcode shape in stripped form (`SW1A2AA`).
 *
 * Keep this in sync with `anchor-lookup.ts` and `neural/anchor-inference.ts`.
 */
const GB_UNIT_KEY = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/

/**
 * GB inward code length (`\d[A-Z]{2}`); outward is everything before it.
 */
const GB_INWARD_LENGTH = 3

/**
 * GB key granularity.
 *
 * `unit` keeps full training-faithful keys.
 *
 * `outward` keeps district-only keys for smaller browser bundles.
 */
export type GBGranularity = "unit" | "outward"

/**
 * Per-country source config for postcode binary generation.
 */
export interface PostcodeBinarySource {
	/**
	 * ISO 3166-1 alpha-2 country code.
	 */
	country: string
	/**
	 * Database filename under `<data-root>/wof/`.
	 */
	database: string
	/**
	 * Browser bundle granularity when full keys are too large.
	 */
	browserGranularity?: GBGranularity
}

/**
 * Default per-country sources, in output order.
 */
export const POSTCODE_BINARY_SOURCES: readonly PostcodeBinarySource[] = [
	{ country: "US", database: "postalcode-us.db" },
	{ country: "NL", database: "postalcode-intl.db" },
	{ country: "FR", database: "postalcode-intl.db" },
	{ country: "DE", database: "postalcode-intl.db" },
	{ country: "ES", database: "postalcode-intl.db" },
	{ country: "IT", database: "postalcode-intl.db" },
	// For GB, browser bundles use outward keys only.
	{ country: "GB", database: "postalcode-gb-codepoint.db", browserGranularity: "outward" },
]

/**
 * Returns browser granularity for a country, if configured.
 */
export function browserGranularityFor(country: string): GBGranularity | undefined {
	return POSTCODE_BINARY_SOURCES.find((source) => source.country === country.toUpperCase())?.browserGranularity
}

/**
 * Raw postcode row from the source database.
 */
export interface PostcodeDatabaseRow {
	name: string
	lat: number
	lon: number
}

export interface BuildPostcodeBinaryOptions {
	/**
	 * GB key granularity (default: `unit`; ignored for non-GB).
	 */
	gbGranularity?: GBGranularity
}

export interface BuildPostcodeBinaryResult {
	entries: PostcodeBinaryEntry[]
	/**
	 * Rows skipped for invalid key shape (currently GB only).
	 */
	skipped: number
	/**
	 * Number of GB outward districts included (0 for non-GB).
	 */
	outwardKeys: number
}

/**
 * Normalizes a database `name` into the binary key.
 *
 * GB strips spaces.
 * Every other country is uppercased as-is.
 */
export function postcodeBinaryKey(country: string, name: string): string {
	const upper = (name || "").trim().toUpperCase()

	return country.toUpperCase() === "GB" ? upper.replaceAll(" ", "") : upper
}

/**
 * Returns GB outward district from a unit postcode key.
 *
 * Accepts spaced or unspaced forms.
 * Anything outside the GB unit shape returns `null`.
 */
export function gbOutwardFromKey(name: string): string | null {
	const key = postcodeBinaryKey("GB", name)

	if (!GB_UNIT_KEY.test(key)) return null

	return key.slice(0, -GB_INWARD_LENGTH)
}

/**
 * True when coordinates are a real placement (not the `(0, 0)` placeholder).
 */
function isPlaced(lat: number, lon: number): boolean {
	return lat !== 0 || lon !== 0
}

/**
 * Builds PCB1 entries for one country from database rows.
 *
 * GB supports `unit` and `outward`; others serialize directly.
 */
export function buildPostcodeBinaryEntries(
	country: string,
	rows: readonly PostcodeDatabaseRow[],
	options: BuildPostcodeBinaryOptions = {}
): BuildPostcodeBinaryResult {
	const cc = country.toUpperCase()

	if (cc !== "GB") {
		return {
			entries: rows.map((row) => ({
				postcode: postcodeBinaryKey(cc, row.name),
				country: cc,
				lat: Number(row.lat),
				lon: Number(row.lon),
			})),
			skipped: 0,
			outwardKeys: 0,
		}
	}

	const granularity = options.gbGranularity ?? "unit"
	const entries: PostcodeBinaryEntry[] = []
	const outward = new Map<string, { lat: number; lon: number; n: number }>()
	let skipped = 0

	for (const row of rows) {
		const key = postcodeBinaryKey(cc, row.name)
		const district = gbOutwardFromKey(key)

		if (district === null) {
			skipped++

			continue
		}

		const lat = Number(row.lat)
		const lon = Number(row.lon)

		if (granularity === "unit") {
			entries.push({ postcode: key, country: "GB", lat, lon })
		}

		if (!isPlaced(lat, lon)) continue
		const bucket = outward.get(district)

		if (bucket) {
			bucket.lat += lat
			bucket.lon += lon

			bucket.n++
		} else {
			outward.set(district, { lat, lon, n: 1 })
		}
	}

	for (const [district, { lat, lon, n }] of outward) {
		entries.push({ postcode: district, country: "GB", lat: lat / n, lon: lon / n })
	}

	return { entries, skipped, outwardKeys: outward.size }
}

/**
 * Per-country key floors used to detect collapsed builds (#1509).
 *
 * A floor is a coarse threshold: it states the count the build must clear, and any larger count passes.
 * Unknown countries default to a floor of 1 (see {@linkcode keyFloorFor}).
 */
export const POSTCODE_BINARY_KEY_FLOORS: Readonly<Record<string, number>> = {
	US: 20_000,
	NL: 100_000,
	FR: 13_000,
	DE: 14_000,
	ES: 5000,
	IT: 2000,
	GB: 800_000,
	"GB:outward": 1000,
}

/**
 * Returns the required key floor for a `(country, granularity)` build.
 */
export function keyFloorFor(country: string, granularity: GBGranularity): number {
	const cc = country.toUpperCase()
	const keyed = cc === "GB" && granularity === "outward" ? "GB:outward" : cc

	return POSTCODE_BINARY_KEY_FLOORS[keyed] ?? 1
}

/**
 * Returns a refusal message when build keys are below the floor, else `null`.
 */
export function keyFloorViolation(country: string, keys: number, granularity: GBGranularity): string | null {
	const floor = keyFloorFor(country, granularity)

	if (keys >= floor) return null
	const cc = country.toUpperCase()
	const scope = cc === "GB" ? `${cc} (${granularity} granularity)` : cc

	return (
		`refusing to write the ${scope} postcode binary: the build produced ${keys.toLocaleString()} keys, ` +
		`below the floor of ${floor.toLocaleString()}. An empty or collapsed binary is a build failure, not a ` +
		`product — it feeds the anchor channel nothing while reporting success (#1509/#1467). Check that the ` +
		`database's \`name\` column carries the key shape this country's derivation expects, and that the ` +
		`\`country\` filter selects rows at all.`
	)
}
