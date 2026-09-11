/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A fold output older than the admin database it came from is stale; a fresh one, or a path that is not a fold
 *   output, is not.
 */

import { foldSourceAdminPath, foldStaleness, foldStalenessMessage } from "mailwoman/gazetteer-pipeline/admin"
import { describe, expect, it } from "vitest"

describe("foldSourceAdminPath", () => {
	it("names the admin database a fold output was made from", () => {
		expect(foldSourceAdminPath("/wof/admin-global-priority-geonames.db")).toBe("/wof/admin-global-priority.db")

		expect(foldSourceAdminPath("/wof/admin-global-priority-geonames-2026-09-06.db")).toBe(
			"/wof/admin-global-priority.db"
		)

		expect(foldSourceAdminPath("/wof/admin-global-priority.db")).toBeNull()
	})
})

describe("foldStaleness", () => {
	const fold = new Date("2026-08-18T06:39:00Z")

	it("is stale when the admin database was modified after the fold", () => {
		const verdict = foldStaleness("/wof/x-geonames.db", "/wof/x.db", fold, new Date("2026-08-25T19:12:00Z"))

		expect(verdict?.adminModified.toISOString()).toBe("2026-08-25T19:12:00.000Z")
		expect(foldStalenessMessage(verdict!)).toContain("--fold")
		expect(foldStalenessMessage(verdict!)).toContain("--allow-stale-fold")
	})

	it("is not stale when the fold is as new as its source, or the source is absent", () => {
		expect(foldStaleness("/wof/x-geonames.db", "/wof/x.db", fold, fold)).toBeNull()
		expect(foldStaleness("/wof/x-geonames.db", "/wof/x.db", fold, null)).toBeNull()
	})
})
