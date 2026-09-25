/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Builds the Singapore register board, `gauntlet/cases/sg/register.jsonl`, from a seeded draw of Overture rows.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { OVERTURE_ADDRESSES_RELEASE } from "@mailwoman/core/overture-pins"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { isoDate, mulberry32 } from "@mailwoman/core/utils"
import { isBuildingName, renderSGRegister, type SGRegister } from "@mailwoman/corpus/sg/recipes/register"
import { PathBuilder } from "path-ts"

import { gradeSeedCases, reportGradedGroups, writeSeedCaseFile } from "#dev-tools/grade-seed-cases"
import { CASES_DIR } from "#eval-harness/gauntlet/cases/load"
import type { SeedCase } from "#eval-harness/gauntlet/cases/seed-case"

const { values } = parseArguments({
	options: {
		n: { type: "string", default: "240" },
		seed: { type: "string", default: "7" },
		parquet: { type: "string" },
		out: { type: "string" },
		"skip-grade": { type: "boolean", default: false },
	},
})

const N = Number(values.n)
const SEED = Number(values.seed)

const PARQUET = PathBuilder.from(
	values.parquet ?? dataRootPath("overture", OVERTURE_ADDRESSES_RELEASE, "addresses-sg.parquet")
)

const OUT = PathBuilder.from(values.out ?? CASES_DIR("sg", "register.jsonl"))
const RELEASE = /\d{4}-\d{2}-\d{2}\.\d+/u.exec(PARQUET.toString())?.[0] ?? "unknown"
const SOURCE = `sg-register-board:${isoDate()}`
const ADDED_AT = isoDate()

/**
 * Sets the coordinate tolerance, which is a postcode's precision because a
 * six-digit Singapore postcode covers one building.
 */
const TOLERANCE_M = 1000

/**
 * Lists the four forms the `sg-register` corpus recipe renders.
 * The board draws an equal share of each.
 */
const REGISTERS: readonly SGRegister[] = ["block", "bracket_postcode", "building_led", "official"]

const ADDRESS_KIND: Record<SGRegister, string> = {
	block: "sg_block_postal",
	bracket_postcode: "sg_bracket_postcode",
	building_led: "sg_building_led",
	official: "sg_official",
}

/**
 * Holds the Overture fields read for one drawn row.
 */
interface RegisterRow {
	number: string
	street: string
	unit: string
	postcode: string
	lat: number
	lon: number
}

/**
 * Draws about `N` rows split across the registers, seeding DuckDB so the same seed draws the same rows.
 *
 * Building-led rows come from rows whose `unit` is a building name.
 * The other registers draw from all rows.
 */
async function drawRows(): Promise<Map<SGRegister, RegisterRow[]>> {
	// `@duckdb/node-api` is an optional dependency, so it is imported only when this tool runs.
	const { DuckDBInstance } = await import("@duckdb/node-api")
	const instance = await DuckDBInstance.create()
	const conn = await instance.connect()
	const perRegister = Math.ceil(N / REGISTERS.length)
	const out = new Map<SGRegister, RegisterRow[]>()

	await conn.run(`SELECT setseed(${((SEED % 1000) / 1000).toFixed(3)})`)

	const read = async (where: string, limit: number): Promise<RegisterRow[]> => {
		const result = await conn.runAndReadAll(
			`SELECT number, street, coalesce(unit, '') AS unit, postcode, lat, lon FROM read_parquet('${PARQUET}')
			 WHERE regexp_matches(trim(number), '^\\d+[A-Z]?$') AND regexp_matches(trim(postcode), '^\\d{6}$')
			   AND nullif(trim(street), '') IS NOT NULL AND lat IS NOT NULL AND lon IS NOT NULL ${where}
			 ORDER BY random() LIMIT ${limit}`
		)

		return result.getRowObjects().map((r) => ({
			number: String(r["number"]).trim(),
			street: String(r["street"]).trim(),
			unit: String(r["unit"]).trim(),
			postcode: String(r["postcode"]).trim(),
			lat: Number(r["lat"]),
			lon: Number(r["lon"]),
		}))
	}

	// The SQL pattern admits estate names that `isBuildingName` rejects, so the pool is drawn three times larger.
	const named = await read(`AND regexp_matches(trim(unit), '^[A-Z][A-Z .&''-]* [A-Z .&''-]+$')`, perRegister * 3)
	const buildings = named.filter((r) => isBuildingName(r.unit)).slice(0, perRegister)

	out.set("building_led", buildings)

	const rest = await read("", perRegister * 3)
	const seen = new Set(buildings.map((r) => `${r.number}|${r.street}|${r.postcode}`))
	const pool = rest.filter((r) => !seen.has(`${r.number}|${r.street}|${r.postcode}`))

	for (const [i, register] of (["block", "bracket_postcode", "official"] as const).entries()) {
		out.set(register, pool.slice(i * perRegister, (i + 1) * perRegister))
	}

	return out
}

const drawn = await drawRows()
const cases: SeedCase[] = []

for (const register of REGISTERS) {
	for (const [i, row] of (drawn.get(register) ?? []).entries()) {
		const rendering = renderSGRegister(row, mulberry32(SEED * 100_003 + i), register)

		if (rendering.register !== register) {
			throw new Error(`row ${row.number} ${row.street} rendered ${rendering.register}, wanted ${register}`)
		}

		cases.push({
			id: `sg-register-${register.replaceAll("_", "-")}-${row.postcode}-${row.number.toLowerCase()}`,
			input: rendering.raw,
			source: SOURCE,
			addressKind: ADDRESS_KIND[register],
			country: "SG",
			status: "improvement_target",
			expectComponents: rendering.components,
			expectLat: Number(row.lat.toFixed(6)),
			expectLon: Number(row.lon.toFixed(6)),
			expectToleranceM: TOLERANCE_M,
			addedAt: ADDED_AT,
			note: `Overture-SG ${RELEASE} row "${row.number} ${row.street} ${row.postcode}" rendered by the sg-register recipe (${register}); the point is the register's rooftop.`,
		})
	}
}

// Grading sets each row's `status` to `pass` or `improvement_target` from the shipped pipeline's result.
if (!values["skip-grade"]) {
	const graded = await gradeSeedCases(cases)

	console.log(`\n=== Singapore register board (${cases.length} rows, seed ${SEED}, Overture ${RELEASE}) ===`)

	reportGradedGroups(graded, (seed) => REGISTERS.find((r) => ADDRESS_KIND[r] === seed.addressKind)!)
}

await writeSeedCaseFile(cases, OUT)
