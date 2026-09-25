/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads populated places from a GeoNames country dump and emits locality rows.
 *
 *   Region and country names come from `admin1CodesASCII.txt` and `countryInfo.txt` in the same directory. When a
 *   file is missing, rows omit that component.
 */

import { componentsPresentIn } from "@mailwoman/codex/address-format"
import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"
import { pathExists } from "@mailwoman/core/fs/readers"
import { PathBuilder } from "path-ts"

import { stableSourceID } from "#adapters/utils"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * The source ID on rows from this adapter.
 */
export const GEONAMES_ADAPTER_ID = "geonames"
/**
 * The license on rows from this adapter.
 */
export const GEONAMES_DEFAULT_LICENSE = "CC-BY-4.0"

/**
 * Zero-based column indices in a GeoNames main-table dump.
 */
export const GEONAMES_MAIN_COLUMNS = {
	geonameid: 0,
	name: 1,
	asciiname: 2,
	alternatenames: 3,
	latitude: 4,
	longitude: 5,
	featureClass: 6,
	featureCode: 7,
	country: 8,
	admin1: 10,
	population: 14,
} as const

const COL = GEONAMES_MAIN_COLUMNS

/**
 * Feature codes for historical, abandoned or destroyed populated places, which the adapter skips.
 */
const NON_CURRENT_PPL = new Set(["PPLH", "PPLQ", "PPLW", "PPLCH"])

/**
 * Loads region names keyed by `<CC>.<admin1>`.
 * Returns an empty map when the file is missing.
 */
async function loadAdmin1(dir: PathBuilder): Promise<Map<string, string>> {
	const map = new Map<string, string>()
	const fp = dir("admin1CodesASCII.txt")

	if (!(await pathExists(fp))) return map

	for await (const cols of readUnquotedTSV(fp)) {
		if (cols[0] && cols[1]) {
			map.set(cols[0], cols[1])
		}
	}

	return map
}

/**
 * Loads country names keyed by ISO code.
 * Returns an empty map when the file is missing.
 */
async function loadCountries(dir: PathBuilder): Promise<Map<string, string>> {
	const map = new Map<string, string>()
	const fp = dir("countryInfo.txt")

	if (!(await pathExists(fp))) return map

	for await (const cols of readUnquotedTSV(fp)) {
		if (cols[0]?.startsWith("#")) continue

		// Column 0 holds the ISO code and column 4 the country name.
		if (cols[0] && cols[4]) {
			map.set(cols[0], cols[4])
		}
	}

	return map
}

/**
 * Creates the GeoNames populated-place adapter.
 */
export function createGeonamesAdapter(): CorpusAdapter {
	return {
		id: GEONAMES_ADAPTER_ID,
		defaultLicense: GEONAMES_DEFAULT_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.GeoNames,
		surface: SurfaceOrigin.Attested,
		description:
			"GeoNames populated places (CC-BY-4.0) — global locality coverage incl. small towns, with region/country names from the sibling admin1/countryInfo files.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			const dir = PathBuilder.from(opts.inputPath).dirname()
			const admin1 = await loadAdmin1(dir)
			const countries = await loadCountries(dir)

			const rows = readUnquotedTSV(opts.inputPath)

			let emitted = 0

			for await (const rec of rows) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				if (rec[COL.featureClass] !== "P") continue

				if (NON_CURRENT_PPL.has(rec[COL.featureCode] ?? "")) continue

				const cc = (rec[COL.country] ?? "").trim()

				if (!cc) continue

				if (opts.country && cc !== opts.country) continue

				const locality = (rec[COL.name] ?? "").trim()

				if (!locality) continue
				const geonameid = (rec[COL.geonameid] ?? "").trim()
				const region = admin1.get(`${cc}.${(rec[COL.admin1] ?? "").trim()}`)
				const country = countries.get(cc)

				// With a region, the adapter emits locality-region and locality-region-country rows.
				// Without one, it emits a single row with the country when known.
				const variants: Array<{ slot: string; comp: CanonicalRow["components"]; raw: string }> = []

				if (region) {
					variants.push({ slot: "lr", comp: { locality, region }, raw: `${locality}, ${region}` })

					if (country) {
						variants.push({
							slot: "lrc",
							comp: { locality, region, country },
							raw: `${locality}, ${region}, ${country}`,
						})
					}
				} else if (country) {
					variants.push({ slot: "lc", comp: { locality, country }, raw: `${locality}, ${country}` })
				} else {
					variants.push({ slot: "l", comp: { locality }, raw: locality })
				}

				for (const v of variants) {
					if (opts.limit !== undefined && emitted >= opts.limit) break
					const aligned = componentsPresentIn(v.comp, v.raw)

					if (!Object.keys(aligned).length) continue

					const sourceID = geonameid
						? `${GEONAMES_ADAPTER_ID}-${geonameid}-${v.slot}`
						: stableSourceID(GEONAMES_ADAPTER_ID, aligned)

					yield {
						raw: v.raw,
						components: aligned,
						country: cc,
						source: GEONAMES_ADAPTER_ID,
						source_id: sourceID,
						corpus_version: "",
						license: GEONAMES_DEFAULT_LICENSE,
					}

					emitted++
				}
			}
		},
	}
}

/**
 * The adapter instance registered with the corpus builder.
 */
export const geonamesAdapter = createGeonamesAdapter()
