/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phase-0: golden `/v1/parse` outcomes from the CURRENT (rules-backed) serve engine, captured at
 *   the engine layer (`createServeEngine().engine.parse`) — the semantic content of the endpoint.
 *   The route/wire wrapper is exercised by `@mailwoman/api`'s own tests, and the v7 swap changes
 *   the wire shape by design, so the gate built on this artifact compares components, not bytes.
 *   Run from the repo root: `node packages/mailwoman/lib/dev-tools/capture-v1-parse.run.ts`
 */

import { createNewlineWriter, JSONSpliterator, TextSpliterator } from "spliterator"

import { createServeEngine } from "#api-engine"
import type { ParityCase } from "#dev-tools/parity-extract"

const PARITY_PATH = "packages/mailwoman/lib/test-fixtures/legacy-golden/parity-inputs.jsonl"
const SYNTHETIC_PATH = "packages/mailwoman/lib/test-fixtures/legacy-golden/synthetic-inputs.txt"
const OUT_PATH = "packages/mailwoman/lib/test-fixtures/legacy-golden/v1-parse-golden.jsonl"

const parityInputs = await Array.fromAsync(JSONSpliterator.fromAsync<ParityCase>(PARITY_PATH), (c) => c.input)

const syntheticInputs = await Array.fromAsync(TextSpliterator.fromAsync(SYNTHETIC_PATH), (line) => line.trim())

const inputs = [...new Set([...parityInputs, ...syntheticInputs.filter((line) => line.length > 0)])]

const { engine, preflight } = await createServeEngine()

if (!preflight.ok) {
	// Degraded boot still serves /v1/parse (rules need no gazetteer) — fine for this capture.
	console.error("note: serve engine booted degraded (parse-only); capture proceeds")
}

if (!engine.parse) throw new Error("serve engine has no parse handler")

const rows: unknown[] = []

for (const input of inputs) {
	rows.push({ input, outcome: await engine.parse(input, { debug: false }) })
}

{
	await using out = createNewlineWriter(OUT_PATH)

	for (const row of rows) {
		await out.write(JSON.stringify(row))
	}
}

console.error(`captured ${rows.length} /v1/parse outcomes`)
