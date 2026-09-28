/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What `mailwoman license attribution` reports, and the three things it refuses to imply.
 *
 *   Two of the three are pinned as equalities rather than as text, so a disclaimer's wording can be kept while its behavior stops matching it.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { attributionReport, renderAttributionReport } from "mailwoman/cli-native/license-attribution"
import { describe, expect, it, vi } from "vitest"

describe("attributionReport", () => {
	it("reads the installed weights packages rather than the source register", async () => {
		// The register lists the sources research resolved.
		// The installation carries its own set.
		// Reporting the register here would claim attribution for rows the operator does not have.
		const report = await attributionReport("AGPL-3.0-only OR LicenseRef-Commercial")

		expect(report.engineLicense).toBe("AGPL-3.0-only OR LicenseRef-Commercial")
		expect(report.packages.length + report.notInstalled.length).toBe(12)
	})

	it("carries a base package's entries under the overlay that decodes through it", async () => {
		const report = await attributionReport("AGPL-3.0-only OR LicenseRef-Commercial")
		const overlay = report.packages.find((entry) => entry.package === "@mailwoman/neural-weights-en-au")

		if (!overlay) return

		// en-au contributed none of these rows.
		// They are its base's, and the field they arrive under says so.
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

	it("reports the same upstream sources under a commercial key as under the open-source branch", async () => {
		// A commercial agreement covers only the code and model artifacts Sister Software
		// authors, so reporting fewer sources once a key is present would claim the
		// key discharged an obligation it cannot reach.
		const open = await attributionReport("AGPL-3.0-only")
		const commercial = await attributionReport("LicenseRef-Commercial")

		expect(commercial.packages).toStrictEqual(open.packages)
		expect(commercial.notCovered).toStrictEqual(open.notCovered)

		expect(renderAttributionReport(commercial).join("\n")).toContain(
			"whose attribution and share-alike conditions survive it"
		)
	})

	it("reports the same sources with no reference data on disk at all", async () => {
		// The lineage is fixed at training time and read through module resolution rather than
		// the data root, so deleting every downloaded database cannot remove an entry.
		await using empty = await temporaryDirectory("mw-no-data-root-")
		const before = await attributionReport("AGPL-3.0-only")

		vi.stubEnv("MAILWOMAN_DATA_ROOT", empty.path.toString())

		try {
			expect(await attributionReport("AGPL-3.0-only")).toStrictEqual(before)
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("says so plainly when no package carries a record", async () => {
		const lines = renderAttributionReport(
			await attributionReport("AGPL-3.0-only OR LicenseRef-Commercial", ["@mailwoman/neural-weights-absent"])
		)

		expect(lines.join("\n")).toContain("No weights package with a provenance record is installed.")
	})
})
