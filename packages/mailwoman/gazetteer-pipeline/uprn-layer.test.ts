/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Open UPRN builder's contract: the line parser's input-tail behavior (truncated fields,
 *   `Number("")`-shaped traps), the versions.txt parse, and a full fixture build through
 *   `buildUPRNLayer` — DDL, gates, coverage, manifest, seal — verified by reading the sealed
 *   artifact back through the production reader.
 */

import { statSync } from "node:fs"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { CoverageBasis, readLayerCoverage, readLayerManifest, type LayerContractDatabase } from "@mailwoman/core/layers"
import { UPRNLookup } from "@mailwoman/resolver-wof-sqlite/uprn-lookup"
import { UPRN_COVERAGE_H3_RESOLUTION, uprnFullCell } from "@mailwoman/resolver-wof-sqlite/uprn-schema"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { cellToParent } from "h3-js"
import { describe, expect, it } from "vitest"

import {
	buildUPRNLayer,
	OPEN_UPRN_HEADER,
	parseOpenUPRNLine,
	parseOpenUPRNVersions,
	type ExtractOpenUPRNResult,
} from "./uprn-layer.ts"

describe("parseOpenUPRNLine", () => {
	it("parses a source line, taking the WGS84 columns", () => {
		expect(parseOpenUPRNLine("1,358260.99,172796.83,51.4526038,-2.6020703")).toEqual({
			uprn: 1,
			latitude: 51.4526038,
			longitude: -2.6020703,
		})
	})

	it("strips the CRLF terminator the wild file carries", () => {
		expect(parseOpenUPRNLine("26,352967.00,181077.00,51.5266333,-2.6793612\r")).toEqual({
			uprn: 26,
			latitude: 51.5266333,
			longitude: -2.6793612,
		})
	})

	it("rejects a wrong field count", () => {
		expect(parseOpenUPRNLine("1,2,3,51.5")).toBeNull()
		expect(parseOpenUPRNLine("1,2,3,51.5,-2.6,extra")).toBeNull()
	})

	it("rejects a non-literal UPRN", () => {
		expect(parseOpenUPRNLine("1e3,2,3,51.5,-2.6")).toBeNull()
		expect(parseOpenUPRNLine("abc,2,3,51.5,-2.6")).toBeNull()
		expect(parseOpenUPRNLine("-1,2,3,51.5,-2.6")).toBeNull()
	})

	it("rejects a truncated coordinate — Number('') is 0, not a longitude", () => {
		expect(parseOpenUPRNLine("1,2,3,51.5,")).toBeNull()
		expect(parseOpenUPRNLine("1,2,3,,-2.6")).toBeNull()
	})

	it("rejects out-of-range coordinates", () => {
		expect(parseOpenUPRNLine("1,2,3,91.0,-2.6")).toBeNull()
		expect(parseOpenUPRNLine("1,2,3,51.5,-181.0")).toBeNull()
	})
})

describe("parseOpenUPRNVersions", () => {
	it("reads the three label lines of the wild versions.txt", () => {
		const text = "Product Name: osopenuprn\nFile Name: osopenuprn_202608\nData Extraction Date: 03-07-2026"

		expect(parseOpenUPRNVersions(text)).toEqual({
			productName: "osopenuprn",
			fileName: "osopenuprn_202608",
			extractionDate: "03-07-2026",
		})
	})
})

const FIXTURE_LICENSE =
	"ORDNANCE SURVEY DATA LICENCE\n\nYour use of OS OpenData is subject to the terms at http://os.uk/opendata/licence." +
	"\n\nContains Ordnance Survey data © Crown copyright and database right 2026."

const FIXTURE_VERSIONS = {
	productName: "osopenuprn",
	fileName: "osopenuprn_fixture",
	extractionDate: "03-07-2026",
}

const FIXTURE_POINTS = [
	{ uprn: 1, lat: 51.4526038, lon: -2.6020703 },
	{ uprn: 26, lat: 51.5266333, lon: -2.6793612 },
	{ uprn: 906_700_601_612, lat: 55.8823426, lon: -4.2786558 },
]

/**
 * U+FEFF, by char code so no invisible character hides in this source file.
 */
const BOM = String.fromCharCode(0xfe_ff)

/**
 * A fixture CSV in the wild file's exact shape: BOM-prefixed header, CRLF terminators.
 */
function fixtureCSV(headerLine: string = OPEN_UPRN_HEADER): string {
	const rows = FIXTURE_POINTS.map((p) => `${p.uprn},0.0,0.0,${p.lat},${p.lon}`)

	return `${BOM}${[headerLine, ...rows].join("\r\n")}\r\n`
}

