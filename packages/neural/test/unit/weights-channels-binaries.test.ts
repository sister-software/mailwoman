/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What `packageHasBinaries` accepts, and the half-materialized directory it refuses.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { packageHasBinaries } from "@mailwoman/neural/weights-channels"
import { resolvePath } from "path-ts"
import { describe, expect, it } from "vitest"

async function weightsPackage(files: Record<string, string>, card?: Record<string, unknown>) {
	const directory = await temporaryDirectory("weights-channels-")

	for (const [name, content] of Object.entries(files)) {
		await writeLocalTextFile(content, resolvePath(directory.path, name))
	}

	if (card) {
		await writeLocalJSONFile(card, resolvePath(directory.path, "model-card.json"))
	}

	return directory.moveWith({ directory: String(directory.path) })
}

describe("packageHasBinaries", () => {
	it("accepts a Latin package on its tokenizer alone", async () => {
		await using pkg = await weightsPackage({ "model.onnx": "onnx", "tokenizer.model": "sp" })

		expect(await packageHasBinaries(pkg.directory)).toBe(true)
	})

	it("accepts a char package whose card declares the vocabulary it ships", async () => {
		await using pkg = await weightsPackage(
			{ "model.onnx": "onnx", "char-vocab.json": "{}" },
			{ encoder: "char", char_vocab: "char-vocab.json", max_units: 64, max_unit_width: 4, char_ctx: 8 }
		)

		expect(await packageHasBinaries(pkg.directory)).toBe(true)
	})

	it("refuses a character vocabulary whose card does not declare a char encoder", async () => {
		// The shape a half-materialized overlay takes: the model and its vocabulary link, the card does not. Answering
		// `false` loads this as a Latin model, and a bare kanji line parses as one locality.
		await using pkg = await weightsPackage({ "model.onnx": "onnx", "char-vocab.json": "{}" })

		await expect(packageHasBinaries(pkg.directory)).rejects.toThrow(/char-vocab\.json is present/)
	})

	it("answers false for a directory carrying neither tokenizer nor vocabulary", async () => {
		await using pkg = await weightsPackage({ "model.onnx": "onnx" })

		expect(await packageHasBinaries(pkg.directory)).toBe(false)
	})
})
