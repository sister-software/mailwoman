/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { corpusDirectoryName } from "@mailwoman/corpus/directory"
import { describe, expect, it } from "vitest"

describe("corpusDirectoryName", () => {
	it("composes the directory from a version carrying no prefix", () => {
		expect(corpusDirectoryName("0.7.0-de-holdout")).toBe("corpus-v0.7.0-de-holdout")
		expect(corpusDirectoryName("0.1.0-dev")).toBe("corpus-v0.1.0-dev")
		expect(corpusDirectoryName("8-jp-full-2026-08-04")).toBe("corpus-v8-jp-full-2026-08-04")
	})

	it("refuses a version already carrying the prefix, which wrote corpus-vv0.7.0-de-holdout once", () => {
		// The build that produced it re-stamped 695 files to repair the name.
		expect(() => corpusDirectoryName("v0.7.0-de-holdout")).toThrow(/already carries a leading "v"/)
		expect(() => corpusDirectoryName("v0.7.0-de-holdout")).toThrow(/corpus-vv0\.7\.0-de-holdout/)
	})
})
