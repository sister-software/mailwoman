/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The regression test for the neural-weights-en-in@8.6.0 incident: a `files` array naming a
 *   binary the tarball did not contain, published without complaint. The first case below is that
 *   package's exact manifest and exact tarball listing.
 */

import { describe, expect, it } from "vitest"

import {
	collectMissingBinTargets,
	collectMissingExportTargets,
	collectMissingFileEntries,
	collectMissingImportTargets,
} from "./verify-tarball.ts"

/**
 * What `@mailwoman/neural-weights-en-in@8.6.0` actually shipped — read back off the registry.
 */
const EN_IN_SHIPPED = new Set(["./README.md", "./model-card.json", "./package.json", "./scripts/link-dev-weights.ts"])

const EN_IN_FILES = [
	"model-card.json",
	"pair-index-in.bin",
	"README.md",
	"*.ts",
	"**/*.ts",
	"!*.test.ts",
	"!**/*.test.ts",
]

describe("collectMissingFileEntries", () => {
	it("catches the en-in incident: a declared binary absent from the tarball", () => {
		expect(collectMissingFileEntries(EN_IN_FILES, EN_IN_SHIPPED)).toEqual(["pair-index-in.bin"])
	})

	it("passes the same manifest once the binary is packed", () => {
		const shipped = new Set([...EN_IN_SHIPPED, "./pair-index-in.bin"])

		expect(collectMissingFileEntries(EN_IN_FILES, shipped)).toEqual([])
	})

	it("skips globs — a pattern matching nothing is legal", () => {
		// A data-only package carries no .ts of its own; `**\/*.ts` matching nothing must not fail it.
		expect(collectMissingFileEntries(["*.ts", "**/*.tsx", "data/*.json"], new Set(["./package.json"]))).toEqual([])
	})

	it("skips negations", () => {
		expect(collectMissingFileEntries(["!*.test.ts", "!**/*.test.ts"], new Set())).toEqual([])
	})

	it("accepts a directory entry satisfied by a member beneath it", () => {
		// `out/` is how cartographer/spatial/tiger declare their build output; tar may not list the
		// directory node itself, only its contents.
		expect(collectMissingFileEntries(["out/"], new Set(["./out/index.js"]))).toEqual([])
		expect(collectMissingFileEntries(["out"], new Set(["./out/index.js"]))).toEqual([])
		expect(collectMissingFileEntries(["out/"], new Set(["./index.js"]))).toEqual(["out/"])
	})

	it("normalizes ./-prefixed and trailing-slash spellings to the same entry", () => {
		expect(collectMissingFileEntries(["./model.onnx"], new Set(["./model.onnx"]))).toEqual([])
		expect(collectMissingFileEntries(["model.onnx"], new Set(["./model.onnx"]))).toEqual([])
	})

	it("tolerates a manifest with no files array", () => {
		expect(collectMissingFileEntries(undefined, new Set())).toEqual([])
		expect(collectMissingFileEntries("not-an-array", new Set())).toEqual([])
	})

	it("does not confuse a prefix that is not a path boundary", () => {
		// `./out-of-band.js` must not satisfy an `out` directory entry.
		expect(collectMissingFileEntries(["out"], new Set(["./out-of-band.js"]))).toEqual(["out"])
	})
})

describe("collectMissingExportTargets", () => {
	it("flags a concrete target the tarball lacks — the v7.2.0 ship-break class", () => {
		const exports = { ".": { types: "./out/index.d.ts", default: "./out/index.js" } }

		expect(collectMissingExportTargets(exports, new Set(["./out/index.js"]))).toEqual(["./out/index.d.ts"])
	})

	it("passes when every target ships", () => {
		const exports = { ".": { types: "./out/index.d.ts", default: "./out/index.js" } }
		const shipped = new Set(["./out/index.js", "./out/index.d.ts"])

		expect(collectMissingExportTargets(exports, shipped)).toEqual([])
	})

	it("ignores pattern targets", () => {
		expect(collectMissingExportTargets({ "./data/*.json": "./data/*.json" }, new Set())).toEqual([])
	})

	it("tolerates an absent exports map", () => {
		expect(collectMissingExportTargets(undefined, new Set())).toEqual([])
	})
})

describe("collectMissingImportTargets", () => {
	it("audits compiled package-private aliases", () => {
		const imports = { "#runner": { default: "./out/src/runner.js" } }

		expect(collectMissingImportTargets(imports, new Set())).toEqual(["./out/src/runner.js"])
		expect(collectMissingImportTargets(imports, new Set(["./out/src/runner.js"]))).toEqual([])
	})
})

describe("collectMissingBinTargets", () => {
	it("flags a bin whose file the tarball lacks — the map-tui class", () => {
		// `@mailwoman/map-tui` declares `bin: { "map-tui": "./out/cli.js" }` and packs `out/` as a GLOB, so an
		// unbuilt tree packs clean and npm PATH-links a file that isn't there. Nothing else in the manifest
		// mentions `out/cli.js`, which is why neither the files nor the exports guard sees it.
		const bin = { "map-tui": "./out/cli.js" }

		expect(collectMissingBinTargets(bin, new Set(["./package.json", "./out/frame.js"]))).toEqual(["./out/cli.js"])
		expect(collectMissingBinTargets(bin, new Set(["./out/cli.js"]))).toEqual([])
	})

	it("reads both spellings npm accepts", () => {
		// The string form names the package itself; the map form names each command.
		expect(collectMissingBinTargets("./out/cli.js", new Set())).toEqual(["./out/cli.js"])

		expect(collectMissingBinTargets({ mailwoman: "./out/cli.js", mw: "./out/cli.js" }, new Set())).toEqual([
			"./out/cli.js",
			"./out/cli.js",
		])
	})

	it("tolerates a package with no bin at all", () => {
		expect(collectMissingBinTargets(undefined, new Set())).toEqual([])
		expect(collectMissingBinTargets(null, new Set())).toEqual([])
	})
})
