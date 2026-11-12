// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A vintage is replaced only when the caller states it and forces the write,
 *   and a failed write leaves the existing vintage as it was.
 */

import { describe, expect, it } from "vitest"

import { readLocalTextFile } from "#fs/readers"
import { pathExists } from "#fs/readers/stat"
import { SnapshotExistsError, writeSnapshot } from "#fs/snapshot"
import { temporaryDirectory } from "#fs/temporary"
import { writeLocalFile } from "#fs/writers"

/**
 * Writes `text` as `data.txt` in a staging directory.
 */
function writes(text: string) {
	return async (staging: string) => writeLocalFile(text, `${staging}/data.txt`)
}

describe("writeSnapshot", () => {
	it("writes a new vintage", async () => {
		await using directory = await temporaryDirectory("snapshot-")
		const target = directory.path("juso-kr", "2026-08")

		await writeSnapshot(target, { vintageFromCaller: false }, writes("august"))

		expect(await readLocalTextFile(target("data.txt"))).toBe("august")
	})

	it("refuses an existing vintage without both a stated vintage and force", async () => {
		await using directory = await temporaryDirectory("snapshot-")
		const target = directory.path("juso-kr", "2026-08")

		await writeSnapshot(target, { vintageFromCaller: true }, writes("august"))

		await expect(writeSnapshot(target, { vintageFromCaller: true }, writes("again"))).rejects.toThrow(
			SnapshotExistsError
		)

		// A vintage the command resolved itself is never replaced, even with force.
		await expect(writeSnapshot(target, { vintageFromCaller: false, force: true }, writes("again"))).rejects.toThrow(
			"state the vintage with --vintage and pass --force"
		)

		expect(await readLocalTextFile(target("data.txt"))).toBe("august")
	})

	it("replaces an existing vintage when the caller states it and forces the write", async () => {
		await using directory = await temporaryDirectory("snapshot-")
		const target = directory.path("juso-kr", "2026-08")

		await writeSnapshot(target, { vintageFromCaller: true }, writes("august"))
		await writeSnapshot(target, { vintageFromCaller: true, force: true }, writes("corrected"))

		expect(await readLocalTextFile(target("data.txt"))).toBe("corrected")
	})

	it("keeps the existing vintage and leaves no staging directory when a forced write fails", async () => {
		await using directory = await temporaryDirectory("snapshot-")
		const target = directory.path("juso-kr", "2026-08")

		await writeSnapshot(target, { vintageFromCaller: true }, writes("august"))

		await expect(
			writeSnapshot(target, { vintageFromCaller: true, force: true }, async (staging) => {
				await writes("partial")(staging)

				throw new Error("the download ended early")
			})
		).rejects.toThrow("the download ended early")

		expect(await readLocalTextFile(target("data.txt"))).toBe("august")
		expect(await pathExists(`${target}.staging-${process.pid}`)).toBe(false)
	})
})
