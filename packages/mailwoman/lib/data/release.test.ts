/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The release manifest reader: an absent file is legacy mode, and a present file it cannot use is an error naming
 *   the file.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { changeMode, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { UnreadableArtifactError } from "@mailwoman/core/layers"
import { describe, expect, it } from "vitest"

import { readReleaseManifest } from "#data/release"

describe("readReleaseManifest", () => {
	it("answers null when the data root has no releases.json", async () => {
		await using root = await temporaryDirectory("mw-release-absent-")

		expect(await readReleaseManifest(root.path)).toBeNull()
	})

	it("reads every pinned family", async () => {
		await using root = await temporaryDirectory("mw-release-valid-")

		await writeLocalJSONFile(
			{ "address-points": "2026-05-20.0", interpolation: "TIGER2023" },
			root.path("releases.json")
		)

		expect(await readReleaseManifest(root.path)).toEqual({
			"address-points": "2026-05-20.0",
			interpolation: "TIGER2023",
		})
	})

	it("names the file when it is not JSON", async () => {
		await using root = await temporaryDirectory("mw-release-malformed-")
		const path = root.path("releases.json")

		await writeLocalTextFile("{ not json", path)

		const read = readReleaseManifest(root.path)

		await expect(read).rejects.toThrow(UnreadableArtifactError)
		await expect(read).rejects.toThrow(`${path} is unreadable (corrupt)`)
	})

	it("names the file when it is not an object of version strings", async () => {
		await using root = await temporaryDirectory("mw-release-shape-")
		const path = root.path("releases.json")

		await writeLocalJSONFile(["2026-05-20.0"], path)
		await expect(readReleaseManifest(root.path)).rejects.toThrow(`${path} is unreadable (corrupt)`)

		await writeLocalJSONFile({ "address-points": "2026-05-20.0", interpolation: 2023 }, path)
		await expect(readReleaseManifest(root.path)).rejects.toThrow("family interpolation pins 2023")
	})

	// A process running as root reads a mode-000 file, so the case cannot fail there.
	it.skipIf(process.getuid?.() === 0)("names the file when it cannot be opened", async () => {
		await using root = await temporaryDirectory("mw-release-locked-")
		const path = root.path("releases.json")

		await writeLocalJSONFile({ "address-points": "2026-05-20.0" }, path)
		await changeMode(path, 0o000)

		try {
			await expect(readReleaseManifest(root.path)).rejects.toThrow(`${path} is unreadable (unopenable)`)
		} finally {
			await changeMode(path, 0o644)
		}
	})
})
