/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `gb-os-open`: Great Britain street addresses joined from three OS OpenData products, each under
 * the Open Government Licence v3.0.
 *
 * - **Code-Point Open** gives every unit postcode in England, Scotland and Wales a grid point.
 * - **OS Open Roads** gives each named road link a centreline and the roadNameTOID of its name.
 * - **OS Open Names** gives each roadNameTOID its `NAME1`, `POSTCODE_DISTRICT` and `POPULATED_PLACE`.
 *
 * Each postcode is joined to the nearest named road link within 100 m, measured point-to-segment in
 * EPSG:27700 meters. The street is the Open Names `NAME1` of that link's TOID, the locality is its
 * `POPULATED_PLACE`. A row carries no region, because the GB layout prints none. Every
 * component is OS data except `house_number`, which no open GB product publishes and which this
 * adapter **draws** from local bands seeded by the postcode and TOID, so each row carries a number the
 * source never stated.
 *
 * A postcode is dropped when:
 *
 * - its Code-Point coordinate has no position, `Positional_quality_indicator` 90;
 * - its coordinate is shared with another postcode, so the point does not locate this postcode's street;
 * - no named link lies within 100 m;
 * - the joined road's `POSTCODE_DISTRICT` differs from the postcode's own outward code.
 *
 * `inputPath` is a directory holding the three products unzipped, each in its own subdirectory:
 * `code-point-open/` (with `Data/CSV/*.csv`), `open-names/` (with `Data/*.csv`) and `open-roads/`
 * (with the `.gml` tiles anywhere beneath it). The Code-Point rows are held in memory, the road
 * tiles stream past them once, and Open Names is read once for the roadNameTOID values the join chose.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { titleCaseGB } from "@mailwoman/codex/gb/place-name"
import { outwardCode } from "@mailwoman/codex/gb/postcode"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { stringifyJSON } from "@mailwoman/core/json"
import { mulberry32 } from "@mailwoman/core/random"
import { createCodePointParseStats, PQI_NO_COORDINATE, readCodePointCSV } from "@mailwoman/spatial/gb/codepoint"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceIDFromParts } from "#adapters/source-id"
import { NearestLinkJoin } from "#gb/os-open/nearest-link"
import {
	createOpenNamesReadStats,
	type OpenNamesRoad,
	populatedPlaceName1,
	readOpenNamesRoads,
} from "#gb/os-open/open-names"
import { createOpenRoadsReadStats, readOpenRoadsLinks } from "#gb/os-open/open-roads"
import { SourceRegister } from "#registers"
import { tieredNumber, type TieredNumberBand } from "#synthesizers/utils"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const GB_OS_OPEN_ADAPTER_ID = "gb-os-open"

/**
 * The license on all three products, and on every row.
 */
export const GB_OS_OPEN_LICENSE = "OGL-UK-3.0"

/**
 * The jurisdictions the adapter emits.
 *
 * Code-Point Open covers Great Britain and carries no `BT` postcode.
 */
export const GB_OS_OPEN_COUNTRIES: readonly string[] = ["GB"]

/**
 * The farthest a road link may lie from a postcode's point and still name its street, in EPSG:27700 meters.
 */
export const GB_OS_OPEN_JOIN_RADIUS_M = 100

/**
 * The subdirectory of `inputPath` that holds each product.
 */
export const GB_OS_OPEN_PRODUCT_DIRECTORIES = {
	codePointOpen: "code-point-open",
	openNames: "open-names",
	openRoads: "open-roads",
} as const

/**
 * The bands the drawn house number comes from.
 *
 * Seven in ten draws fall in 1–60, a quarter in 61–200, and the rest in 201–400.
 */
export const GB_OS_OPEN_HOUSE_NUMBER_BANDS: readonly TieredNumberBand[] = [
	{ cutoff: 0.7, base: 1, span: 60 },
	{ cutoff: 0.95, base: 61, span: 140 },
	{ base: 201, span: 200 },
]

/**
 * What one run read, dropped and emitted.
 */
