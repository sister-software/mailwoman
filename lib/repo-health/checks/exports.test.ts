// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The exports check's reading of a knip report.
 *
 *   The check spawns knip over the whole workspace graph, and a fixture directory can't hold that graph. These cases
 *   replace the spawned process with a planted report, so they cover what the check does with knip's answer and
 *   leave knip's own analysis of a tree to the run on this repository.
 *
 *   The check also reports each entry of its reviewed duplicate list that a report lacks, in a diagnostic with no
 *   file. A planted report holds none of those entries, so each case reads only the diagnostics that state a file.
 */

import { stringifyJSON } from "@mailwoman/core/values/json"
import { isPresent } from "@mailwoman/core/values/objects"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { RepoContext } from "#repo-health/check"

const mocks = vi.hoisted(() => ({ run: vi.fn() }))

vi.mock("@mailwoman/core/scripting/process", async (importOriginal) => ({
	...(await importOriginal<typeof import("@mailwoman/core/scripting/process")>()),
	runFile: mocks.run,
}))

const context: RepoContext = { repoRoot: "/checkout", trackedFiles: [] }

/**
 * One file's entry in a knip JSON report, empty except for the lists given.
 */
function issue(lists: { file: string } & Record<string, unknown>) {
	return {
		binaries: [],
		dependencies: [],
		devDependencies: [],
		duplicates: [],
		enumMembers: [],
		exports: [],
		files: [],
		namespaceMembers: [],
		optionalPeerDependencies: [],
		types: [],
		unlisted: [],
		unresolved: [],
		...lists,
	}
}

/**
 * The files the check reports when knip answers with `issues`.
 */
async function reportedFiles(...issues: Array<ReturnType<typeof issue>>): Promise<string[]> {
	mocks.run.mockResolvedValue({ stdout: stringifyJSON({ issues }), stderr: "" })

	const { exportsCheck } = await import("#repo-health/checks/exports")
	const diagnostics = await exportsCheck.run(context)

	return diagnostics.map((diagnostic) => diagnostic.file).filter(isPresent)
}

// Test files share one module graph per worker, so an earlier file may have
// loaded the check with the real process module.
// Each case loads the check again after the reset.
beforeEach(() => {
	vi.resetModules()
	mocks.run.mockReset()
})

// The next test file in this worker loads its modules without the replacement.
afterAll(() => {
	vi.resetModules()
})

describe("exportsCheck", () => {
	it("reports an unused export, an unused file and an unlisted dependency under the file knip gives", async () => {
		await expect(
			reportedFiles(
				issue({ file: "packages/a/lib/unused-export.ts", exports: [{ name: "orphan" }] }),
				issue({ file: "packages/a/lib/unused-file.ts", files: [{ name: "packages/a/lib/unused-file.ts" }] }),
				issue({ file: "packages/a/package.json", unlisted: [{ name: "left-pad" }] })
			)
		).resolves.toEqual(["packages/a/lib/unused-export.ts", "packages/a/lib/unused-file.ts", "packages/a/package.json"])
	})

	it("reports a duplicate export outside the reviewed list", async () => {
		await expect(
			reportedFiles(issue({ file: "packages/a/lib/twice.ts", duplicates: [[{ name: "first" }, { name: "second" }]] }))
		).resolves.toEqual(["packages/a/lib/twice.ts"])
	})

	it("reports no file when knip finds every file, dependency and export in use", async () => {
		await expect(reportedFiles(issue({ file: "packages/a/lib/used.ts" }))).resolves.toEqual([])
	})
})
