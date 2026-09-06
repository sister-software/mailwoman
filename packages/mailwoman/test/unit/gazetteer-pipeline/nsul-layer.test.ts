/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The NSUL builder's contract: the line classifier's input-tail behavior (BOM header, empty `PCDS`,
 *   a postcode-shaped column holding something else, a truncated line), the vintage parse, and a full
 *   fixture build through `buildNSULLayer` — the `uprn.db` join, both skipped classes, DDL, checks,
 *   coverage, manifest, seal — verified by reading the sealed artifact back through the production
 *   reader.
 */

import { statPath } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import {
	createLayerCoverageTable,
	createLayerManifestTable,
	LayerFreshnessPolicy,
	LayerTier,
	readLayerCoverage,
	readLayerManifest,
	writeLayerCoverage,
	writeLayerManifest,
	type LayerContractDatabase,
} from "@mailwoman/core/layers"
import { CoverageBasis } from "@mailwoman/evidence"
import { NSUL_COVERAGE_H3_RESOLUTION, NSULLookup } from "@mailwoman/resolver-wof-sqlite/nsul"
import { createUPRNTable, uprnFullCell, uprnH3Cell, type UPRNDatabase } from "@mailwoman/resolver-wof-sqlite/uprn"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { cellToParent } from "h3-js"
import {
	buildNSULLayer,
	classifyNSULLine,
	NSUL_HEADER,
	NSUL_REGIONS,
	nsulAttribution,
	nsulHeaderDrift,
	nsulVintageLabel,
	parseNSULVintage,
	type NSULRegion,
	type NSULRegionSource,
} from "mailwoman/gazetteer-pipeline/nsul-layer"
import { join } from "path-ts"
import { TextSpliterator } from "spliterator"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * U+FEFF, by char code so no invisible character hides in this source file.
 */
const BOM = String.fromCharCode(0xfe_ff)

/**
 * A real Epoch 127 line (UPRN 14000003, `RG40 4HR`), 29 columns.
 */
const WILD_LINE =
	"14000003,478872,164520,RG40 4HR,E00084004,E99999999,E99999999,E06000041,E05015787,E18000009,E92000001,E12000008," +
	"E14001593,E15000008,E30000256,E06000041,E65000001,E01035269,E02003456,E33040469,E38000221,E63012266,,UN1,," +
	"E37000035,,E23000029,0"

/**
 * The same 29-column shape with `uprn` and `pcds` substituted.
 */
function line(uprn: number | string, pcds: string): string {
	const parts = WILD_LINE.split(",")

	parts[0] = String(uprn)
	parts[3] = pcds

	return parts.join(",")
}

describe("classifyNSULLine", () => {
	it("reads UPRN and PCDS out of a wild line", () => {
		expect(classifyNSULLine(WILD_LINE)).toEqual({ kind: "row", uprn: 14_000_003, pcds: "RG40 4HR" })
	})

	it("strips the CRLF terminator the wild file carries", () => {
		expect(classifyNSULLine(`${WILD_LINE}\r`)).toEqual({ kind: "row", uprn: 14_000_003, pcds: "RG40 4HR" })
	})

	it("classes an empty PCDS as no-postcode, keeping the UPRN", () => {
		expect(classifyNSULLine(line(14_000_003, ""))).toEqual({ kind: "no-postcode", uprn: 14_000_003 })
	})

	it("accepts every unit-postcode shape, GIR 0AA included", () => {
		for (const pcds of ["M1 1AA", "B33 8TH", "CR2 6XH", "DN55 1PT", "W1A 0AX", "EC1A 1BB", "GIR 0AA"]) {
			expect(classifyNSULLine(line(1, pcds))).toEqual({ kind: "row", uprn: 1, pcds })
		}
	})

	it("rejects a postcode-shaped column holding something else", () => {
		expect(classifyNSULLine(line(1, "RG404HR"))).toEqual({ kind: "malformed" })
		expect(classifyNSULLine(line(1, "rg40 4hr"))).toEqual({ kind: "malformed" })
		expect(classifyNSULLine(line(1, "E00084004"))).toEqual({ kind: "malformed" })
	})

	it("rejects a wrong field count — a truncated or shifted line", () => {
		expect(classifyNSULLine(WILD_LINE.slice(0, WILD_LINE.lastIndexOf(",")))).toEqual({ kind: "malformed" })
		expect(classifyNSULLine(`${WILD_LINE},extra`)).toEqual({ kind: "malformed" })
	})

	it("rejects a non-literal UPRN", () => {
		expect(classifyNSULLine(line("1e3", "RG40 4HR"))).toEqual({ kind: "malformed" })
		expect(classifyNSULLine(line("abc", "RG40 4HR"))).toEqual({ kind: "malformed" })
		expect(classifyNSULLine(line("-1", "RG40 4HR"))).toEqual({ kind: "malformed" })
		expect(classifyNSULLine(line("", "RG40 4HR"))).toEqual({ kind: "malformed" })
	})
})

