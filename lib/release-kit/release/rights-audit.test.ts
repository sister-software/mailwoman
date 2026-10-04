/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The rights audit over the committed tree, pinned on the readings a release decision turns on.
 *
 *   The pins here are deliberately the two shapes a report can take that a reader would misread. A package with no
 *   frozen training manifest has to appear in `unresolved` rather than being absent from the report, because absence
 *   from a report reads as no statement to make. And an attribution entry stating no use has to be counted apart from one
 *   stating a use that is not training, because reporting them together turns an unrecorded fact into a measured one.
 *
 *   The counts are against the committed tree, so a card edit moves them. That is intended: a number in this file
 *   moving is what indicates that a rights-bearing document changed.
 */

import { repoRootPath } from "@mailwoman/core/paths"
import { readAddressSourceRegister, type AddressSourceRegister } from "@mailwoman/corpus/source-register"
import { beforeAll, describe, expect, it } from "vitest"

import { auditRights, renderRightsAudit } from "#release-kit/release/rights-audit"

let audit: Awaited<ReturnType<typeof auditRights>>
let register: AddressSourceRegister

beforeAll(async () => {
	audit = await auditRights(repoRootPath())
	register = await readAddressSourceRegister()
})

describe("auditRights", () => {
	it("reads every published weights package", () => {
		expect(audit.packages).toHaveLength(12)
		expect(audit.packages.map((entry) => entry.package)).toContain("@mailwoman/neural-weights-en-us")
	})

	it("counts an entry stating no use apart from one stating a use that is not training", () => {
		const enUS = audit.packages.find((entry) => entry.package === "@mailwoman/neural-weights-en-us")

		expect(enUS?.attributionEntries).toBe(10)
		expect(enUS?.entriesNotTraining).toBe(4)
		expect(enUS?.entriesStatingNoUse).toBe(1)

		// Every one of cjk's entries states its terms and none states a use, so reading them
		// as evaluation text would claim its model learned from none of them.
		const cjk = audit.packages.find((entry) => entry.package === "@mailwoman/neural-weights-cjk")

		expect(cjk?.entriesNotTraining).toBe(0)
		expect(cjk?.entriesStatingNoUse).toBe(6)
	})

	it("resolves each overlay's lineage to the package owning the model graph", () => {
		const overlays = audit.packages.filter((entry) => entry.versionSeries === "overlay")

		expect(overlays.length).toBeGreaterThan(0)

		for (const overlay of overlays) {
			expect(overlay.lineageUnresolved).toBeNull()
			expect(overlay.lineage.length).toBeGreaterThan(1)
		}

		expect(audit.packages.find((entry) => entry.package === "@mailwoman/neural-weights-ja-jp")?.lineage).toStrictEqual([
			"@mailwoman/neural-weights-ja-jp",
			"@mailwoman/neural-weights-cjk",
		])
	})

	it("reports every package whose manifest omits a generated rights file", () => {
		expect(audit.packages.filter((entry) => !entry.shipsRightsFiles)).toEqual([])
	})

	it("records a missing training manifest as unresolved rather than as an empty one", () => {
		expect(audit.training.filter((row) => row.manifest)).toEqual([])

		for (const row of audit.training) {
			expect(row.unresolved).toBeTruthy()
		}

		expect(audit.unresolved.join("\n")).toMatch(/12 of 12 packages have no frozen training manifest/u)
	})

	it("counts every register source and names each of the four blockers", () => {
		// The totals move with every research pass and every review, so the report is checked
		// against the register it read rather than against a recorded number.
		expect(audit.register.sources).toBe(register.sources.length)
		expect(audit.register.eligible).toBeLessThanOrEqual(audit.register.sources)

		// Each of the four ingest conditions has to reach the report.
		// The license blocker reaches it only because refusals that differ by a quoted
		// identifier are grouped: each source points at its own license id, so ungrouped it
		// is one message per source and never appears among the largest refusals.
		const named = ["is unchecked", "address column has a resolved role", "coverage has been measured", "personal-data"]

		for (const needle of named) {
			expect(
				audit.register.refusals.filter((refusal) => refusal.because.includes(needle)).length,
				needle
			).toBeGreaterThan(0)
		}

		// No single blocker covers every source.
		// Resolving one condition on one source is what breaks that, so a blocker widening
		// back to the full count would mean a recorded resolution stopped being read.
		// The assertions above leave each blocker's own count free, because every review moves it.
		expect(Math.max(...audit.register.refusals.map((refusal) => refusal.sources))).toBeLessThan(audit.register.sources)
	})

	it("renders a report that ends on what it leaves open", () => {
		const lines = renderRightsAudit(audit)

		expect(lines[0]).toMatch(/^Rights audit/u)
		expect(lines.indexOf("Unresolved:")).toBeGreaterThan(lines.indexOf("Established:"))
		expect(lines.at(-1)).not.toBe("")
	})
})
