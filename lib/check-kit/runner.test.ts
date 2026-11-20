// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The runner propagates a failing command's exit status and writes its output to the log it names.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { findCheckCommand } from "#check-kit/registry"
import { runCheck } from "#check-kit/runner"

describe("runCheck", () => {
	it("returns the command's exit status and keeps its output in the log", async () => {
		await using scratch = await temporaryDirectory("runner-test-")

		const run = await runCheck(findCheckCommand("prose-code")!, {
			checkout: repoRootPath(),
			logDirectory: scratch.path().toString(),
			executable: process.execPath,
			argsOverride: ["-e", "console.log('✖ 0 errors, 0 warnings and 0 suggestions in 1 file.'); process.exit(3)"],
		})

		expect(run.exitCode).toBe(3)
		expect(run.signal).toBeNull()
		expect(await readLocalTextFile(run.logPath)).toContain("0 errors, 0 warnings")
		// A failing exit that no output line explains is unparsed, never zero errors.
		expect(run.parsed).toMatchObject({ parsed: false, errors: null })
	})
})
