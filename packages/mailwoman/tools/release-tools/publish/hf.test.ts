// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The integrity table `mailwoman release hf` writes into a release entry, read back by the browser runtime.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { describe, expect, it } from "vitest"

import { artifactMismatch, readArtifactIntegrityTable } from "#browser-runtime/integrity"
import { releaseArtifactIntegrity } from "#tools/release-tools/publish/hf"

describe("releaseArtifactIntegrity", () => {
	it("records each upload's length and sha256 under its served name, in a form the runtime reads back", async () => {
		await using directory = await temporaryDirectory("mw-hf-integrity-")
		const model = directory.path("model.onnx")
		const anchors = directory.path("postcode-us.bin")

		await writeLocalTextFile("model bytes", model)
		await writeLocalTextFile("postcode", anchors)

		const table = await releaseArtifactIntegrity([
			{ remoteName: "model.onnx", localPath: model.toString() },
			{ remoteName: "postcode-us.bin", localPath: anchors.toString() },
		])

		expect(table).toEqual({
			"model.onnx": { bytes: 11, sha256: sha256Hex("model bytes") },
			"postcode-us.bin": { bytes: 8, sha256: sha256Hex("postcode") },
		})

		// The table crosses the wire as JSON, so the reader is given the parsed text the bucket serves.
		const read = readArtifactIntegrityTable(parseJSONStrict(stringifyJSON(table)), "vX")

		expect(read).toEqual(table)
		await expect(artifactMismatch(new TextEncoder().encode("model bytes"), read!["model.onnx"]!)).resolves.toBeNull()
	})

	it("accepts the same file uploaded twice and refuses two different files served under one name", async () => {
		await using directory = await temporaryDirectory("mw-hf-integrity-")
		const first = directory.path("a", "fst-en-US.bin")
		const second = directory.path("b", "fst-en-US.bin")

		await writeLocalTextFile("one", first)
		await writeLocalTextFile("two", second)

		await expect(
			releaseArtifactIntegrity([
				{ remoteName: "fst-en-US.bin", localPath: first.toString() },
				{ remoteName: "fst-en-US.bin", localPath: first.toString() },
			])
		).resolves.toHaveProperty(["fst-en-US.bin", "bytes"], 3)

		await expect(
			releaseArtifactIntegrity([
				{ remoteName: "fst-en-US.bin", localPath: first.toString() },
				{ remoteName: "fst-en-US.bin", localPath: second.toString() },
			])
		).rejects.toThrow(/different contents are served as fst-en-US\.bin/)
	})
})
