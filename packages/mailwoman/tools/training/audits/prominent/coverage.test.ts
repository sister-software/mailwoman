// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { type DisposableDuckDB, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { describe, expect, it } from "vitest"

import {
	createProminentCoverageTables,
	decileOneDeficit,
	type EpochRates,
	evaluateProminentCoverage,
	PROMINENT_PLACES_RECORD_VERSION,
	readProminentPlacesRecord,
} from "./coverage.ts"

/**
 * One country, GB: a prominent locality `alpha` in decile 1, an unprominent `beta` in
 * decile 10, a prominent sub-locality `soho` under `alpha`, and a prominent `gamma`
 * whose only score is a GeoNames match that another WOF place could also claim.
 */
const PLACES_SQL =
	"SELECT * FROM (VALUES " +
	"(1, 'GB', 'locality', 'Alpha', 'alpha', 1, 1, true, false, 'importance', NULL, NULL, NULL, 1000, NULL, 'England', ['ENG'], 'none'), " +
	"(2, 'GB', 'locality', 'Beta', 'beta', 10, 10, false, false, 'importance', NULL, NULL, NULL, 10, NULL, 'England', ['ENG'], 'none'), " +
	"(3, 'GB', 'sublocality', 'Soho', 'soho', 1, 1, true, false, 'importance', NULL, NULL, NULL, 50, 'Alpha', 'England', ['ENG'], 'name'), " +
	"(4, 'GB', 'locality', 'Gamma', 'gamma', 1, 2, true, false, 'geonames', 'competing-candidate', 3.2, '123', 500, NULL, 'England', ['ENG'], 'none')" +
	") AS t(spr_id, country, band, name, fold, decile, rank, by_rank, capital, score_source, geonames_check, geonames_km, " +
	"geonames_id, population_used, parent_locality, region, region_abbrs, postal_evidence)"

type ShortRow = [shape: string, s1: string, s2: string | null, rows: number, source?: string]

async function fixture(db: DisposableDuckDB, directory: string, shortRows: readonly ShortRow[]) {
	await db.run(`COPY (${PLACES_SQL}) TO '${directory}/places.parquet' (FORMAT PARQUET)`)

	const values = shortRows
		.map(
			([shape, s1, s2, rows, source]) =>
				`('GB', '${source ?? "wof-admin"}', '${shape}', '${s1}', ${s2 ? `'${s2}'` : "NULL"}, NULL::VARCHAR, ${rows}::BIGINT)`
		)
		.join(", ")

	await db.run(
		`COPY (SELECT * FROM (VALUES ${values}) AS t(country, source, shape, s1, s2, s3, rows)) ` +
			`TO '${directory}/short-admin-rows.parquet' (FORMAT PARQUET)`
	)

	await writeLocalTextFile(
		stringifyJSON({
			version: PROMINENT_PLACES_RECORD_VERSION,
			places_sha256: await sha256File(`${directory}/places.parquet`),
		}),
		`${directory}/PLACES.json`
	)
}

/**
 * An epoch that admits GB and draws a `wof-admin` row once, a `tiger` row 0.1 times,
 * and a `retired` row zero times.
 */
const RATES: EpochRates = {
	draws: 100,
	perAdmittedRow: new Map([
		["wof-admin", 1],
		["tiger", 0.1],
	]),
	admission: new Map([["GB", 1]]),
}

async function evaluate(directory: string, shortRows: readonly ShortRow[], rates: EpochRates = RATES) {
	{
		using writer = await openDuckDB()

		await fixture(writer, directory, shortRows)
	}

	using db = await openDuckDB()

	await createProminentCoverageTables(db, `${directory}/places.parquet`, `${directory}/short-admin-rows.parquet`, rates)

	// Awaited here, because `using` closes the database when the function returns.
	return await evaluateProminentCoverage(db)
}

/**
 * Every required form of the prominent places written once, and `beta` written eight times bare.
 */
const COVERED: readonly ShortRow[] = [
	["locality", "alpha", null, 2],
	["locality", "beta", null, 8],
	["locality|region", "alpha", "england", 1],
	["locality|region", "alpha", "eng", 1],
	["locality|country", "alpha", null, 1],
	["dependent_locality|locality", "soho", "alpha", 1],
]