export interface GBOSOpenSummary {
	/**
	 * Code-Point rows read, including rows with no coordinate.
	 */
	codePointRows: number
	/**
	 * Code-Point rows that failed the parser's shape checks.
	 */
	codePointMalformed: number
	/**
	 * Rows per `Positional_quality_indicator` value, including 90.
	 */
	pqi: Record<string, number>
	/**
	 * Postcodes with a coordinate, the denominator of the join.
	 */
	postcodesWithCoordinate: number
	/**
	 * Postcodes with a named link within the radius, counted before any drop.
	 */
	joined: number
	dropped: {
		/**
		 * Positional quality 90: the row has no coordinate.
		 */
		noCoordinate: number
		/**
		 * The coordinate is shared with another postcode.
		 */
		sharedCoordinate: number
		/**
		 * No named link within the radius.
		 */
		noLinkWithinRadius: number
		/**
		 * The link's TOID has no road row in Open Names.
		 */
		noOpenNamesRow: number
		/**
		 * The road's `POSTCODE_DISTRICT` is not the postcode's outward code.
		 */
		districtMismatch: number
	}
	/**
	 * Rows emitted.
	 */
	emitted: number
	/**
	 * Emitted streets that OS wrote with no lowercase letter and that were title-cased.
	 */
	titleCasedStreets: number
	/**
	 * Emitted rows with no `POPULATED_PLACE`, so no locality.
	 */
	noLocality: number
	/**
	 * Emitted rows whose `POPULATED_PLACE` was bilingual, of which the first name was kept.
	 */
	bilingualLocality: number
	roads: ReturnType<typeof createOpenRoadsReadStats>
	names: ReturnType<typeof createOpenNamesReadStats>
}

/**
 * Construction options.
 */
export interface GBOSOpenAdapterOptions {
	/**
	 * Receives the run's counts once the rows are exhausted.
	 */
	onSummary?: (summary: GBOSOpenSummary) => void
}

/**
 * The three product directories under `inputPath`.
 *
 * @throws Naming the missing path, when a product's subdirectory is absent.
 */
export async function gbOSOpenProductPaths(
	inputPath: PathBuilderLike
): Promise<Record<keyof typeof GB_OS_OPEN_PRODUCT_DIRECTORIES, PathBuilder>> {
	const root = PathBuilder.from(inputPath)

	const paths = {
		codePointOpen: root(GB_OS_OPEN_PRODUCT_DIRECTORIES.codePointOpen),
		openNames: root(GB_OS_OPEN_PRODUCT_DIRECTORIES.openNames),
		openRoads: root(GB_OS_OPEN_PRODUCT_DIRECTORIES.openRoads),
	}

	for (const path of Object.values(paths)) {
		if (!(await pathExists(path))) {
			throw new Error(
				`${GB_OS_OPEN_ADAPTER_ID} adapter: ${path.toString()} is absent; inputPath must hold ${Object.values(GB_OS_OPEN_PRODUCT_DIRECTORIES).join("/, ")}/`
			)
		}
	}

	return paths
}

/**
 * The files matching `pattern` under `directory`, sorted so a run reads them in one order.
 *
 * @throws When none match, so a wrong layout reports itself rather than reading as an empty product.
 */
async function productFiles(directory: PathBuilder, pattern: string): Promise<string[]> {
	const names = await Globerator.from(pattern, { cwd: directory.toString(), absolute: false }).toSorted()

	if (!names.length) {
		throw new Error(`${GB_OS_OPEN_ADAPTER_ID} adapter: ${directory.toString()} holds no file matching ${pattern}`)
	}

	return names.map((name) => directory(name).toString())
}

/**
 * The house number drawn for one postcode and road, from {@linkcode GB_OS_OPEN_HOUSE_NUMBER_BANDS}.
 *
 * The seed is the row's source id, so a rerun draws the same number.
 */
export function drawGBHouseNumber(sourceID: string): string {
	const seed = Number.parseInt(sourceID.slice(-8), 16)

	return tieredNumber(mulberry32(seed), GB_OS_OPEN_HOUSE_NUMBER_BANDS)
}

/**
 * The street name as the row prints it.
 *
 * OS writes nearly every road name in mixed case.
 * A name with no lowercase letter is title-cased.
 */
function streetName(name1: string): { street: string; titleCased: boolean } {
	if (/\p{Ll}/u.test(name1)) return { street: name1, titleCased: false }

	return { street: titleCaseGB(name1), titleCased: true }
}

/**
 * A road link's identity, as the join keeps it.
 */
interface JoinedLink {
	roadNameTOID: string
}

/**
 * Creates the OS OpenData adapter.
 */
