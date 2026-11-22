// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { versionSyncCheck } from "#repo-health/checks/version-sync"
import { plantFixtureRepository } from "#repo-health/test/fixture-repository"

/**
 * A root at 2.0.0 that releases two workspaces, the second at `version`.
 */
function releaseTree(version: string) {
	return {
		"package.json": { name: "fixture", version: "2.0.0" },
		".release-it.json": {
			plugins: { "@release-it-plugins/workspaces": { workspaces: ["packages/a", "packages/b"] } },
		},
		"packages/a/package.json": { name: "@fixture/a", version: "2.0.0" },
		"packages/b/package.json": { name: "@fixture/b", version },
	}
}

describe("versionSyncCheck", () => {
	it("reports the release workspace whose version differs from the root's", async () => {
		await using context = await plantFixtureRepository(releaseTree("1.9.0"))

		const diagnostics = await versionSyncCheck.run(context)

		expect(diagnostics.map((diagnostic) => diagnostic.file)).toEqual(["packages/b/package.json"])
	})

	it("accepts a tree whose release workspaces all hold the root's version", async () => {
		await using context = await plantFixtureRepository(releaseTree("2.0.0"))

		await expect(versionSyncCheck.run(context)).resolves.toEqual([])
	})
})
