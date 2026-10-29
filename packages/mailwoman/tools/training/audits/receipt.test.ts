/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import { asPythonFloat } from "@mailwoman/core/strings/python-json"
import type { PathBuilderLike } from "path-ts"
import { expect, test } from "vitest"

import {
	auditReportText,
	mostCommon,
	preflightKey,
	PreflightReceiptError,
	verifyPreflightReceipt,
	writePreflightReceipt,
} from "./receipt.ts"

async function corpus(directory: PathBuilderLike, files: Array<{ path: string; sha256?: string }>, indent = 0) {
	const config = `${directory}/config.yaml`

	await writeLocalTextFile("data:\n  corpus_dir: x\n", config)
	const text = indent ? prettyJSON({ files }, false, indent) : stringifyJSON({ files })

	await writeLocalTextFile(text, `${directory}/corpus/MANIFEST.json`)

	return { config, corpusDir: `${directory}/corpus` }
}

test("a report is json.dumps(report, indent=2)", () => {
	expect(auditReportText({ share: asPythonFloat(0.5), rows: 3, empty: {} })).toBe(
		'{\n  "share": 0.5,\n  "rows": 3,\n  "empty": {}\n}'
	)
})

test("most_common breaks ties by first appearance", () => {
	expect(
		mostCommon(
			new Map([
				["a", 1],
				["b", 2],
				["c", 2],
			])
		)
	).toEqual([
		["b", 2],
		["c", 2],
		["a", 1],
	])
})

test("the key ignores manifest order and formatting and moves with a digest or the config", async () => {
	await using one = await temporaryDirectory()
	await using two = await temporaryDirectory()

	const a = await corpus(one.path, [
		{ path: "a.parquet", sha256: "aa" },
		{ path: "b.parquet", sha256: "bb" },
	])

	const b = await corpus(
		two.path,
		[
			{ path: "b.parquet", sha256: "bb" },
			{ path: "a.parquet", sha256: "aa" },
		],
		2
	)

	expect(await preflightKey(a.config, a.corpusDir)).toBe(await preflightKey(b.config, b.corpusDir))

	await writeLocalTextFile(
		stringifyJSON({ files: [{ path: "a.parquet", sha256: "ab" }] }),
		`${b.corpusDir}/MANIFEST.json`
	)

	expect(await preflightKey(a.config, a.corpusDir)).not.toBe(await preflightKey(b.config, b.corpusDir))
})

test("an entry without a digest cannot be bound", async () => {
	await using directory = await temporaryDirectory()
	const { config, corpusDir } = await corpus(directory.path, [{ path: "a.parquet" }])

	await expect(preflightKey(config, corpusDir)).rejects.toThrow("with no sha256")
})

test("a written receipt verifies, and the GPU run refuses a missing token, other bytes or a missing audit", async () => {
	await using directory = await temporaryDirectory()
	const { config, corpusDir } = await corpus(directory.path, [{ path: "a.parquet", sha256: "aa" }])
	const root = `${directory.path}/audits`
	const key = await writePreflightReceipt(root, config, corpusDir, ["corpus_receipts"], {})

	await verifyPreflightReceipt(root, config, corpusDir, key, ["corpus_receipts"])
	await expect(verifyPreflightReceipt(root, config, corpusDir, "", [])).rejects.toBeInstanceOf(PreflightReceiptError)
	await expect(verifyPreflightReceipt(root, config, corpusDir, "f".repeat(64), [])).rejects.toThrow("other config")

	await expect(verifyPreflightReceipt(root, config, corpusDir, key, ["validation_coverage"])).rejects.toThrow(
		"records no pass for ['validation_coverage']"
	)
})
