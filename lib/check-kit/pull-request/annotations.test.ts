// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The check-run annotation reader over recorded `gh api` output: the CodeQL alert of
 * check run 136612629639, a run with zero annotations, and a failed call.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { readCheckRunAnnotations } from "#check-kit/pull-request/annotations"

/**
 * The output of `gh api repos/sister-software/mailwoman/check-runs/136612629639/annotations --paginate --slurp`.
 */
async function codeQLOutput(): Promise<string> {
	return readLocalTextFile(repoRootPath("test", "fixtures", "check-kit", "check-run-annotations-codeql.json"))
}

describe("readCheckRunAnnotations", () => {
	it("returns each annotation's path, line, level, title and message", async () => {
		const output = await codeQLOutput()
		const calls: string[][] = []

		const reading = await readCheckRunAnnotations(136_612_629_639, async (args) => {
			calls.push(args)

			return output
		})

		expect(calls[0]?.[1]).toBe("repos/sister-software/mailwoman/check-runs/136612629639/annotations?per_page=100")

		expect(reading).toEqual({
			checkRunID: 136_612_629_639,
			read: true,
			annotations: [
				{
					path: "lib/dev-mcp/tools/sql.ts",
					startLine: 41,
					endLine: 41,
					level: "failure",
					title: "Inefficient regular expression",
					message: expect.stringContaining("exponential backtracking"),
				},
			],
		})
	})

	it("reads zero annotations as a read, empty list", async () => {
		expect(await readCheckRunAnnotations(1, async () => "[[]]")).toEqual({ checkRunID: 1, read: true, annotations: [] })
	})

	it("returns a failed call as unread with its error", async () => {
		const reading = await readCheckRunAnnotations(1, async () => {
			throw new Error("HTTP 404: Not Found")
		})

		expect(reading).toMatchObject({ checkRunID: 1, read: false, error: expect.stringContaining("HTTP 404") })
	})
})
