/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `geonames`: GeoNames populated-places consumer (https://www.geonames.org/, CC-BY-4.0).
 *
 *   GeoNames is a global gazetteer of ~12M features. This adapter ingests the POPULATED PLACES
 *   (`feature_class = "P"`, excluding historical/abandoned/destroyed variants) from a per-country
 *   dump file — global locality coverage, including the small towns and villages a coarser admin
 *   gazetteer (WOF) lacks. It's the cheapest path to broadening the corpus's LOCALE coverage.
 *
 *   Input: a per-country tab-separated dump (e.g. `US.txt` from
 *   `https://download.geonames.org/export/dump/`, 19 columns, no header). Two sibling files in the
 *   same directory supply human-readable names (downloaded once from the same place):
 *     - `admin1CodesASCII.txt` — `<CC>.<admin1_code>` → region name (e.g. `US.VT` → "Vermont").
 *     - `countryInfo.txt`       — ISO alpha-2 → country name (e.g. `US` → "United States"); `#`-commented.
 *   If a sibling is missing, the corresponding component is simply omitted (graceful degradation).
 *
 *   Output: per place, up to two hierarchy variants (mirroring `wof-admin`'s with/without-country
 *   balance so the model sees both domestic and international order) —
 *     1. `{ locality, region }`              → "City, Region"
 *     2. `{ locality, region, country }`     → "City, Region, Country"
 *   `reconcileComponents` drops any component that didn't survive into the rendered `raw`.
 *
 *   License: stamped `"CC-BY-4.0"` per row (GeoNames' terms); provenance is the `geonames-<id>` key.
 */

import { parse as csvParse } from "csv-parse"
import { createReadStream, existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { stableSourceId } from "../../adapter.js"
import { reconcileComponents } from "../../format.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.js"

export const GEONAMES_ADAPTER_ID = "geonames"
export const GEONAMES_DEFAULT_LICENSE = "CC-BY-4.0"

// GeoNames main-table column indices (0-based; see the export README).
const COL = { geonameid: 0, name: 1, alternatenames: 3, featureClass: 6, featureCode: 7, country: 8, admin1: 10 } as const

// Populated-place feature codes that are NOT current real places — skip them.
const NON_CURRENT_PPL = new Set(["PPLH", "PPLQ", "PPLW", "PPLCH"])

/** Load `admin1CodesASCII.txt` → Map("<CC>.<admin1>" → region name). Empty map if absent. */
function loadAdmin1(dir: string): Map<string, string> {
	const map = new Map<string, string>()
	const fp = join(dir, "admin1CodesASCII.txt")
	if (!existsSync(fp)) return map
	for (const line of readFileSync(fp, "utf8").split("\n")) {
		if (!line) continue
		const cols = line.split("\t")
		if (cols[0] && cols[1]) map.set(cols[0], cols[1])
	}
	return map
}

/** Load `countryInfo.txt` → Map(ISO → country name). Empty map if absent. The file is `#`-commented. */
function loadCountries(dir: string): Map<string, string> {
	const map = new Map<string, string>()
	const fp = join(dir, "countryInfo.txt")
	if (!existsSync(fp)) return map
	for (const line of readFileSync(fp, "utf8").split("\n")) {
		if (!line || line.startsWith("#")) continue
		const cols = line.split("\t")
		// ISO(0), ISO3(1), iso-numeric(2), fips(3), Country(4), ...
		if (cols[0] && cols[4]) map.set(cols[0], cols[4])
	}
	return map
}

export function createGeonamesAdapter(): CorpusAdapter {
	return {
		id: GEONAMES_ADAPTER_ID,
		defaultLicense: GEONAMES_DEFAULT_LICENSE,
		description:
			"GeoNames populated places (CC-BY-4.0) — global locality coverage incl. small towns, with region/country names from the sibling admin1/countryInfo files.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			const dir = dirname(opts.inputPath)
			const admin1 = loadAdmin1(dir)
			const countries = loadCountries(dir)

			const stream = createReadStream(opts.inputPath, { encoding: "utf8" })
			const parser = stream.pipe(
				csvParse({ delimiter: "\t", quote: false, relax_column_count: true, skip_empty_lines: true })
			)

			let emitted = 0
			try {
				for await (const rec of parser as AsyncIterable<string[]>) {
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

					// Two hierarchy variants (domestic + international order) — but only emit the
					// distinct ones the available names support.
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
						const aligned = reconcileComponents(v.comp, v.raw)
						if (Object.keys(aligned).length === 0) continue
						const sourceId = geonameid
							? `${GEONAMES_ADAPTER_ID}-${geonameid}-${v.slot}`
							: stableSourceId(GEONAMES_ADAPTER_ID, aligned)
						yield {
							raw: v.raw,
							components: aligned,
							country: cc,
							source: GEONAMES_ADAPTER_ID,
							source_id: sourceId,
							corpus_version: "",
							license: GEONAMES_DEFAULT_LICENSE,
						}
						emitted++
					}
				}
			} finally {
				stream.destroy()
			}
		},
	}
}

export const geonamesAdapter = createGeonamesAdapter()
