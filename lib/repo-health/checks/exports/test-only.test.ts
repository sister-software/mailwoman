// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The test-only export finder over a planted two-workspace tree: an export only a test imports, one a module
 *   imports, one another workspace reaches through the package entry, one a module loads with `import()`, and the
 *   published and `@public` cases.
 */

import { realPath } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePath } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

import { findTestOnlyExports, testOnlyExportsCheck } from "#repo-health/checks/exports/test-only"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const manifest = (name: string, published: boolean): string =>
	stringifyJSON({
		name,
		type: "module",
		...(published ? {} : { private: true }),
		exports: { ".": "./lib/index.ts", "./*": "./lib/*.ts" },
		imports: { "#*": "./lib/*.ts" },
	})

async function plant(files: Record<string, string>): Promise<{ repoRoot: string; trackedFiles: string[] }> {
	// TypeScript answers real paths, so the root must be one for resolved files to match tracked ones.
	const repoRoot = await realPath(fixtures.use(await temporaryDirectory("test-only-exports-")).path)

	for (const [file, text] of Object.entries(files)) {
		await makeDirectories(resolvePath(repoRoot, file.slice(0, file.lastIndexOf("/"))))
		await writeLocalTextFile(text, resolvePath(repoRoot, file))
	}

	await createSymbolicLink(resolvePath(repoRoot, "packages/a"), resolvePath(repoRoot, "node_modules/@fixture/a"))

	return { repoRoot, trackedFiles: Object.keys(files) }
}

const TREE: Record<string, string> = {
	"package.json": stringifyJSON({ name: "fixture-root", private: true, workspaces: ["packages/*"] }),
	"packages/a/package.json": manifest("@fixture/a", true),
	"packages/b/package.json": manifest("@fixture/b", false),
	"packages/a/lib/index.ts": 'export { viaEntry, published } from "#entry"\n',
	"packages/a/lib/entry.ts":
		"export function viaEntry(): number { return 1 }\nexport function published(): number { return 2 }\n",
	"packages/a/lib/only-test.ts":
		"export function onlyTest(): number { return 3 }\n/**\n * @public\n */\nexport function tagged(): number { return 4 }\n",
	"packages/a/lib/used.ts": "export function used(): number { return 5 }\n",
	"packages/a/lib/consumer.ts": 'import { used } from "#used"\n\nexport const value = used()\n',
	"packages/a/lib/dynamic.ts":
		"export function loaded(): number { return 6 }\nexport function notLoaded(): number { return 7 }\n",
	"packages/a/lib/loader.ts":
		'export async function load(): Promise<number> {\n\tconst [{ loaded }] = await Promise.all([import("#dynamic")])\n\n\treturn loaded()\n}\n',
	"packages/b/lib/index.ts": 'import { viaEntry } from "@fixture/a"\n\nexport const fromA = viaEntry()\n',
	"packages/a/lib/all.test.ts": [
		'import { viaEntry, published } from "@fixture/a"',
		'import { loaded, notLoaded } from "#dynamic"',
		'import { onlyTest, tagged } from "#only-test"',
		'import { used } from "#used"',
		"",
		"export const all = [viaEntry(), published(), loaded(), notLoaded(), onlyTest(), tagged(), used()]",
		"",
	].join("\n"),
}

describe("findTestOnlyExports", () => {
	it("reports what only tests import, and nothing a module, a package entry or an import() reaches", async () => {
		const context = await plant(TREE)
		const findings = await findTestOnlyExports(context)

		expect(findings.map(({ file, name, publicEntry }) => ({ file, name, publicEntry }))).toEqual([
			{ file: "packages/a/lib/dynamic.ts", name: "notLoaded", publicEntry: false },
			{ file: "packages/a/lib/entry.ts", name: "published", publicEntry: true },
			{ file: "packages/a/lib/only-test.ts", name: "onlyTest", publicEntry: false },
		])

		expect(findings.find((finding) => finding.name === "onlyTest")).toMatchObject({
			line: 1,
			testImporters: ["packages/a/lib/all.test.ts"],
			usedInModule: false,
		})
	})

	it("reports an internal export per site and the published ones in one separate diagnostic", async () => {
		const diagnostics = await testOnlyExportsCheck.run(await plant(TREE))
		const sited = diagnostics.filter((diagnostic) => diagnostic.file)

		expect(sited.map((diagnostic) => `${diagnostic.file}:${diagnostic.line}`)).toEqual([
			"packages/a/lib/dynamic.ts:2",
			"packages/a/lib/only-test.ts:1",
		])

		expect(diagnostics.filter((diagnostic) => !diagnostic.file).map((diagnostic) => diagnostic.details)).toEqual([
			["packages/a/lib/entry.ts:2 published"],
		])
	})
})
