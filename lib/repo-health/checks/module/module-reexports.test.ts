// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import ts from "typescript"
import { describe, expect, test } from "vitest"

import { isBarrelModule, moduleReexports, moduleReexportsCheck } from "#repo-health/checks/module/reexports"
import { plantFixtureRepository } from "#repo-health/test/fixture-repository"

function parse(text: string): ts.SourceFile {
	return ts.createSourceFile("module.ts", text, ts.ScriptTarget.Latest, true)
}

describe("module-reexports", () => {
	test("reports an internal re-export in a module that declares its own exports", () => {
		const source = parse(
			[
				'export type { AddressPointLookup } from "#resolver/lookup-types"',
				"export interface ResolveOpts { maxLookups: number }",
			].join("\n")
		)

		expect(moduleReexports("packages/core/lib/resolver/types.ts", source)).toEqual([
			{ file: "packages/core/lib/resolver/types.ts", line: 1, specifier: "#resolver/lookup-types" },
		])
	})

	test("leaves a pure barrel and an external facade alone", () => {
		expect(moduleReexports("x.ts", parse('export * from "#a"\nexport { b } from "./b.ts"'))).toEqual([])

		expect(
			moduleReexports("x.ts", parse('export { createHash } from "node:crypto"\nexport function sha() {}'))
		).toEqual([])
	})

	test("counts a local export list as the module's own export", () => {
		expect(moduleReexports("x.ts", parse('const a = 1\nexport { a }\nexport * from "#b"'))).toHaveLength(1)
	})

	test("recognizes the directory barrels", () => {
		const directories = new Set(["packages/core/lib/resolver", "packages/core/lib/resolver/types"])

		expect(isBarrelModule("packages/core/lib/resolver.ts", directories)).toBe(true)
		expect(isBarrelModule("packages/core/lib/index.ts", directories)).toBe(true)
		expect(isBarrelModule("packages/core/lib/coarse-placer/coarse-placer.ts", directories)).toBe(true)
		// A nested `<dir>.ts` is an ordinary module.
		expect(isBarrelModule("packages/core/lib/resolver/types.ts", directories)).toBe(false)
	})

	const REEXPORTING = 'export { lookup } from "#lookup"\nexport const limit = 4\n'

	test("the check reports a tracked module that declares an export and re-exports another module's", async () => {
		await using context = await plantFixtureRepository({
			"packages/a/lib/resolver/types.ts": REEXPORTING,
			"packages/a/lib/lookup.ts": "export const lookup = (id: string) => id\n",
		})

		const diagnostics = await moduleReexportsCheck.run(context)

		expect(diagnostics.map((diagnostic) => [diagnostic.file, diagnostic.line])).toEqual([
			["packages/a/lib/resolver/types.ts", 1],
		])
	})

	test("the check accepts the same text in a package's root barrel", async () => {
		await using context = await plantFixtureRepository({
			"packages/a/lib/index.ts": REEXPORTING,
			"packages/a/lib/lookup.ts": "export const lookup = (id: string) => id\n",
		})

		await expect(moduleReexportsCheck.run(context)).resolves.toEqual([])
	})
})
