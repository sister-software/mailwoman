/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A code hash covers the code its roots reach at runtime, and no other.
 *
 *   The fixture is a repository with two workspaces. In `packages/app`, two producers `a` and `b` both import
 *   `shared`. Only `a` imports `only-a` at runtime, while `b` imports it only for a type. `a` also imports the
 *   `@fixture/helper` workspace and the third-party `leftpad`, whose version `yarn.lock` records.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/paths"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { osmAdapter } from "#adapters/osm/adapter"
import { wofAdminAdapter } from "#adapters/wof/admin/json/adapter"
import { adapterModules, cruiseModuleGraph, moduleGraphHashes, reachableModules } from "#build/code-hash"
import { banAdapter } from "#fr/adapters/ban/adapter"

let scratch: TemporaryDirectory
let root: string

const FILES: Record<string, string> = {
	"dependency-cruiser.config.mjs":
		'export default { options: { enhancedResolveOptions: { conditionNames: ["node", "import", "default"], ' +
		'exportsFields: ["exports"] } } }\n',
	"packages/app/lib/a.ts":
		`import { onlyA } from "#only-a"\nimport { shared } from "#shared"\nimport { helper } from "@fixture/helper/helper"\n` +
		`import leftpad from "leftpad"\nexport const a = leftpad(String(onlyA + shared + helper))\n`,
	"packages/app/lib/b.ts": `import type { OnlyA } from "#only-a"\nimport { shared } from "#shared"\nexport const b: OnlyA = shared\n`,
	"packages/app/lib/only-a.ts": `export type OnlyA = number\nexport const onlyA = 1\n`,
	"packages/app/lib/shared.ts": `export const shared = 2\n`,
	"packages/helper/lib/helper.ts": `export const helper = 3\n`,
	"node_modules/leftpad/index.js": `export default function leftpad(value) { return value }\n`,
}

const lockfile = (version: string) =>
	`__metadata:\n  version: 10\n\n"leftpad@npm:^1.0.0":\n  version: ${version}\n  resolution: "leftpad@npm:${version}"\n`

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-code-hash-")
	root = scratch.path("repo").toString()

	for (const [path, text] of Object.entries(FILES)) {
		await writeLocalTextFile(text, scratch.path("repo", path))
	}

	await writeLocalJSONFile(
		{ name: "@fixture/app", type: "module", imports: { "#*": { node: "./lib/*.ts" } } },
		scratch.path("repo", "packages/app/package.json")
	)

	await writeLocalJSONFile(
		{ name: "@fixture/helper", type: "module", exports: { "./*": { node: "./lib/*.ts" } } },
		scratch.path("repo", "packages/helper/package.json")
	)

	await writeLocalJSONFile(
		{ name: "leftpad", version: "1.0.0", type: "module", main: "index.js" },
		scratch.path("repo", "node_modules/leftpad/package.json")
	)

	await createSymbolicLink(
		scratch.path("repo", "packages/helper"),
		scratch.path("repo", "node_modules/@fixture/helper")
	)

	await writeLocalTextFile(lockfile("1.0.0"), scratch.path("repo", "yarn.lock"))
})

afterEach(async () => {
	await scratch[Symbol.asyncDispose]()
})

const A = "packages/app/lib/a.ts"
const B = "packages/app/lib/b.ts"
const hashes = () => moduleGraphHashes({ a: [A], b: [B] }, root)

describe("moduleGraphHashes", () => {
	it("follows runtime imports into other workspaces, stops at third-party packages, and skips type-only imports", async () => {
		const graph = await cruiseModuleGraph([A, B], root)

		expect(reachableModules(graph, [A])).toEqual({
			modules: [A, "packages/app/lib/only-a.ts", "packages/app/lib/shared.ts", "packages/helper/lib/helper.ts"],
			packages: ["node_modules/leftpad"],
		})

		expect(reachableModules(graph, [B])).toEqual({ modules: [B, "packages/app/lib/shared.ts"], packages: [] })
	})

	it("changes only the hash of the producer that imports an edited module", async () => {
		const before = await hashes()

		await writeLocalTextFile(
			`export type OnlyA = number\nexport const onlyA = 4\n`,
			scratch.path("repo", "packages/app/lib/only-a.ts")
		)

		const after = await hashes()

		expect(after.get("a")).not.toBe(before.get("a"))
		expect(after.get("b")).toBe(before.get("b"))
	})

	it("changes every producer's hash when a shared helper changes", async () => {
		const before = await hashes()

		await writeLocalTextFile(`export const shared = 5\n`, scratch.path("repo", "packages/app/lib/shared.ts"))

		const after = await hashes()

		expect(after.get("a")).not.toBe(before.get("a"))
		expect(after.get("b")).not.toBe(before.get("b"))
	})

	it("changes a producer's hash when a module of another workspace it imports changes", async () => {
		const before = await hashes()

		await writeLocalTextFile(`export const helper = 6\n`, scratch.path("repo", "packages/helper/lib/helper.ts"))

		const after = await hashes()

		expect(after.get("a")).not.toBe(before.get("a"))
		expect(after.get("b")).toBe(before.get("b"))
	})

	it("pins a third-party package by its locked version", async () => {
		const before = await hashes()

		await writeLocalJSONFile(
			{ name: "leftpad", version: "1.1.0", type: "module", main: "index.js" },
			scratch.path("repo", "node_modules/leftpad/package.json")
		)

		await expect(hashes()).rejects.toThrow(/leftpad@npm:1.1.0, which yarn.lock does not record/u)

		await writeLocalTextFile(lockfile("1.1.0"), scratch.path("repo", "yarn.lock"))

		const after = await hashes()

		expect(after.get("a")).not.toBe(before.get("a"))
		expect(after.get("b")).toBe(before.get("b"))
	})

	it("refuses a root outside packages/", async () => {
		await expect(moduleGraphHashes({ a: ["yarn.lock"] }, root)).rejects.toThrow(/is not a workspace module/u)
	})
})

describe("adapterModules", () => {
	it("keeps each adapter out of another source's reach, the OSM adapter included", async () => {
		const modules = await adapterModules([banAdapter, wofAdminAdapter, osmAdapter])

		expect(modules.get("ban")).toBe("packages/corpus/lib/fr/adapters/ban/adapter.ts")
		expect(modules.get("osm")).toBe("packages/corpus/lib/adapters/osm/adapter.ts")

		const build = "packages/corpus/lib/build.ts"
		const graph = await cruiseModuleGraph([build, ...modules.values()], repoRootPath())
		const reach = (id: string) => reachableModules(graph, [build, modules.get(id)!]).modules

		expect(reach("ban")).toContain(modules.get("ban"))
		expect(reach("ban")).not.toContain(modules.get("osm"))
		expect(reach("wof-admin")).not.toContain(modules.get("osm"))
		expect(reach("osm")).toContain(modules.get("osm"))
		expect(reach("ban")).not.toContain(modules.get("wof-admin"))
	})
})
