/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { libpostalLineSurfaces } from "#resources/libpostal"

describe("libpostalLineSurfaces", () => {
	it("splits a dictionary line into its pipe-separated surfaces", () => {
		expect(libpostalLineSurfaces("between|betw|btwn")).toEqual(["between", "betw", "btwn"])
	})
})
