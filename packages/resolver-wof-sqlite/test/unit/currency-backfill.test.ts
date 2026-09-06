/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The currency gate's census mode: a dry run judges every dead row and stages nothing, the dead-row query admits
 *   the placetypes it is told to, and the report splits outcomes by the dead row's placetype (#1746).
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import {
	type CurrencyBackfillCountryReport,
	DEFAULT_DEAD_PLACETYPES,
	resurrectCurrencyHoles,
} from "@mailwoman/resolver-wof-sqlite/currency-backfill"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

const GILLINGHAM = { lat: 51.389, lon: 0.548 }
const ASHFORD = { lat: 51.148, lon: 0.873 }

function sourceDatabase(): DatabaseClient<WOFDatabase> {
	const db = new DatabaseClient<WOFDatabase>(":memory:")

	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL, min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER, is_superseded INTEGER
		);
		-- A dead locality whose surviving child is a neighbourhood 3 km away (the #1746 demotion shape).
		INSERT INTO spr VALUES (1, 0, 'Gillingham', 'locality', 'GB', ${GILLINGHAM.lat}, ${GILLINGHAM.lon}, 51.3, 0.5, 51.4, 0.6, 0, 1, 0);
		INSERT INTO spr VALUES (2, 1, 'Gillingham', 'neighbourhood', 'GB', 51.41, 0.56, 51.4, 0.5, 51.42, 0.6, 1, 0, 0);
		-- A dead localadmin with no live namesake: judged only when the query admits localadmin.
		INSERT INTO spr VALUES (3, 0, 'Ashford', 'localadmin', 'GB', ${ASHFORD.lat}, ${ASHFORD.lon}, 51.1, 0.8, 51.2, 0.9, 0, 1, 0);
	`)

	return db
}

/**
 * A GeoNames dump with P-class attestors for both names inside 10 km, population above the floor.
 */
function geonamesRow(name: string, lat: number, lon: number, population: number): string {
	const columns = new Array<string>(19).fill("")

	columns[1] = name
	columns[2] = name
	columns[4] = String(lat)
	columns[5] = String(lon)
	columns[6] = "P"
	columns[14] = String(population)

	return columns.join("\t")
}

async function census(
	deadPlacetypes: readonly string[] | undefined,
	options: { dryRun: boolean }
): Promise<{ reports: CurrencyBackfillCountryReport[]; staged: string[]; total: number }> {
	await using scratch = await temporaryDirectory("currency-backfill-")

	await writeLocalTextFile(
		[geonamesRow("Gillingham", 51.39, 0.55, 104_157), geonamesRow("Ashford", 51.15, 0.87, 74_204)].join("\n") + "\n",
		scratch.resolve("GB.txt")
	)

	using src = sourceDatabase()
	const reports: CurrencyBackfillCountryReport[] = []
	const staged: string[] = []

	const total = await resurrectCurrencyHoles({
		src,
		geonamesDir: scratch.path.toString(),
		countries: ["GB"],
		attrs: new Map(),
		ccID: () => 1,
		ptID: (placetype) => (placetype === "localadmin" ? 3 : 4),
		regionOf: new Map(),
		importance: undefined,
		stageRow: (pkey, attrs) => {
			staged.push(`${pkey}:${attrs.ptid}`)
		},
		progress: () => {},
		...(deadPlacetypes ? { deadPlacetypes } : {}),
		...(options.dryRun
			? { dryRun: true }
			: { tx: src as unknown as Parameters<typeof resurrectCurrencyHoles>[0]["tx"] }),
		onCountry: (report) => reports.push(report),
	})

	return { reports, staged, total }
}

describe("resurrectCurrencyHoles — the census mode", () => {
	it("judges only localities by default, and the finer surviving child does not block the dead parent", async () => {
		const { reports, staged, total } = await census(undefined, { dryRun: true })

		expect(DEFAULT_DEAD_PLACETYPES).toEqual(["locality"])
		expect(reports).toHaveLength(1)
		expect(reports[0]).toMatchObject({ country: "GB", dumpPresent: true, judged: 1, blocked: 0, resurrected: 1 })
		expect(Object.keys(reports[0]!.byDeadPlacetype)).toEqual(["locality"])
		// A dry run counts and stages nothing.
		expect(staged).toEqual([])
		expect(total).toBe(1)
	})

	it("admits a dead localadmin when told to, and reports it under its own placetype", async () => {
		const { reports } = await census(["locality", "localadmin"], { dryRun: true })

		expect(reports[0]).toMatchObject({ judged: 2, resurrected: 2 })

		expect(reports[0]!.byDeadPlacetype).toEqual({
			locality: { judged: 1, blocked: 0, unattested: 0, floored: 0, resurrected: 1 },
			localadmin: { judged: 1, blocked: 0, unattested: 0, floored: 0, resurrected: 1 },
		})
	})

	it("stages a resurrected row under the dead row's own placetype on a build run", async () => {
		const { staged } = await census(["locality", "localadmin"], { dryRun: false })

		expect(staged.toSorted()).toEqual(["ashford:3", "gillingham:4"])
	})

	it("refuses a build run without the candidate transaction", async () => {
		await expect(
			resurrectCurrencyHoles({
				src: sourceDatabase(),
				geonamesDir: "/nonexistent",
				countries: [],
				attrs: new Map(),
				ccID: () => 0,
				ptID: () => 0,
				regionOf: new Map(),
				importance: undefined,
				stageRow: () => {},
				progress: () => {},
			})
		).rejects.toThrow(/dryRun/u)
	})
})