describe("nsulHeaderDrift", () => {
	it("accepts the wild header under its BOM and CRLF", () => {
		expect(nsulHeaderDrift(`${BOM}${NSUL_HEADER}\r`)).toBeNull()
		expect(nsulHeaderDrift(NSUL_HEADER)).toBeNull()
	})

	it("reports a drifted header as found", () => {
		expect(nsulHeaderDrift(`${BOM}UPRN,PCDS\r`)).toBe("UPRN,PCDS")
	})
})

describe("parseNSULVintage", () => {
	it("reads epoch, month and year out of the archive name and a region member name", () => {
		const expected = { epoch: 127, month: "2026-06", monthName: "June", year: 2026 }

		expect(parseNSULVintage("NSUL_E127_JUN_2026.zip")).toEqual(expected)
		expect(parseNSULVintage("Data/NSUL_E127_JUN_2026_SE.csv")).toEqual(expected)
		expect(nsulVintageLabel(expected)).toBe("2026-06 (Epoch 127)")
	})

	it("returns null for a name that is not NSUL's", () => {
		expect(parseNSULVintage("osopenuprn_202608.zip")).toBeNull()
		expect(parseNSULVintage("NSUL_E127_XYZ_2026.zip")).toBeNull()
	})
})

describe("nsulAttribution", () => {
	it("carries the four statements the user guide requires, in order", () => {
		const text = nsulAttribution(2026)

		expect(text).toBe(
			"Contains OS data © Crown copyright and database right 2026. " +
				"Contains Royal Mail data © Royal Mail copyright and Database right 2026. " +
				"Contains GeoPlace data © Local Government Information House Limited copyright and database right 2026. " +
				"Source: Office for National Statistics licensed under the Open Government Licence v.3.0"
		)
	})
})

/**
 * The fixture `uprn.db`: three points. UPRN 5 is deliberately ABSENT so a register row naming it becomes
 * `skipped-no-coordinate`.
 */
const UPRN_POINTS = [
	{ uprn: 14_000_003, lat: 51.3742681, lon: -0.8682259 },
	{ uprn: 14_000_005, lat: 51.37416, lon: -0.86823 },
	{ uprn: 100_062_353_961, lat: 50.7876, lon: -0.6717 },
]

