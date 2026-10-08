/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import ts from "typescript"
import { describe, expect, test } from "vitest"

import { isBarrelModule, moduleReexports } from "#repo-health/checks/module/reexports"

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
})
