/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phase-0 entry: walk the v1 parity suite, extract every `assert()` case, write
 *   `mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl`. Run from the repo root:
 *   `node mailwoman/dev-tools/extract-parity-corpus.run.ts`
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { writeJSONL } from "@mailwoman/core/utils"

import { extractAssertCalls, type ParityCase } from "./parity-extract.ts"

const TEST_DIR = "mailwoman/test"
const OUT_PATH = "mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl"

const cases: ParityCase[] = []
let parityFileCount = 0

for (const entry of readdirSync(TEST_DIR).sort()) {
	if (!entry.endsWith(".test.ts")) continue

	const path = join(TEST_DIR, entry)
	const text = readFileSync(path, "utf8")

	// Only the parity suite imports the shared rules-parser test-kit.
	if (!text.includes(`from "mailwoman/test-kit"`)) continue

	parityFileCount++
	cases.push(...extractAssertCalls(text, path))
}

const written = writeJSONL(OUT_PATH, cases)
const nonLiteralCount = cases.filter((c) => c.nonLiteral).length

console.error(
	`extracted ${written} assert() cases from ${parityFileCount} parity files (${nonLiteralCount} non-literal)`
)
