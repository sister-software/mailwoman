/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What the browser suite's console policy calls a failure.
 */

import { describe, expect, it } from "vitest"

import { classify, listFailures } from "../e2e/utils/console-policy.ts"

describe("the 404 pattern", () => {
	it("fails on the browser's own missing-asset line", () => {
		expect(classify("Failed to load resource: the server responded with a status of 404 (Not Found)")).toBe("fail")
	})

	it("passes a commit SHA that begins with those digits", () => {
		// One hex SHA in every 4,096 begins `404`, so a pattern anchored only at the
		// start would fail a build that loaded every asset.
		expect(
			classify(
				"[mailwoman] debug info {app: mailwoman-earth, commit: 404f39845b06e7f6055cbe2b7f9e9a93340b025e, model: v9.1.0}"
			)
		).toBe("noise")
	})

	it("passes other digit runs that contain the sequence", () => {
		expect(classify("[mailwoman] tiles: 14042 features in 404096 bytes")).toBe("noise")
	})
})

describe("the network-error pattern", () => {
	it("fails on an aborted first-party request", () => {
		expect(classify("GET http://localhost:7770/assets/index.js (net::ERR_ABORTED)")).toBe("fail")
	})
})

describe("listFailures", () => {
	it("returns only the texts the policy calls failures", () => {
		const texts = [
			"[mailwoman] debug info {commit: 404f39845b06e7f6055cbe2b7f9e9a93340b025e}",
			"Failed to load resource: the server responded with a status of 404 (Not Found)",
		]

		expect(listFailures(texts)).toEqual([
			"Failed to load resource: the server responded with a status of 404 (Not Found)",
		])
	})
})
