/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { afterEach, describe, expect, it, vi } from "vitest"

import { refuseShareAlike } from "./upload.tsx"

const SHARE_ALIKE = { "ODbL-1.0": 10 }
const CLEAN = { "CC0-1.0": 10 }

afterEach(() => {
	vi.restoreAllMocks()
})

describe("corpus upload share-alike check", () => {
	it("reads the nested corpus manifest of an overlay corpus that has no build manifest", async () => {
		await using root = await temporaryDirectory("mailwoman-upload-")
		const entry = root.path("v1")
		const source = entry("corpus-v1")

		await makeDirectories(source)
		await writeLocalJSONFile({ total_rows: 10, licenses: SHARE_ALIKE }, source("MANIFEST.json"))

		await expect(refuseShareAlike("v1", { layout: "nested", entry, source }, false)).rejects.toThrow(/share-alike/)

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)

		await refuseShareAlike("v1", { layout: "nested", entry, source }, true)

		expect(String(stderr.mock.calls[0]?.[0])).toMatch(/uploading 10 rows under --allow-share-alike/)
	})

	it("refuses a nested overlay corpus whose manifest records no license set unless the flag is set", async () => {
		await using root = await temporaryDirectory("mailwoman-upload-")
		const entry = root.path("v1")
		const source = entry("corpus-v1")

		await makeDirectories(source)
		await writeLocalJSONFile({ total_rows: 10 }, source("MANIFEST.json"))

		await expect(refuseShareAlike("v1", { layout: "nested", entry, source }, false)).rejects.toThrow(
			/record no `licenses` map/
		)

		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)

		await refuseShareAlike("v1", { layout: "nested", entry, source }, true)

		expect(String(stderr.mock.calls[0]?.[0])).toMatch(/nested-layout upload is unrecorded/)
	})

	it("reads the build manifest beside a nested build output for the license set and row coverage", async () => {
		await using root = await temporaryDirectory("mailwoman-upload-")
		const entry = root.path("v1")
		const source = entry("corpus-v1")

		await makeDirectories(source)
		await writeLocalJSONFile({ total_rows: 10 }, source("MANIFEST.json"))
		await writeLocalJSONFile({ licenses: CLEAN, total_aligned_rows: 10 }, entry("MANIFEST.json"))

		await expect(refuseShareAlike("v1", { layout: "nested", entry, source }, false)).resolves.toBeUndefined()

		await writeLocalJSONFile({ total_rows: 15 }, source("MANIFEST.json"))

		await expect(refuseShareAlike("v1", { layout: "nested", entry, source }, false)).rejects.toThrow(
			/5 rows were merged by `overlay-manifest`/
		)
	})

	it("reads the flat entry's own manifest", async () => {
		await using root = await temporaryDirectory("mailwoman-upload-")
		const entry = root.path("v1")

		await makeDirectories(entry)
		await writeLocalJSONFile({ licenses: CLEAN }, entry("MANIFEST.json"))

		await expect(refuseShareAlike("v1", { layout: "flat", entry, source: entry }, false)).resolves.toBeUndefined()

		await writeLocalJSONFile({ licenses: SHARE_ALIKE }, entry("MANIFEST.json"))

		await expect(refuseShareAlike("v1", { layout: "flat", entry, source: entry }, false)).rejects.toThrow(
			/share-alike over 10 rows/
		)
	})

	it("refuses an absent or unparsable manifest even under --allow-share-alike", async () => {
		await using root = await temporaryDirectory("mailwoman-upload-")
		const entry = root.path("v1")
		const source = entry("corpus-v1")

		await makeDirectories(source)

		for (const allow of [false, true]) {
			await expect(refuseShareAlike("v1", { layout: "nested", entry, source }, allow)).rejects.toThrow(
				/corpus-v1\/MANIFEST\.json could not be read/
			)

			await expect(refuseShareAlike("v1", { layout: "flat", entry, source: entry }, allow)).rejects.toThrow(
				/v1\/MANIFEST\.json could not be read/
			)
		}

		await writeLocalJSONFile({ total_rows: 10, licenses: CLEAN }, source("MANIFEST.json"))
		await writeLocalTextFile("{ not json", entry("MANIFEST.json"))

		await expect(refuseShareAlike("v1", { layout: "nested", entry, source }, true)).rejects.toThrow(
			/v1\/MANIFEST\.json could not be read/
		)
	})
})
