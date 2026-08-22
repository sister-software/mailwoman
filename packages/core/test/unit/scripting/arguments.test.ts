/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The argv accessors, checked through the barrel their callers actually import.
 *
 *   `arguments.ts` is not a public subpath — every consumer reaches these through `@mailwoman/core/scripting/utils`,
 *   which re-exports them by name. A function added to the module but not to that list is importable in the editor and
 *   `undefined` at runtime, which is a defect no type-check catches.
 */

import * as scriptingUtils from "@mailwoman/core/scripting/utils"
import { describe, expect, it } from "vitest"

describe("@mailwoman/core/scripting/utils", () => {
	it("re-exports every argv accessor", () => {
		expect(typeof scriptingUtils.cliArguments, "cliArguments").toBe("function")
		expect(typeof scriptingUtils.passThroughCLIArguments, "passThroughCLIArguments").toBe("function")
		expect(typeof scriptingUtils.scriptEntryPath, "scriptEntryPath").toBe("function")
	})

	it("hands back the argument vector as strings", () => {
		// The verbatim passthrough is spread into a child-process command line, so the element type is the contract.
		for (const argument of scriptingUtils.passThroughCLIArguments()) {
			expect(typeof argument).toBe("string")
		}

		expect(scriptingUtils.passThroughCLIArguments()).toEqual(scriptingUtils.cliArguments())
	})
})
