// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { afterAll, describe, expect, it } from "vitest"

import { roleSuffixesCheck } from "#repo-health/checks/role-suffixes"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function reported(files: Record<string, string>): Promise<string[]> {
	const root = fixtures.use(await temporaryDirectory("role-suffixes-")).path

	for (const [file, text] of Object.entries(files)) {
		await makeDirectories(root(file.slice(0, file.lastIndexOf("/"))))
		await writeLocalTextFile(text, root(file))
	}

	const diagnostics = await roleSuffixesCheck.run({ repoRoot: root.toString(), trackedFiles: Object.keys(files) })

	// The check reports in the order the tracked files are listed.
	// A caller doesn't rely on that order.
	return diagnostics.map((diagnostic) => `${diagnostic.file}:${diagnostic.line}`).toSorted()
}

describe("roleSuffixesCheck", () => {
	it("reports a class whose suffix states a role its clauses don't declare", async () => {
		await expect(
			reported({
				"packages/a/lib/postcode.ts": "export class PostcodeBinaryResolver {}\n",
				"packages/a/lib/http.ts": "class Base {}\nexport class WeatherClient extends Base {}\n",
				"packages/a/lib/regions.ts": "export class RegionProvider implements Disposable {}\n",
			})
		).resolves.toEqual(["packages/a/lib/http.ts:2", "packages/a/lib/postcode.ts:1", "packages/a/lib/regions.ts:1"])
	})

	it("accepts a class that declares its role, with or without type arguments", async () => {
		await expect(
			reported({
				"packages/a/lib/remote.ts": "export class RemoteResolver implements Resolver {}\n",
				"packages/a/lib/http.ts": "export class WeatherClient extends APIClient<WeatherConfig> {}\n",
				"packages/a/lib/regions.ts":
					"export class StateProvider implements RegionDatabaseProvider<string, Databases> {}\n",
				"packages/a/lib/postcode.ts": "export class PostcodeBinaryLookup {}\n",
			})
		).resolves.toEqual([])
	})

	it("leaves the role's own base, an unexported class and a marked class alone", async () => {
		await expect(
			reported({
				"packages/a/lib/api.ts": "export class APIClient {}\n",
				"packages/a/lib/local.ts": "class ScratchResolver {}\nexport const scratch = new ScratchResolver()\n",
				"packages/a/lib/kept.ts":
					"// repo-health-ignore role-suffixes -- the upstream SDK's own name for this class\nexport class VendorClient {}\n",
			})
		).resolves.toEqual([])
	})
})
