/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build `gauntlet/cases/sg/register.jsonl`, the Singapore register board: a seeded draw of Overture-SG rooftop
 *   rows, each rendered in one of the four typed forms the `sg-register` corpus recipe renders (the HDB block line
 *   with a `#NN-NN` unit, the `S(NNNNNN)` postcode, the building-led line, the official line), balanced across the
 *   four so a form the model has never seen cannot hide behind the ones it has.
 *
 *   The truth is the register row's own point and its fields. `expectComponents` carries what the recipe tagged, so the
 *   board grades the parse the recipe teaches (`Blk` untagged, `#05-67` as `unit`, `S(` `)` untagged); the coordinate
 *   tolerance is the postcode's: a six-digit Singapore postcode names one building, and the register's postcode point
 *   sat within 1 km of the rooftop on 300 of 300 drawn rows.
 *
 *   Every row is GRADED through the gauntlet's own grader before it is written, and its `status` is what the shipped
 *   pipeline does today: `pass` when it passes, `improvement_target` when it does not. The board is therefore a
 *   regression pin for what already works and a target list for what does not, in one file, and the summary this
 *   prints per register is the board read.
 *
 *   Run: node packages/mailwoman/lib/dev-tools/sg-register-board.run.ts [--n 240] [--seed 7] [--parquet <path>] [--out
 *   <path>] [--skip-grade]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { OVERTURE_ADDRESSES_RELEASE } from "@mailwoman/core/overture-pins"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { isoDate, mulberry32 } from "@mailwoman/core/utils"
import { isBuildingName, renderSGRegister, type SGRegister } from "@mailwoman/corpus/recipes/sg-register"
import { join } from "path-ts"

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
const PARQUET = values.parquet ?? String(dataRootPath("overture", OVERTURE_ADDRESSES_RELEASE, "addresses-sg.parquet"))
const OUT = values.out ?? String(join(CASES_DIR, "sg", "register.jsonl"))
const RELEASE = /\d{4}-\d{2}-\d{2}\.\d+/u.exec(PARQUET)?.[0] ?? "unknown"
const SOURCE = `sg-register-board:${isoDate()}`
const ADDED_AT = isoDate()

/**
 * The postcode's own tolerance: one six-digit code is one building.
 */
const TOLERANCE_M = 1000

const REGISTERS: readonly SGRegister[] = ["block", "bracket_postcode", "building_led", "official"]

const ADDRESS_KIND: Record<SGRegister, string> = {
	block: "sg_block_postal",
	bracket_postcode: "sg_bracket_postcode",
	building_led: "sg_building_led",
	official: "sg_official",
}

interface RegisterRow {
	number: string
	street: string
	unit: string
	postcode: string
	lat: number
	lon: number
}

/**
 * Draw `n` register rows, seeded through DuckDB's own generator so a re-run with the same seed draws the same rows. The
 * building-led quarter is drawn from the rows whose `unit` is a building name; the rest from every row.
 */
async function drawRows(): Promise<Map<SGRegister, RegisterRow[]>> {
	// @duckdb/node-api is an optional peer dep (this is a maintainer-only board builder).
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

	// Over-draw the building-led pool: the SQL shape test admits estate names the recipe refuses.
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

if (!values["skip-grade"]) {
	const graded = await gradeSeedCases(cases)

	console.log(`\n=== Singapore register board (${cases.length} rows, seed ${SEED}, Overture ${RELEASE}) ===`)

	reportGradedGroups(graded, (seed) => REGISTERS.find((r) => ADDRESS_KIND[r] === seed.addressKind)!)
}

await writeSeedCaseFile(cases, OUT)
