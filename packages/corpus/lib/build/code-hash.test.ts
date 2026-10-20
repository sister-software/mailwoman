/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A code hash covers the modules its roots reach at runtime, and no others.
 *
 *   The fixture is a package of two producers, `a` and `b`. Only `a` imports `only-a` at runtime, `b` imports it
 *   for a type alone, and both import `shared`.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { wofAdminAdapter } from "#adapters/wof/admin/json/adapter"
import {
	adapterModules,
	corpusPackageDirectory,
	cruiseModuleGraph,
	moduleGraphHashes,
	reachableModules,
} from "#build/code-hash"
import { banAdapter } from "#fr/adapters/ban/adapter"

let scratch: TemporaryDirectory
let root: string

const SOURCES: Record<string, string> = {
	"lib/a.ts": `import { onlyA } from "#only-a"\nimport { shared } from "#shared"\nexport const a = onlyA + shared\n`,
	"lib/b.ts": `import type { OnlyA } from "#only-a"\nimport { shared } from "#shared"\nexport const b: OnlyA = shared\n`,
	"lib/only-a.ts": `export type OnlyA = number\nexport const onlyA = 1\n`,
	"lib/shared.ts": `export const shared = 2\n`,
}

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-code-hash-")
	root = scratch.path("fixture").toString()

	await writeLocalJSONFile(
		{ name: "fixture", type: "module", imports: { "#*": { node: "./lib/*.ts" } } },
		scratch.path("fixture", "package.json")
	)

	for (const [path, text] of Object.entries(SOURCES)) {
		await writeLocalTextFile(text, scratch.path("fixture", path))
	}
})

afterEach(async () => {
	await scratch[Symbol.asyncDispose]()
})

const hashes = () => moduleGraphHashes({ a: ["lib/a.ts"], b: ["lib/b.ts"] }, root)

describe("moduleGraphHashes", () => {
	it("follows runtime imports and leaves type-only imports out", async () => {
		const graph = await cruiseModuleGraph(["lib/a.ts", "lib/b.ts"], root)

		expect(reachableModules(graph, ["lib/a.ts"])).toEqual(["lib/a.ts", "lib/only-a.ts", "lib/shared.ts"])
		expect(reachableModules(graph, ["lib/b.ts"])).toEqual(["lib/b.ts", "lib/shared.ts"])
	})

	it("changes only the hash of the producer that imports an edited module", async () => {
		const before = await hashes()

		await writeLocalTextFile(
			`export type OnlyA = number\nexport const onlyA = 3\n`,
			scratch.path("fixture", "lib/only-a.ts")
		)

		const after = await hashes()

		expect(after.get("a")).not.toBe(before.get("a"))
		expect(after.get("b")).toBe(before.get("b"))
	})

	it("changes every producer's hash when a shared helper changes", async () => {
		const before = await hashes()

		await writeLocalTextFile(`export const shared = 4\n`, scratch.path("fixture", "lib/shared.ts"))

		const after = await hashes()

		expect(after.get("a")).not.toBe(before.get("a"))
		expect(after.get("b")).not.toBe(before.get("b"))
	})

	it("refuses a root outside lib/", async () => {
		await expect(moduleGraphHashes({ a: ["package.json"] }, root)).rejects.toThrow(/is not a module under/u)
	})
})

describe("adapterModules", () => {
	it("finds each registered adapter's module, and the two adapters' graphs differ", async () => {
		const modules = await adapterModules([banAdapter, wofAdminAdapter])

		expect(modules.get("ban")).toBe("lib/fr/adapters/ban/adapter.ts")
		expect(modules.get("wof-admin")).toBe("lib/adapters/wof/admin/json/adapter.ts")

		const graph = await cruiseModuleGraph([...modules.values()], corpusPackageDirectory())
		const ban = reachableModules(graph, [modules.get("ban")!])

		expect(ban).toContain("lib/fr/adapters/ban/adapter.ts")
		expect(ban).not.toContain("lib/adapters/wof/admin/json/adapter.ts")
	})
})
