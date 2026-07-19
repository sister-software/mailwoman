/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { collectExportTargets, transformExportsForPublish } from "./publish-exports.ts"

const DEV_MAP = {
	"./package.json": "./package.json",
	".": {
		node: "./index.ts",
		default: "./out/index.js",
		types: "./out/index.d.ts",
	},
	"./table": {
		node: "./table.ts",
		default: "./out/table.js",
		types: "./out/table.d.ts",
	},
	"./data/*.json": "./data/*.json",
}

describe("transformExportsForPublish", () => {
	it("drops node→.ts conditions and reorders types first", () => {
		const result = transformExportsForPublish(DEV_MAP) as Record<string, unknown>

		expect(result["."]).toEqual({ types: "./out/index.d.ts", default: "./out/index.js" })
		expect(Object.keys(result["."] as object)[0]).toBe("types")
		expect(result["./table"]).toEqual({ types: "./out/table.d.ts", default: "./out/table.js" })
	})

	it("passes through string subpaths and patterns untouched", () => {
		const result = transformExportsForPublish(DEV_MAP) as Record<string, unknown>

		expect(result["./package.json"]).toBe("./package.json")
		expect(result["./data/*.json"]).toBe("./data/*.json")
	})

	it("keeps a node condition that already targets compiled output", () => {
		const result = transformExportsForPublish({
			".": { node: "./out/node.js", default: "./out/index.js" },
		}) as Record<string, Record<string, string>>

		expect(result["."]).toEqual({ node: "./out/node.js", default: "./out/index.js" })
	})

	it("returns non-object exports unchanged", () => {
		expect(transformExportsForPublish("./out/index.js")).toBe("./out/index.js")
		expect(transformExportsForPublish(undefined)).toBeUndefined()
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

	it("would expose a source leak for the guard to reject", () => {
		// The v7.2.0 failure shape: a dev map shipped verbatim. The transform repairs the node
		// condition, so a .ts leak can only survive via a non-node condition — the guard's job.
		const leaked = collectExportTargets({ ".": { default: "./index.ts" } })
		expect(leaked).toContain("./index.ts")
	})
})
