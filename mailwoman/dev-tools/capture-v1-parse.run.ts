/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phase-0: golden `/v1/parse` outcomes from the CURRENT (rules-backed) serve engine, captured at
 *   the engine layer (`createServeEngine().engine.parse`) — the semantic content of the endpoint.
 *   The route/wire wrapper is exercised by `@mailwoman/api`'s own tests, and the v7 swap changes
 *   the wire shape by design, so the gate built on this artifact compares components, not bytes.
 *   Run from the repo root: `node mailwoman/dev-tools/capture-v1-parse.run.ts`
 */

import { readFileSync } from "node:fs"

import { readJSONL, writeJSONL } from "@mailwoman/core/utils"

import { createServeEngine } from "../api-engine.ts"
import { type ParityCase } from "./parity-extract.ts"

const PARITY_PATH = "mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl"
const SYNTHETIC_PATH = "mailwoman/test-fixtures/legacy-golden/synthetic-inputs.txt"
const OUT_PATH = "mailwoman/test-fixtures/legacy-golden/v1-parse-golden.jsonl"

const parityInputs = readJSONL<ParityCase>(PARITY_PATH).map((c) => c.input)
const syntheticInputs = readFileSync(SYNTHETIC_PATH, "utf8")
	.split("\n")
	.map((line) => line.trim())
	.filter(Boolean)

const inputs = [...new Set([...parityInputs, ...syntheticInputs])]

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

writeJSONL(OUT_PATH, rows)
console.error(`captured ${rows.length} /v1/parse outcomes`)
