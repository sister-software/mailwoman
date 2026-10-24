/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `ledgerAppend` records the graded model's tokenizer md5 from its card, and leaves the field out
 *   when the card records none.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { afterAll, beforeAll, expect, test } from "vitest"

import { ledgerAppend } from "#tools/eval-harness/ledger-append"

let root: TemporaryDirectory

beforeAll(async () => {
	root = await temporaryDirectory("ledger-append-")

	await writeLocalJSONFile(
		{
			label: "promote",
			graded_artifact: "model.onnx",
			verdict: "PASS",
			results: { "us.micro": { floor: 0.9, actual: 0.95, pass: true } },
		},
		root.path("out", "verdict.json")
	)
})

afterAll(() => root[Symbol.asyncDispose]())

async function appendWith(card: object, name: string) {
	const cardPath = root.path(`${name}-card.json`)
	const ledgerPath = root.path(`${name}-ledger.json`)

	await writeLocalJSONFile(card, cardPath)
	await writeLocalJSONFile({ schema_version: 1, runs: [] }, ledgerPath)

	const status = await ledgerAppend({
		outDir: root.path("out").toString(),
		modelVersion: "1.0.0",
		runId: "run-1",
		modelPath: "@mailwoman/neural-weights-en-us@1.0.0",
		card: cardPath.toString(),
		ledger: ledgerPath.toString(),
	})

	const ledger = await readLocalJSONFile<{ runs: Array<Record<string, unknown>> }>(ledgerPath)

	return { status, row: ledger.runs[0]! }
}

test("records the card's tokenizer md5 on the row", async () => {
	const md5 = "5c01cdcd4ae25849c5cb26b69fd3dde9"
	const { status, row } = await appendWith({ files_md5: { "tokenizer.model": md5 } }, "with")

	expect(status).toBe(0)
	expect(row["tokenizer_md5"]).toBe(md5)
})

test("leaves tokenizer_md5 out when the card records no digest", async () => {
	const { status, row } = await appendWith({ training: { steps: 10 } }, "without")

	expect(status).toBe(0)
	expect(row).not.toHaveProperty("tokenizer_md5")
})
