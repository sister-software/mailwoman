/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phase-0: replay every parity input through the v1 rules parser and commit the raw solved
 *   output. This is the triage artifact for the parity-corpus conversion — it distinguishes
 *   "the neural parse changed" from "the hand-written assertion encoded a rules idiosyncrasy".
 *   Run from the repo root: `node mailwoman/dev-tools/capture-parity-raw.run.ts`
 */

import { readJSONL, writeJSONL } from "@mailwoman/core/utils"
import { createAddressParser } from "mailwoman"

import { type ParityCase } from "./parity-extract.ts"

const IN_PATH = "mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl"
const OUT_PATH = "mailwoman/test-fixtures/legacy-golden/parity-raw.jsonl"

const parser = createAddressParser()
const cases = readJSONL<ParityCase>(IN_PATH)
const rows: unknown[] = []

for (const parityCase of cases) {
	const result = await parser.parse(parityCase.input, { verbose: true })

	rows.push({
		file: parityCase.file,
		input: parityCase.input,
		expected: parityCase.expected,
		solutions: result.solutions.slice(0, 3).map((solution) => solution.toJSON()),
	})
}

writeJSONL(OUT_PATH, rows)
console.error(`captured raw rules output for ${rows.length} parity cases`)
