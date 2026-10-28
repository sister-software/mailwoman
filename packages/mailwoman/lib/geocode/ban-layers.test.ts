/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { banDatabaseRoot } from "@mailwoman/ban/paths"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { changeMode, makeDirectories } from "@mailwoman/core/fs/writers"
import { describe, expect, it } from "vitest"

import { openBANRegionDatabases } from "#geocode/ban-layers"

describe("openBANRegionDatabases", () => {
	it("opens a provider that answers no extract for a data root with none built", async () => {
		await using root = await temporaryDirectory("mw-ban-empty-")

		using provider = await openBANRegionDatabases(root.path)

		expect(provider.for("fr")).toEqual({})
	})

	// A process running as root reads a mode-000 directory, so the case cannot fail there.
	it.skipIf(process.getuid?.() === 0)("raises when the extract directory cannot be read", async () => {
		await using root = await temporaryDirectory("mw-ban-locked-")
		const directory = banDatabaseRoot(root.path)

		await makeDirectories(directory)
		await changeMode(directory, 0o000)

		try {
			await expect(openBANRegionDatabases(root.path)).rejects.toThrow("EACCES")
		} finally {
			await changeMode(directory, 0o755)
		}
	})
})