async function writeFixtureSource(
	headerLine?: string
): Promise<{ sourceDir: string; extracted: ExtractOpenUPRNResult }> {
	const sourceDir = await mkdtemp(join(tmpdir(), "uprn-build-"))
	const csvPath = join(sourceDir, "osopenuprn_fixture.csv")
	const csv = fixtureCSV(headerLine)

	await writeFile(csvPath, csv, "utf8")

	return {
		sourceDir,
		extracted: {
			csvPath,
			csvBytes: Buffer.byteLength(csv),
			licenseText: FIXTURE_LICENSE,
			versions: FIXTURE_VERSIONS,
		},
	}
}

describe("buildUPRNLayer (fixture)", () => {
	it("builds a sealed layer the production reader answers from", async () => {
		const { sourceDir, extracted } = await writeFixtureSource()
		const out = join(sourceDir, "uprn.db")

		const result = await buildUPRNLayer({
			sourceDir,
			out,
			extracted,
			buildSHA: "fixture",
			minimumPlausibleRows: FIXTURE_POINTS.length,
			now: new Date("2026-08-18T00:00:00.000Z"),
		})

		expect(result.read).toBe(FIXTURE_POINTS.length)
		expect(result.inserted).toBe(FIXTURE_POINTS.length)
		expect(result.skippedMalformed).toBe(0)
		expect(result.skippedDuplicate).toBe(0)
		expect(result.mismatches).toEqual([])
		expect(result.sealed).toBe(true)

		// Sealed 0444 — no write bits.
		expect(statSync(out).mode & 0o222).toBe(0)

		using lookup = new UPRNLookup({ databasePath: out })

		expect(lookup.coordinateOf(906_700_601_612)).toEqual({ latitude: 55.8823426, longitude: -4.2786558 })
		expect(lookup.nearestUPRN(51.4526, -2.602, 100)?.uprn).toBe(1)

		const kdb = new DatabaseClient<LayerContractDatabase>({
			database: new DatabaseSync(out, { readOnly: true }),
		})

		const manifest = await readLayerManifest(kdb)

		expect(manifest.name).toBe("os-open-uprn")
		expect(manifest.license).toBe("OGL-UK-3.0")
		expect(manifest.attribution).toContain("© Crown copyright and database right 2026")
		expect(manifest.spineKeys.h3).toEqual({ column: "h3_cell", resolution: 9 })

		// Coverage: the res-6 parent of a fixture point is designated-complete; an unsurveyed cell is UNKNOWN.
		const parent = shortCellToInt(
			cellToParent(uprnFullCell(FIXTURE_POINTS[0]!.lat, FIXTURE_POINTS[0]!.lon), UPRN_COVERAGE_H3_RESOLUTION) as H3Cell
		)

		const surveyed = await readLayerCoverage(kdb, parent)

		expect(surveyed?.basis).toBe(CoverageBasis.Designated)
		expect(surveyed?.completeness).toBe(1)
		expect(await readLayerCoverage(kdb, 2)).toBeUndefined()

		await kdb.destroy()
	})

	it("fails loudly on header drift", async () => {
		const { sourceDir, extracted } = await writeFixtureSource("UPRN,EASTING,NORTHING,LATITUDE,LONGITUDE")
		const out = join(sourceDir, "uprn.db")

		await expect(
			buildUPRNLayer({ sourceDir, out, extracted, buildSHA: "fixture", minimumPlausibleRows: 1 })
		).rejects.toThrow(/header drift/)
	})

	it("reports a malformed row and an under-floor count as mismatches, not silence", async () => {
		const sourceDir = await mkdtemp(join(tmpdir(), "uprn-build-"))
		const csvPath = join(sourceDir, "osopenuprn_fixture.csv")

		await writeFile(csvPath, `${BOM}${OPEN_UPRN_HEADER}\r\n1,0.0,0.0,51.5,\r\n26,0.0,0.0,51.5,-2.6\r\n`, "utf8")

		const result = await buildUPRNLayer({
			sourceDir,
			out: join(sourceDir, "uprn.db"),
			extracted: {
				csvPath,
				csvBytes: 0,
				licenseText: FIXTURE_LICENSE,
				versions: FIXTURE_VERSIONS,
			},
			buildSHA: "fixture",
			minimumPlausibleRows: 2,
		})

		expect(result.inserted).toBe(1)
		expect(result.skippedMalformed).toBe(1)
		expect(result.mismatches.join("\n")).toMatch(/MALFORMED/)
		expect(result.mismatches.join("\n")).toMatch(/FLOOR/)
	})
})
