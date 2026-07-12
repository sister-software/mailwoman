/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phase-0: golden `/parse` wire responses from the CURRENT (rules-backed) libpostal drop-in,
 *   captured in-process via Hono's `app.request()` — exact bytes of the compatibility contract.
 *   The engine below mirrors `cli.ts`'s `serve()` wiring verbatim. Run from the repo root:
 *   `node libpostal/dev-tools/capture-parse-golden.run.ts`
 */

import { readFileSync, writeFileSync } from "node:fs"

import { createAddressParser } from "mailwoman"

import { createLibpostalApp, type LibpostalEngine, type ParseMatch } from "../index.ts"

const PARITY_PATH = "mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl"
const SYNTHETIC_PATH = "mailwoman/test-fixtures/legacy-golden/synthetic-inputs.txt"
const OUT_PATH = "libpostal/test-fixtures/parse-golden.jsonl"

const parityInputs = readFileSync(PARITY_PATH, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => (JSON.parse(line) as { input: string }).input)
const syntheticInputs = readFileSync(SYNTHETIC_PATH, "utf8")
	.split("\n")
	.map((line) => line.trim())
	.filter(Boolean)

const inputs = [...new Set([...parityInputs, ...syntheticInputs])]

// Mirrors cli.ts serve() — the /parse leg only (expand is normalize-backed and doesn't change in v7).
const parser = createAddressParser()
const engine: LibpostalEngine = {
	async parse(query) {
		const result = await parser.parse(query, { verbose: true })
		const solution = result.solutions[0]

		if (!solution) return []
		const json = solution.toJSON() as { matches?: ParseMatch[] }

		return (json.matches ?? []).map((m) => ({ classification: m.classification, value: m.value }))
	},
}

const app = createLibpostalApp(engine)
const rows: string[] = []

for (const input of inputs) {
	const res = await app.request(`/parse?query=${encodeURIComponent(input)}`)

	rows.push(JSON.stringify({ input, status: res.status, body: await res.json() }))
}

writeFileSync(OUT_PATH, rows.join("\n") + "\n")
console.error(`captured ${rows.length} libpostal /parse responses`)
