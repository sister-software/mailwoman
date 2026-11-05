/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { resolveModelDownloadURL, sketchfabModelUID } from "#sdk/landmarks/sketchfab"

describe("sketchfabModelUID", () => {
	it("reads the uid from a model page with a slug", () => {
		expect(sketchfabModelUID("https://sketchfab.com/3d-models/tokyo-tower-dd7df8e4c33e453288e858866b471b5c")).toBe(
			"dd7df8e4c33e453288e858866b471b5c"
		)
	})

	it("returns null for another host's URL", () => {
		expect(sketchfabModelUID("https://3dmr.eu/api/model/4/3")).toBeNull()
	})
})

describe("resolveModelDownloadURL", () => {
	it("returns another host's URL as given", async () => {
		await expect(resolveModelDownloadURL("https://3dmr.eu/api/model/4/3", null)).resolves.toBe(
			"https://3dmr.eu/api/model/4/3"
		)
	})

	it("refuses a Sketchfab page when no key is set", async () => {
		await expect(
			resolveModelDownloadURL("https://sketchfab.com/3d-models/x-dd7df8e4c33e453288e858866b471b5c", null)
		).rejects.toThrow("SKETCHFAB_API_KEY")
	})
})
