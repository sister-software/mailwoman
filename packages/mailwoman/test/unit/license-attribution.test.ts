/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What `mailwoman license attribution` reports, and the three things it refuses to imply.
 *
 *   That a commercial key clears an upstream condition. That a package recording no attribution has none. And that the
 *   absence of a runtime dataset from the report means the installation owes nothing for one.
 */

import { attributionReport, renderAttributionReport } from "mailwoman/cli-native/license-attribution"
import { describe, expect, it } from "vitest"

describe("attributionReport", () => {
	it("reads the installed weights packages rather than the source register", async () => {
		// The register lists sources research resolved, which is a different set from the ones an installation carries.
		// Reporting it here would tell an operator they owe attribution to publishers whose rows they do not have.
		const report = await attributionReport("AGPL-3.0-only OR LicenseRef-Commercial")

		expect(report.engineLicense).toBe("AGPL-3.0-only OR LicenseRef-Commercial")
		expect(report.packages.length + report.notInstalled.length).toBe(12)
	})

	it("carries a base package's entries under the overlay that decodes through it", async () => {
		const report = await attributionReport("AGPL-3.0-only OR LicenseRef-Commercial")
		const overlay = report.packages.find((entry) => entry.package === "@mailwoman/neural-weights-en-au")

		if (!overlay) return

		// `en-au` contributed none of these rows. They are its base's, and the field they arrive under says so.
		expect(overlay.own).toEqual([])
		expect(overlay.inherited?.package).toBe("@mailwoman/neural-weights-en-us")
		expect(overlay.inherited?.entries.length).toBeGreaterThan(0)
	})

	it("names a package it did not find rather than leaving it out", async () => {
		const report = await attributionReport("AGPL-3.0-only OR LicenseRef-Commercial", [
			"@mailwoman/neural-weights-absent",
		])

		expect(report.packages).toEqual([])
		expect(report.notInstalled).toEqual(["@mailwoman/neural-weights-absent"])
	})

	it("states what it does not cover, so the gaps are read rather than inferred", async () => {
		const report = await attributionReport("AGPL-3.0-only OR LicenseRef-Commercial")

		expect(report.notCovered).toHaveLength(2)
		expect(report.notCovered[0]).toContain("downloaded separately at runtime")
		expect(report.notCovered[1]).toContain("a package recording none is not a package with none")
	})
})

describe("renderAttributionReport", () => {
	it("says a commercial agreement leaves the upstream conditions in place", async () => {
		const lines = renderAttributionReport(await attributionReport("AGPL-3.0-only OR LicenseRef-Commercial"))

		expect(lines.join("\n")).toContain("It does not reach the")
		expect(lines.join("\n")).toContain("whose attribution and share-alike conditions survive it")
	})

	it("says so plainly when no package carries a record", async () => {
		const lines = renderAttributionReport(
			await attributionReport("AGPL-3.0-only OR LicenseRef-Commercial", ["@mailwoman/neural-weights-absent"])
		)

		expect(lines.join("\n")).toContain("No weights package with a provenance record is installed.")
	})
})
