/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A locale whose overlay is absent from the weights cache is graded base-only, so `--refuse-country` states which
 *   locales the read could not speak for.
 *
 *   Every id must match a row: a typo that promotes no row reads exactly like a list already applied.
 *
 *   Rows are read from the case files rather than through `loadRegressionCases`, which omits a row's source file.
 *
 *   Run: node packages/mailwoman/lib/dev-tools/apply-board-promotions.run.ts --ids <file> [--to pass]
 *   [--refuse-country de,es,gb,in,it,nz] [--dry-run]
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { JSONSpliterator, TextSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { writeSeedCaseFile } from "#dev-tools/grade-seed-cases"
import { CASES_DIR } from "#eval-harness/gauntlet/cases/load"
import { type SeedCase, SeedCaseSchema } from "#eval-harness/gauntlet/cases/seed-case"

const { values } = parseArguments({
	options: {
		ids: { type: "string" },
		to: { type: "string", default: "pass" },
		"refuse-country": { type: "string", default: "" },
		"dry-run": { type: "boolean", default: false },
	},
})

const idsPath = values.ids

if (!idsPath) throw new Error("--ids <file> is required: one board row id per line")

const status = values.to

if (status !== "pass" && status !== "improvement_target" && status !== "known_fail") {
	throw new Error(`--to must be pass | improvement_target | known_fail, got ${stringifyJSON(status)}`)
}

const refused = new Set(
	values["refuse-country"]
		.split(",")
		.map((cc) => cc.trim().toLowerCase())
		.filter((cc) => cc.length)
)

const wanted = new Set(
	await TextSpliterator.fromAsync(idsPath)
		.map((line) => line.trim())
		.filter((line) => line.length && !line.startsWith("#"))
		.toArray()
)

const countryDirectories = (
	await Globerator.from("*", { cwd: CASES_DIR, withFileTypes: true, onlyFiles: false }).toArray()
)
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.toSorted()

// Validate the whole list before writing anything: a refusal halfway through
// would leave some files promoted and some not.
const byPath = new Map<string, SeedCase[]>()
const found = new Map<string, string>()

for (const cc of countryDirectories) {
	const directory = CASES_DIR(cc)

	const files = await Globerator.files("jsonl", { cwd: directory, absolute: false, recursive: false }).toSorted()

	for (const name of files) {
		const path = directory(name).toString()

		const rows = await JSONSpliterator.fromAsync<unknown>(path)
			.map((row) => SeedCaseSchema.parse(row) as SeedCase)
			.toArray()

		byPath.set(path, rows)

		for (const seed of rows) {
			if (wanted.has(seed.id)) {
				found.set(seed.id, path)
			}
		}
	}
}

const missing = [...wanted].filter((id) => !found.has(id))

if (missing.length) {
	throw new Error(`${missing.length} id(s) match no board row, so the list is stale or mistyped: ${missing.join(", ")}`)
}

const blocked = [...byPath.values()]
	.flat()
	.filter((seed) => wanted.has(seed.id) && refused.has(seed.country.toLowerCase()))
	.map((seed) => seed.id)

if (blocked.length) {
	throw new Error(
		`${blocked.length} id(s) are in a refused country, where the read that produced this list was base-only: ${blocked.join(", ")}`
	)
}

let changed = 0
const touched: string[] = []

for (const [path, rows] of byPath) {
	const movable = rows.filter((seed) => wanted.has(seed.id) && seed.status !== status)

	if (!movable.length) continue

	changed += movable.length
	touched.push(`${path}: ${movable.length}`)

	if (!values["dry-run"]) {
		await writeSeedCaseFile(
			rows.map((seed) => (wanted.has(seed.id) ? { ...seed, status } : seed)),
			path
		)
	}
}

const untouched = wanted.size - changed

if (untouched) {
	console.log(`${untouched} row(s) already read ${status}; they are left alone.`)
}

console.log(`${values["dry-run"] ? "would set" : "set"} status=${status} on ${changed} row(s)`)

for (const line of touched.toSorted()) {
	console.log(`  ${line}`)
}
