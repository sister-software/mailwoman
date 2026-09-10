/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A command's name is what it declares, not where its file sits.
 */

import { commandPathCandidates, declaredCommandName, isPrefixDirectory } from "mailwoman/cli-native/command-names"
import { describe, expect, it } from "vitest"

describe("commandPathCandidates", () => {
	it("tries the literal spelling before any prefix directory", () => {
		expect(commandPathCandidates("postcode-codepoint")).toEqual([["postcode-codepoint"], ["postcode", "codepoint"]])
	})

	it("offers every nesting a multi-hyphen name can take, shallowest first", () => {
		const candidates = commandPathCandidates("usgov-irs-bmf")

		expect(candidates[0]).toEqual(["usgov-irs-bmf"])
		expect(candidates).toContainEqual(["usgov", "irs-bmf"])
		expect(candidates).toContainEqual(["usgov-irs", "bmf"])
		expect(candidates.at(-1)).toEqual(["usgov", "irs", "bmf"])
	})

	it("leaves a name with no hyphen alone", () => {
		expect(commandPathCandidates("parse")).toEqual([["parse"]])
	})
})

describe("isPrefixDirectory", () => {
	it("separates a layout directory from a namespace by the declared name", () => {
		// `build/postcode/codepoint.tsx` declares `postcode-codepoint`, so `postcode` is layout.
		expect(isPrefixDirectory("postcode", "postcode-codepoint")).toBe(true)
		// `gazetteer/inspect/fst.tsx` declares `fst`, so `inspect` is a segment the user types.
		expect(isPrefixDirectory("inspect", "fst")).toBe(false)
	})
})

describe("declaredCommandName", () => {
	it("reads the compiled spec without running the module", () => {
		const compiled = ["export const spec = {", '    name: "postcode-codepoint",', '    description: "…",', "}"].join(
			"\n"
		)

		expect(declaredCommandName(compiled, "codepoint")).toBe("postcode-codepoint")
	})

	it("falls back to the filename when no spec is found", () => {
		expect(declaredCommandName("export const notASpec = {}", "codepoint")).toBe("codepoint")
	})
})
