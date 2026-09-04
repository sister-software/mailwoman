/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	assertNoSourceTargets,
	collectExportTargets,
	transformExportsForPublish,
	transformImportsForPublish,
} from "#pack/publish-exports"

// Source lives under `lib/`, so a real dev map's `node` condition names `./lib/…` while its `default`/`types`
// name `./out/…` WITHOUT that segment — `rootDir: "./lib"` strips it from the emit. The expectations below are
// therefore also the assertion that the segment is dropped rather than carried through.
const DEV_MAP = {
	"./package.json": "./package.json",
	".": {
		node: "./lib/index.ts",
		default: "./out/index.js",
		types: "./out/index.d.ts",
	},
	"./table": {
		node: "./lib/table.ts",
		default: "./out/table.js",
		types: "./out/table.d.ts",
	},
	"./data/*.json": "./data/*.json",
}

describe("transformExportsForPublish", () => {
	it("rewrites node→.ts conditions to emitted JavaScript and reorders types first", () => {
		const result = transformExportsForPublish(DEV_MAP) as Record<string, unknown>

		expect(result["."]).toEqual({
			types: "./out/index.d.ts",
			node: "./out/index.js",
			default: "./out/index.js",
		})

		expect(Object.keys(result["."] as object)[0]).toBe("types")

		expect(result["./table"]).toEqual({
			types: "./out/table.d.ts",
			node: "./out/table.js",
			default: "./out/table.js",
		})
	})

	it("passes through string subpaths and patterns untouched", () => {
		const result = transformExportsForPublish(DEV_MAP) as Record<string, unknown>

		expect(result["./package.json"]).toBe("./package.json")
		expect(result["./data/*.json"]).toBe("./data/*.json")
	})

	it("drops the lib/ segment, because rootDir strips it from the emit", () => {
		// A map that carried the segment through would name ./out/lib/deep/thing.js — well-formed JavaScript at an
		// address no tarball contains, which assertNoSourceTargets cannot catch because it is no longer TypeScript.
		const result = transformExportsForPublish({
			"./deep": { node: "./lib/deep/thing.ts", default: "./out/deep/thing.js" },
		}) as Record<string, Record<string, string>>

		expect(result["./deep"]!["node"]).toBe("./out/deep/thing.js")
		expect(result["./deep"]!["node"]).not.toContain("/lib/")
	})

	it("keeps a node condition that already targets compiled output", () => {
		const result = transformExportsForPublish({
			".": { node: "./out/node.js", default: "./out/index.js" },
		}) as Record<string, Record<string, string>>

		expect(result["."]).toEqual({ node: "./out/node.js", default: "./out/index.js" })
	})

	it("preserves a platform-specific Node implementation distinct from the default", () => {
		const result = transformExportsForPublish({
			"./util": {
				node: "./node/util.ts",
				default: "./out/unsupported/util.js",
				types: "./out/unsupported/util.d.ts",
			},
		}) as Record<string, Record<string, string>>

		expect(result["./util"]).toEqual({
			types: "./out/unsupported/util.d.ts",
			node: "./out/node/util.js",
			default: "./out/unsupported/util.js",
		})
	})

	it("rewrites every source-targeting condition, not only node", () => {
		// A map whose Node target and browser target are different FILES, both source in the dev map. Rewriting only
		// `node` shipped browser and worker bundlers a raw `.ts`.
		const result = transformExportsForPublish({
			"./fs": {
				node: "./node/fs.ts",
				worker: "./unsupported/fs.ts",
				browser: "./unsupported/fs.ts",
				default: "./out/unsupported/fs.js",
				types: "./out/unsupported/fs.d.ts",
			},
		}) as Record<string, Record<string, string>>

		expect(result["./fs"]).toEqual({
			types: "./out/unsupported/fs.d.ts",
			node: "./out/node/fs.js",
			worker: "./out/unsupported/fs.js",
			browser: "./out/unsupported/fs.js",
			default: "./out/unsupported/fs.js",
		})
	})

	it("returns non-object exports unchanged", () => {
		expect(transformExportsForPublish("./out/index.js")).toBe("./out/index.js")
		expect(transformExportsForPublish(undefined)).toBeUndefined()
	})
})

describe("assertNoSourceTargets", () => {
	it("accepts a transformed map", () => {
		expect(() => assertNoSourceTargets("pkg", transformExportsForPublish(DEV_MAP))).not.toThrow()
	})

	it("names the workspace and the leaked target", () => {
		expect(() =>
			assertNoSourceTargets("packages/example exports", { "./fs": { browser: "./unsupported/fs.ts" } })
		).toThrow(/packages\/example exports.*\.\/unsupported\/fs\.ts/s)
	})

	it("accepts a declaration file, which is a legitimate publish target", () => {
		expect(() => assertNoSourceTargets("pkg", { ".": { types: "./out/index.d.ts" } })).not.toThrow()
	})
})

describe("collectExportTargets", () => {
	it("collects concrete targets and skips patterns", () => {
		const targets = collectExportTargets(transformExportsForPublish(DEV_MAP))

		expect(targets).toContain("./out/index.js")
		expect(targets).toContain("./out/table.d.ts")
		expect(targets).toContain("./package.json")
		expect(targets.some((t) => t.includes("*"))).toBe(false)
	})

	it("exposes a source leak for assertNoSourceTargets to reject", () => {
		// The v7.2.0 failure shape: a dev map shipped verbatim. The transform repairs every condition whose target is
		// source, so a leak can only reach here through a shape it does not walk — a pattern target, or a nested
		// condition it did not visit. Collecting it is what lets the refusal see it.
		const leaked = collectExportTargets({ ".": { default: "./index.ts" } })
		expect(leaked).toContain("./index.ts")
	})
})

describe("transformImportsForPublish", () => {
	it("keeps compiled aliases and drops source-only aliases", () => {
		expect(
			transformImportsForPublish({
				"#runner": { node: "./src/runner.ts", default: "./out/src/runner.js" },
				"#test-kit": "./test-kit/index.ts",
				"#data": "./data/table.json",
			})
		).toEqual({
			"#runner": { node: "./out/src/runner.js", default: "./out/src/runner.js" },
			"#data": "./data/table.json",
		})
	})
})
