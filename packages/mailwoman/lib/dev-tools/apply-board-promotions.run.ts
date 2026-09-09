/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Set the status of named board rows from a control arm's read, rewriting the `gauntlet/cases/<cc>/*.jsonl` files
 *   that hold them.
 *
 *   A row's status is a claim about a MODEL: `improvement_target` says the arm this board is graded against fails the
 *   row. Author a board against one model and grade it against another and the claim is simply false — the target set
 *   then contains rows the control already passes, and the comparison reports them as wins.
 *
 *   The gauntlet's regression layer prints the rows whose status disagrees with the run (`now PASSES — promote to
 *   status=pass`). Feed those ids here to make the board agree with the arm it is graded against.
 *
 *   WARNING: read the run's overlay warnings before feeding it a list. A locale whose overlay is absent from the
 *   weights cache is graded BASE-ONLY, and a base-only pass is not evidence that the production path passes — the
 *   overlay changes the prior. This tool cannot see that, so `--refuse-country` is how the caller states which locales
 *   the read could not speak for.
 *
 *   Every id must match a row. An id that matches nothing is an ERROR, not a skip: a promote list is transcribed from
 *   a log, and a typo that silently promotes nothing reads exactly like a list that was already applied.
 *
 *   Rows are read from the case files rather than through `loadRegressionCases`, which does not record which file a row
 *   came from. Deriving that from the id would guess — `sg-register-block-…` lives in `register.jsonl` but
 *   `ve-f5-caracas-…` lives in `family-locality-postcode.jsonl` — and a wrong guess writes a row into a file it does
 *   not belong to.
 *
 *   Run: node packages/mailwoman/lib/dev-tools/apply-board-promotions.run.ts --ids <file> [--to pass]
 *   [--refuse-country de,es,gb,in,it,nz] [--dry-run]
 */

import { readDirectoryEntries } from "@mailwoman/core/fs/readers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { join } from "path-ts"
import { JSONSpliterator, TextSpliterator } from "spliterator"

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
	throw new Error(`--to must be pass | improvement_target | known_fail, got ${JSON.stringify(status)}`)
}

const refused = new Set(
	values["refuse-country"]
		.split(",")
		.map((cc) => cc.trim().toLowerCase())
		.filter((cc) => cc.length > 0)
)

const wanted = new Set(
	await TextSpliterator.fromAsync(idsPath)
		.map((line) => line.trim())
		.filter((line) => line.length && !line.startsWith("#"))
		.toArray()
)

const countryDirectories = (await readDirectoryEntries(CASES_DIR))
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.toSorted()

// Read every case file first and validate the whole list against it. Nothing is written until the list is known to be
// good: a refusal that fires halfway through leaves some files promoted and some not, which is a worse state than
// either outcome and reads as a partial application nobody asked for.
const byPath = new Map<string, SeedCase[]>()
const found = new Map<string, string>()

for (const cc of countryDirectories) {
	const directory = join(CASES_DIR, cc)

	const files = (await readDirectoryEntries(directory))
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map((entry) => entry.name)
		.toSorted()

	for (const name of files) {
		const path = join(directory, name)

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
