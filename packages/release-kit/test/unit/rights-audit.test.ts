/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The rights audit over the committed tree, pinned on the readings a release decision turns on.
 *
 *   The pins here are deliberately the two shapes a report can take that a reader would misread. A package with no
 *   frozen training manifest has to appear in `unresolved` rather than being absent from the report, because absence
 *   from a report reads as nothing to say. And an attribution entry stating no use has to be counted apart from one
 *   stating a use that is not training, because reporting them together turns an unrecorded fact into a measured one.
 *
 *   The counts are against the committed tree, so a card edit moves them. That is intended: a number in this file
 *   moving is what says a rights-bearing document changed.
 */

import { repoRootPath } from "@mailwoman/core/paths"
import { auditRights, renderRightsAudit } from "@mailwoman/release-kit/release/rights-audit"
import { beforeAll, describe, expect, it } from "vitest"

let audit: Awaited<ReturnType<typeof auditRights>>

beforeAll(async () => {
	audit = await auditRights(repoRootPath().toString())
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

		// Every one of cjk's entries states its terms and none states a use, so reading them as evaluation text would
		// claim its model learned from none of them.
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

	it("reports that the register admits no source, and names every blocker that covers all of them", () => {
		expect(audit.register.sources).toBe(389)
		expect(audit.register.eligible).toBe(0)

		// Four blockers cover all 389, and the license one reaches the report only because refusals that differ by a
		// quoted identifier are grouped: each source points at its own license id, so ungrouped it is 389 messages of
		// one source each and never appears among the largest refusals.
		const universal = audit.register.refusals.filter((refusal) => refusal.sources === 389)

		expect(universal).toHaveLength(4)

		expect(universal.map((refusal) => refusal.because).join("\n")).toMatch(
			/is unchecked[\S\s]*address role[\S\s]*coverage[\S\s]*personal-data/u
		)
	})

	it("renders a report that ends on what it leaves open", () => {
		const lines = renderRightsAudit(audit)

		expect(lines[0]).toMatch(/^Rights audit/u)
		expect(lines.indexOf("Unresolved:")).toBeGreaterThan(lines.indexOf("Established:"))
		expect(lines.at(-1)).not.toBe("")
	})
})
