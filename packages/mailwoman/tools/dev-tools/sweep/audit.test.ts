/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { classifyDataDiff, extensionOf, numstatDestination } from "./audit.ts"

describe("sweep data audit", () => {
	it("separates YAML comments from changed keys and values", () => {
		const diff = [
			"+++ b/config/train.yaml",
			"+# builders replace contractors here",
			"+  state-ia-builders: 0.4",
			"+",
			"-  state-ia-contractors: 0.4",
		].join("\n")

		expect(classifyDataDiff("config/train.yaml", diff)).toEqual({
			path: "config/train.yaml",
			commentLines: 1,
			valueLines: ["state-ia-builders: 0.4"],
		})
	})

	it("treats every added JSON line as a value, including one that starts with #", () => {
		expect(classifyDataDiff("a.json", '+"# not a comment"').valueLines).toEqual(['"# not a comment"'])
	})

	it("resolves both numstat rename spellings to the destination", () => {
		expect(numstatDestination("old.json => new.json")).toBe("new.json")
		expect(numstatDestination("data/{a => b}/x.yaml")).toBe("data/b/x.yaml")
		expect(numstatDestination("data/{a => }/x.yaml")).toBe("data/x.yaml")
	})

	it("reads the extension from the basename only", () => {
		expect(extensionOf("dir.d/README")).toBe("")
		expect(extensionOf("a/b.YML")).toBe("yml")
	})
})