export function createGBOSOpenAdapter(options: GBOSOpenAdapterOptions = {}): CorpusAdapter {
	return {
		id: GB_OS_OPEN_ADAPTER_ID,
		defaultLicense: GB_OS_OPEN_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.OrdnanceSurveyOpenData,
		surface: SurfaceOrigin.Rendered,
		description:
			"OS OpenData (Code-Point Open, OS Open Roads, OS Open Names): GB postcodes joined to their nearest named road, with a drawn house number.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !GB_OS_OPEN_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(GB_OS_OPEN_ADAPTER_ID, GB_OS_OPEN_COUNTRIES, opts.country)
			}

			const paths = await gbOSOpenProductPaths(opts.inputPath)
			const codePointFiles = await productFiles(paths.codePointOpen, "Data/CSV/*.csv")
			const roadFiles = await productFiles(paths.openRoads, "**/*.gml")
			const nameFiles = await productFiles(paths.openNames, "Data/*.csv")

			const summary: GBOSOpenSummary = {
				codePointRows: 0,
				codePointMalformed: 0,
				pqi: {},
				postcodesWithCoordinate: 0,
				joined: 0,
				dropped: {
					noCoordinate: 0,
					sharedCoordinate: 0,
					noLinkWithinRadius: 0,
					noOpenNamesRow: 0,
					districtMismatch: 0,
				},
				emitted: 0,
				titleCasedStreets: 0,
				noLocality: 0,
				bilingualLocality: 0,
				roads: createOpenRoadsReadStats(),
				names: createOpenNamesReadStats(),
			}

			// Code-Point: every postcode with a coordinate, and how many postcodes share each coordinate.
			const codePointStats = createCodePointParseStats()
			const postcodes: string[] = []
			const xs: number[] = []
			const ys: number[] = []
			const pointCounts = new Map<string, number>()

			for (const file of codePointFiles) {
				for await (const record of readCodePointCSV(file, codePointStats)) {
					postcodes.push(record.postcode)
					xs.push(record.easting)
					ys.push(record.northing)

					const key = `${record.easting},${record.northing}`

					pointCounts.set(key, (pointCounts.get(key) ?? 0) + 1)
					summary.pqi[record.quality] = (summary.pqi[record.quality] ?? 0) + 1
				}
			}

			summary.codePointRows = codePointStats.read
			summary.codePointMalformed = codePointStats.skippedMalformed
			summary.dropped.noCoordinate = codePointStats.skippedNoCoordinate
			summary.postcodesWithCoordinate = postcodes.length

			if (codePointStats.skippedNoCoordinate > 0) {
				summary.pqi[PQI_NO_COORDINATE] = codePointStats.skippedNoCoordinate
			}

			// Open Roads: stream every named link past the postcodes once.
			const join = new NearestLinkJoin<JoinedLink>(
				{ xs: Float64Array.from(xs), ys: Float64Array.from(ys) },
				GB_OS_OPEN_JOIN_RADIUS_M
			)

			for (const file of roadFiles) {
				for await (const link of readOpenRoadsLinks(file, summary.roads, { signal: opts.signal })) {
					join.offer({ roadNameTOID: link.roadNameTOID }, link.vertices)
				}
			}

			const wanted = new Set<string>()

			for (let i = 0; i < postcodes.length; i++) {
				const match = join.match(i)

				if (!match) continue

				summary.joined++
				wanted.add(match.link.roadNameTOID)
			}

			// Open Names: only the roads the join chose.
			const roads = new Map<string, OpenNamesRoad>()

			for (const file of nameFiles) {
				for await (const road of readOpenNamesRoads(file, summary.names, wanted)) {
					roads.set(road.id, road)
				}
			}

			try {
				for (let i = 0; i < postcodes.length; i++) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && summary.emitted >= opts.limit) break

					const postcode = postcodes[i]!

					if ((pointCounts.get(`${xs[i]},${ys[i]}`) ?? 0) > 1) {
						summary.dropped.sharedCoordinate++

						continue
					}

					const match = join.match(i)

					if (!match) {
						summary.dropped.noLinkWithinRadius++

						continue
					}

					const road = roads.get(match.link.roadNameTOID)

					if (!road) {
						summary.dropped.noOpenNamesRow++

						continue
					}

					if (road.postcodeDistrict !== outwardCode(postcode)) {
						summary.dropped.districtMismatch++

						continue
					}

					const { street, titleCased } = streetName(road.name1)
					const locality = populatedPlaceName1(road.populatedPlace)

					const sourceID = stableSourceIDFromParts(GB_OS_OPEN_ADAPTER_ID, {
						postcode,
						roadNameTOID: road.id,
					})

					const components: CanonicalRow["components"] = {
						house_number: drawGBHouseNumber(sourceID),
						street,
					}

					if (locality) {
						components.locality = locality
					}

					components.postcode = postcode

					const rendered = formatAddressRow(components, "GB", { singleLine: true })

					if (!rendered) continue

					if (titleCased) {
						summary.titleCasedStreets++
					}

					if (!locality) {
						summary.noLocality++
					}

					if (road.populatedPlace.includes(" / ")) {
						summary.bilingualLocality++
					}

					yield {
						raw: rendered.raw,
						components: rendered.components,
						country: "GB",
						locale: "en-GB",
						source: GB_OS_OPEN_ADAPTER_ID,
						source_id: sourceID,
						corpus_version: "",
						license: GB_OS_OPEN_LICENSE,
					}

					summary.emitted++
				}
			} finally {
				options.onSummary?.(summary)

				process.stderr.write(
					`  ${GB_OS_OPEN_ADAPTER_ID}: ${summary.emitted} emitted of ${summary.codePointRows} Code-Point rows; ` +
						`dropped ${stringifyJSON(summary.dropped)}\n`
				)
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const gbOSOpenAdapter = createGBOSOpenAdapter()