async function writeFixtureUPRNDatabase(dir: string): Promise<string> {
	const path = join(dir, "uprn.db")

	using kdb = new DatabaseClient<UPRNDatabase>(path)

	await createUPRNTable(kdb)
	await createLayerManifestTable(kdb)
	await createLayerCoverageTable(kdb)

	const insert = kdb.prepare("INSERT INTO uprn (uprn, lat, lon, h3_cell) VALUES (?, ?, ?, ?)")

	for (const point of UPRN_POINTS) {
		insert.run(point.uprn, point.lat, point.lon, uprnH3Cell(point.lat, point.lon))
	}

	await writeLayerManifest(kdb, {
		name: "os-open-uprn-fixture",
		version: "2026-08-fixture",
		schemaVersion: 1,
		tier: LayerTier.BuildLocal,
		license: "OGL-UK-3.0",
		attribution: "fixture",
		source: "fixture",
		sourceVintage: "fixture",
		buildCmd: "nsul-layer.test.ts",
		buildSHA: "fixture",
		freshnessPolicy: LayerFreshnessPolicy.Sealed,
		spineKeys: { h3: { column: "h3_cell", resolution: 9 } },
		createdAt: "2026-09-03T00:00:00.000Z",
	})

	await writeLayerCoverage(kdb, [{ h3Cell: 1, completeness: 1, basis: CoverageBasis.Designated, observedRows: 3 }])

	return path
}

/**
 * Eleven region files in the wild file's exact shape — BOM-prefixed header, CRLF terminators — with the rows spread
 * over two regions and the other nine header-only, so the region-set check and the per-region counts are exercised.
 */
async function writeFixtureRegions(
	dir: string,
	rowsByRegion: Partial<Record<NSULRegion, string[]>>,
	header: string = NSUL_HEADER
): Promise<NSULRegionSource[]> {
	const sources: NSULRegionSource[] = []

	for (const region of NSUL_REGIONS) {
		const path = join(dir, `NSUL_E127_JUN_2026_${region}.csv`)
		const rows = rowsByRegion[region] ?? []

		await writeLocalTextFile(`${BOM}${[header, ...rows].join("\r\n")}\r\n`, path)

		sources.push({ region, label: path, lines: () => TextSpliterator.fromAsync(path) })
	}

	return sources
}

const VINTAGE = { epoch: 127, month: "2026-06", monthName: "June", year: 2026 }