describe("prominent_place_coverage", () => {
	it("requires each prominent place's forms, and not a place whose GeoNames match has a competitor", async () => {
		await using directory = await temporaryDirectory("prominent-coverage-")

		const { presence } = await evaluate(directory.path.toString(), COVERED.slice(0, 5))

		// Alpha in its bare, region, region abbreviation and country forms, and Soho beside its parent.
		expect(presence.required_places).toBe(2)
		expect(presence.required_forms).toBe(5)
		expect(presence.not_required).toEqual({ "competing-candidate": 1 })

		expect(presence.failing).toEqual([
			{ country: "GB", band: "sublocality", query_shape: "parent", spr_id: 3, name: "Soho" },
		])
	})

	it("finds the place's span in either position, as a largest-first layout writes it", async () => {
		await using directory = await temporaryDirectory("prominent-coverage-")

		const reversed = COVERED.map(([shape, s1, s2, rows]): ShortRow =>
			shape === "locality|region" && s2 === "england"
				? ["region|locality", "england", "alpha", rows]
				: [shape, s1, s2, rows]
		)

		const { presence } = await evaluate(directory.path.toString(), reversed)

		expect(presence.covered_forms).toBe(presence.required_forms)
	})

	it("counts a sub-locality's row only under dependent locality beside its parent", async () => {
		await using directory = await temporaryDirectory("prominent-coverage-")

		const { presence } = await evaluate(directory.path.toString(), [
			...COVERED.slice(0, 5),
			["locality|locality", "soho", "alpha", 4],
		])

		expect(presence.covered_forms).toBe(4)
	})

	it("fails a cell whose decile 1 falls short of half its population share, and passes it after the deficit", async () => {
		await using directory = await temporaryDirectory("prominent-coverage-")

		const before = await evaluate(directory.path.toString(), COVERED)
		const bare = before.demand_share.failing.find((cell) => cell.band === "locality" && cell.query_shape === "bare")!

		// alpha holds 1000 of the 1010 people with a population, and 2 of the 10 bare draws.
		expect(bare.decile1_draw_share).toBeCloseTo(0.2)
		expect(bare.target).toBeCloseTo(0.5 * (1000 / 1010))
		expect(bare.deficit_draws).toBeCloseTo(decileOneDeficit(10, 2, bare.target))

		const rows = Math.ceil(bare.deficit_draws)

		const after = await evaluate(directory.path.toString(), [
			...COVERED.filter(([shape, s1]) => !(shape === "locality" && s1 === "alpha")),
			["locality", "alpha", null, 2 + rows],
		])

		expect(
			after.demand_share.failing.find((cell) => cell.band === "locality" && cell.query_shape === "bare")
		).toBeUndefined()

		const short = await evaluate(directory.path.toString(), [
			...COVERED.filter(([shape, s1]) => !(shape === "locality" && s1 === "alpha")),
			["locality", "alpha", null, 1 + rows],
		])

		expect(short.demand_share.failing.some((cell) => cell.band === "locality" && cell.query_shape === "bare")).toBe(
			true
		)
	})

	it("weighs decile 1's rows by their expected draws, not their count on disk", async () => {
		await using directory = await temporaryDirectory("prominent-coverage-")

		const bareCell = (result: Awaited<ReturnType<typeof evaluate>>) =>
			result.demand_share.failing.find((cell) => cell.band === "locality" && cell.query_shape === "bare")

		const others = COVERED.filter(([shape]) => shape !== "locality")

		// Eight alpha rows against eight beta rows pass at one draw each.
		const drawn = await evaluate(directory.path.toString(), [
			...others,
			["locality", "alpha", null, 8],
			["locality", "beta", null, 8],
		])

		expect(bareCell(drawn)).toBeUndefined()

		// The same rows fail when alpha's come from a source drawn 0.1 times per row.
		const thin = await evaluate(directory.path.toString(), [
			...others,
			["locality", "alpha", null, 8, "tiger"],
			["locality", "beta", null, 8],
		])

		expect(bareCell(thin)?.decile1_draw_share).toBeCloseTo(0.8 / 8.8)
		expect(bareCell(thin)?.rows).toBe(16)
	})

	it("covers no form with rows the epoch never draws", async () => {
		await using directory = await temporaryDirectory("prominent-coverage-")

		const { presence, epoch } = await evaluate(directory.path.toString(), [
			...COVERED.filter(([shape]) => shape !== "dependent_locality|locality"),
			["dependent_locality|locality", "soho", "alpha", 3, "retired"],
		])

		expect(presence.failing).toEqual([
			{ country: "GB", band: "sublocality", query_shape: "parent", spr_id: 3, name: "Soho" },
		])

		expect(epoch.sources.find((source) => source.source === "retired")).toEqual({
			source: "retired",
			draws_per_admitted_row: 0,
			short_rows: 3,
			short_draws: 0,
		})
	})

	it("requires no place of a country the config doesn't admit", async () => {
		await using directory = await temporaryDirectory("prominent-coverage-")

		const { presence, demand_share } = await evaluate(directory.path.toString(), COVERED, {
			...RATES,
			admission: new Map([["FR", 1]]),
		})

		expect(presence.required_forms).toBe(0)
		expect(presence.not_required).toEqual({ "country-not-admitted": 3 })
		expect(demand_share.cells).toBe(0)
	})

	it("counts every short row that writes a dependent locality without a locality", async () => {
		await using directory = await temporaryDirectory("prominent-coverage-")

		const { coherence } = await evaluate(directory.path.toString(), [
			...COVERED,
			["dependent_locality|region", "soho", "england", 3],
		])

		expect(coherence.rows).toBe(3)
		expect(coherence.by_source).toEqual([{ source: "wof-admin", shape: "dependent_locality|region", rows: 3 }])
	})

	it("refuses a places table its record doesn't describe", async () => {
		await using directory = await temporaryDirectory("prominent-coverage-")
		const path = directory.path.toString()

		{
			using db = await openDuckDB()

			await fixture(db, path, COVERED)
		}

		await writeLocalTextFile(
			stringifyJSON({ version: PROMINENT_PLACES_RECORD_VERSION, places_sha256: "0" }),
			`${path}/PLACES.json`
		)

		await expect(readProminentPlacesRecord(`${path}/places.parquet`)).rejects.toThrow("records 0")
	})
})

describe("decileOneDeficit", () => {
	it("is the decile-1 draws that lift the share exactly to the target", () => {
		const deficit = decileOneDeficit(100, 10, 0.3)

		expect((10 + deficit) / (100 + deficit)).toBeCloseTo(0.3, 12)
		expect(decileOneDeficit(100, 40, 0.3)).toBe(0)
	})
})
