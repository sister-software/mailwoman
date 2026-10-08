/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The London records against the host's data root. The flood suite reads `flood.db` and skips when the
 *   database is absent. The BDUK suite reads the London archive, its extracted files and `nsul.db`, and it
 *   skips when any of them is absent. `downloadBDUKRegion` from `@mailwoman/bduk/sdk/download` stores the
 *   archive and the extracted files.
 */

import { BDUK_EXTRACTED_DIRECTORY, type BDUKRow, bdukReleasePath, readBDUKReleaseDirectory } from "@mailwoman/bduk"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { sha256File } from "@mailwoman/core/hash"
import { FloodZoneLookup } from "@mailwoman/flood"
import { floodLayerReading } from "@mailwoman/flood/layer-readings"
import { floodDatabasePath } from "@mailwoman/flood/paths"
import { NSULLookup } from "@mailwoman/resolver-wof-sqlite/nsul/lookup"
import { nsulDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { haversineKm } from "@mailwoman/spatial/distance"
import { describe, expect, test } from "vitest"

import {
	BDUK_LONDON_ARCHIVE,
	BDUK_SITE_RADIUS_METERS,
	type BDUKPostcodeCounts,
	FLOOD_LAYER,
	FLOOD_MAP,
	FLOOD_VINTAGE,
	LONDON_RECORDS,
	LONDON_SITES,
	type LondonSite,
	siteFloodRecords,
	sitePosition,
} from "#london-three-buildings"

const DATABASE = floodDatabasePath("flood.db")

describe.skipIf(!(await pathExists(DATABASE)))("the London flood records against flood.db", () => {
	test("the flood map's source record takes its layer and dates from the database manifest", () => {
		using lookup = new FloodZoneLookup({ databasePath: DATABASE })

		const { manifest } = lookup.identity

		expect([manifest.name, manifest.sourceVintage]).toEqual([FLOOD_LAYER, FLOOD_VINTAGE])

		expect(LONDON_RECORDS.sources.find((source) => source.id === FLOOD_MAP)).toMatchObject({
			observedAt: manifest.sourceVintage,
			availableAt: manifest.sourceVintage,
			retrievedAt: manifest.createdAt,
		})
	})

	test("floodLayerReading at each building's position returns the reading and claim the fixture stores", () => {
		using lookup = new FloodZoneLookup({ databasePath: DATABASE })

		for (const site of LONDON_SITES) {
			const { latitude, longitude } = sitePosition(site)

			expect(floodLayerReading(lookup, { subject: site.building, latitude, longitude, source: FLOOD_MAP })).toEqual(
				siteFloodRecords(site)
			)
		}
	})
})

const BDUK_REGION = bdukReleasePath(BDUK_LONDON_ARCHIVE.release, BDUK_LONDON_ARCHIVE.region)
const BDUK_ARCHIVE = BDUK_REGION(BDUK_LONDON_ARCHIVE.file)
const BDUK_FILES = BDUK_REGION(BDUK_EXTRACTED_DIRECTORY)
const NSUL_DATABASE = nsulDatabasePath("nsul.db")

const BDUK_INPUTS_PRESENT =
	(await pathExists(BDUK_ARCHIVE)) && (await pathExists(BDUK_FILES)) && (await pathExists(NSUL_DATABASE))

type BDUKCountedRow = BDUKRow<"postcode" | "subsidy_control_status" | "current_gigabit" | "bduk_recognised_premises">

/**
 * BDUK's counts for one postcode, recomputed: the listed rows, those whose NSUL point
 * lies within the radius of the building's position, and four counts over those.
 *
 * Every listed UPRN must have an NSUL point under the same postcode.
 * A UPRN without one would have no distance, so the test names it rather than
 * counting it on either side of the radius.
 */
function recount(
	site: LondonSite,
	postcode: string,
	rows: readonly BDUKCountedRow[],
	nsul: NSULLookup
): BDUKPostcodeCounts {
	const { latitude, longitude } = sitePosition(site)
	const points = new Map(nsul.uprnsForPostcode(postcode).map((point) => [point.uprn, point]))
	const listed = rows.filter((row) => row.values.postcode === postcode)

	expect(
		listed.filter((row) => !points.has(row.uprn)).map((row) => row.uprn),
		`UPRNs listed with ${postcode} that NSUL places under no point of that postcode`
	).toEqual([])

	const within = listed.filter((row) => {
		const point = points.get(row.uprn)!

		return haversineKm(latitude, longitude, point.latitude, point.longitude) * 1000 <= BDUK_SITE_RADIUS_METERS
	})

	const count = (predicate: (row: BDUKCountedRow) => boolean) => within.filter(predicate).length

	return {
		postcode,
		listed: listed.length,
		within50m: within.length,
		currentGigabit: count((row) => row.values.current_gigabit === true),
		white: count((row) => row.values.subsidy_control_status === "Gigabit White"),
		underReview: count((row) => row.values.subsidy_control_status === "Gigabit Under Review"),
		recognized: count((row) => row.values.bduk_recognised_premises === true),
	}
}

describe.skipIf(!BDUK_INPUTS_PRESENT)("the London BDUK counts against the extracted London files and nsul.db", () => {
	test("the archive on disk is the one the BDUK record cites", async () => {
		expect(await sha256File(BDUK_ARCHIVE)).toBe(BDUK_LONDON_ARCHIVE.sha256)
	})

	test("each building postcode's counts recompute from every London file and NSUL's points", async () => {
		const region = await readBDUKReleaseDirectory(
			BDUK_FILES,
			["postcode", "subsidy_control_status", "current_gigabit", "bduk_recognised_premises"],
			{ postcodes: LONDON_SITES.flatMap((site) => site.bduk.map((entry) => entry.postcode)) }
		)

		expect([region.release, region.files.length, region.rowCount]).toEqual([BDUK_LONDON_ARCHIVE.release, 33, 4_478_945])

		using nsul = new NSULLookup({ databasePath: NSUL_DATABASE })

		for (const site of LONDON_SITES) {
			expect(site.bduk.map(({ postcode }) => recount(site, postcode, region.rows, nsul))).toEqual(site.bduk)
		}
	}, 300_000)
})