describe("buildNSULLayer (fixture)", () => {
	it("joins the register to uprn.db, counts both skipped classes, and seals a layer the reader answers from", async () => {
		const dir = fixtures.use(await temporaryDirectory("nsul-build-")).path.toString()
		const uprnDatabasePath = await writeFixtureUPRNDatabase(dir)

		const regions = await writeFixtureRegions(dir, {
			SE: [
				line(14_000_003, "RG40 4HR"),
				line(14_000_005, "RG40 4HR"),
				line(100_062_353_961, "PO21 1HR"),
				// PCDS empty: the postcode is not in Code-Point Open.
				line(14_000_007, ""),
			],
			// A register row for a UPRN uprn.db does not hold.
			LN: [line(5, "SW1A 1AA")],
		})

		const out = join(dir, "nsul.db")

		const result = await buildNSULLayer({
			sourceDir: dir,
			out,
			uprnDatabasePath,
			sources: { vintage: VINTAGE, regions },
			buildSHA: "fixture",
			minimumPlausibleRows: 3,
			now: new Date("2026-09-03T00:00:00.000Z"),
		})

		expect(result.read).toBe(5)
		expect(result.inserted).toBe(3)
		expect(result.skippedMalformed).toBe(0)
		expect(result.skippedDuplicate).toBe(0)
		expect(result.skippedNoPostcode).toBe(1)
		expect(result.skippedNoCoordinate).toBe(1)
		expect(result.readByRegion.SE).toBe(4)
		expect(result.readByRegion.LN).toBe(1)
		expect(result.readByRegion.EE).toBe(0)
		expect(result.uprnLayerVersion).toBe("2026-08-fixture")
		expect(result.mismatches).toEqual([])
		expect(result.sealed).toBe(true)

		// Sealed 0444 — no write bits.
		expect((await statPath(out)).mode & 0o222).toBe(0)

		using lookup = new NSULLookup({ databasePath: out })

		expect(lookup.postcodeForUPRN(14_000_003)).toEqual({ pcds: "RG40 4HR", pcdsCompact: "RG404HR" })
		expect(lookup.postcodeForUPRN(14_000_007)).toBeNull()
		expect(lookup.postcodeForUPRN(5)).toBeNull()

		// The coordinate is uprn.db's, verbatim.
		expect(lookup.uprnsForPostcode("PO21 1HR")).toEqual([
			{
				uprn: 100_062_353_961,
				latitude: 50.7876,
				longitude: -0.6717,
				h3Cell: uprnH3Cell(50.7876, -0.6717),
			},
		])

		using kdb = new DatabaseClient<LayerContractDatabase>(out, { readOnly: true })

		const manifest = await readLayerManifest(kdb)

		expect(manifest.name).toBe("nsul-uprn-postcode-gb")
		expect(manifest.version).toBe("2026-06 (Epoch 127)")
		expect(manifest.tier).toBe(LayerTier.BuildLocal)
		expect(manifest.license).toBe("OGL-UK-3.0")
		expect(manifest.attribution).toBe(nsulAttribution(2026))

		expect(manifest.source).toBe(
			"ONS National Statistics UPRN Lookup (June 2026, Epoch 127) — https://geoportal.statistics.gov.uk"
		)

		expect(manifest.sourceVintage).toBe("2026-06 (Epoch 127)")
		expect(manifest.spineKeys.h3).toEqual({ column: "h3_cell", resolution: 9 })

		// Coverage: the res-6 parent of a written point is designated-complete; an unsurveyed cell is UNKNOWN.
		const parent = shortCellToInt(
			cellToParent(uprnFullCell(UPRN_POINTS[0]!.lat, UPRN_POINTS[0]!.lon), NSUL_COVERAGE_H3_RESOLUTION) as H3Cell
		)

		const surveyed = await readLayerCoverage(kdb, parent)

		expect(surveyed?.basis).toBe(CoverageBasis.Designated)
		expect(surveyed?.completeness).toBe(1)
		expect(surveyed?.observedRows).toBe(2)
		expect(await readLayerCoverage(kdb, 2)).toBeUndefined()
	})

	it("fails loudly on header drift in any region file", async () => {
		const dir = fixtures.use(await temporaryDirectory("nsul-build-")).path.toString()
		const uprnDatabasePath = await writeFixtureUPRNDatabase(dir)
		const regions = await writeFixtureRegions(dir, {}, "UPRN,GRIDGB1E,GRIDGB1N,PCD,OA21CD")

		await expect(
			buildNSULLayer({
				sourceDir: dir,
				out: join(dir, "nsul.db"),
				uprnDatabasePath,
				sources: { vintage: VINTAGE, regions },
				buildSHA: "fixture",
				minimumPlausibleRows: 1,
			})
		).rejects.toThrow(/header drift/)
	})

	it("reports a malformed row, a duplicate and an under-floor count as mismatches, not silence", async () => {
		const dir = fixtures.use(await temporaryDirectory("nsul-build-")).path.toString()
		const uprnDatabasePath = await writeFixtureUPRNDatabase(dir)

		const regions = await writeFixtureRegions(dir, {
			SE: [line(14_000_003, "RG40 4HR"), line(14_000_003, "RG40 4HR"), line(14_000_005, "RG404HR")],
		})

		const result = await buildNSULLayer({
			sourceDir: dir,
			out: join(dir, "nsul.db"),
			uprnDatabasePath,
			sources: { vintage: VINTAGE, regions },
			buildSHA: "fixture",
			minimumPlausibleRows: 3,
		})

		expect(result.read).toBe(3)
		expect(result.inserted).toBe(1)
		expect(result.skippedDuplicate).toBe(1)
		expect(result.skippedMalformed).toBe(1)

		const text = result.mismatches.join("\n")

		expect(text).toMatch(/MALFORMED/)
		expect(text).toMatch(/DUPLICATE/)
		expect(text).toMatch(/FLOOR/)
		expect(text).not.toMatch(/TOTAL/)
	})
})
