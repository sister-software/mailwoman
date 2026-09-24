/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Tests the strict frontmatter rules with in-memory fixtures. Filesystem, sidebar, and legacy-mode
 * checks are outside this suite.
 */

import { PAGE_ROLES, validatePage } from "@mailwoman/docs/scripts/docs-frontmatter-metadata"
import { describe, expect, it } from "vitest"

describe("validatePage", () => {
	it("flags a page with no role declared", () => {
		const failures = validatePage({}, "guides/example.mdx")

		expect(failures).toHaveLength(1)
		expect(failures[0]).toContain("role")
	})

	it("flags a role value outside the six-role vocabulary", () => {
		const failures = validatePage({ role: "concept" }, "concepts/example.mdx")

		expect(failures).toHaveLength(1)
		expect(failures[0]).toContain("concept")
	})

	it("requires verified-with on a tutorial", () => {
		const failures = validatePage({ role: "tutorial" }, "tutorials/first-parse.mdx")

		expect(failures).toHaveLength(1)
		expect(failures[0]).toContain("verified-with")
	})

	it("requires verified-with on a guide", () => {
		const failures = validatePage({ role: "guide" }, "guides/geocode-an-address.mdx")

		expect(failures).toHaveLength(1)
		expect(failures[0]).toContain("verified-with")
	})

	it("requires source-of-truth on a reference page", () => {
		const failures = validatePage({ role: "reference" }, "reference/schema.mdx")

		expect(failures).toHaveLength(1)
		expect(failures[0]).toContain("source-of-truth")
	})

	it("requires audience on a landing page", () => {
		const failures = validatePage({ role: "landing" }, "index.mdx")

		expect(failures).toHaveLength(1)
		expect(failures[0]).toContain("audience")
	})

	it("accepts an evidence page with no fields beyond role", () => {
		const failures = validatePage({ role: "evidence" }, "evals/example.mdx")

		expect(failures).toEqual([])
	})

	it("accepts an explanation page with no fields beyond role", () => {
		const failures = validatePage({ role: "explanation" }, "concepts/how-it-works.mdx")

		expect(failures).toEqual([])
	})

	it("accepts a fully valid tutorial page", () => {
		const failures = validatePage({ role: "tutorial", "verified-with": "v8.7.0" }, "tutorials/first-parse.mdx")

		expect(failures).toEqual([])
	})

	it("accepts a fully valid guide page", () => {
		const failures = validatePage({ role: "guide", "verified-with": "v8.7.0" }, "guides/geocode-an-address.mdx")

		expect(failures).toEqual([])
	})

	it("accepts a fully valid reference page", () => {
		const failures = validatePage(
			{ role: "reference", "source-of-truth": "docs/scripts/check/docs-structure.ts" },
			"reference/schema.mdx"
		)

		expect(failures).toEqual([])
	})

	it("accepts a fully valid landing page", () => {
		const failures = validatePage({ role: "landing", audience: "contributor" }, "index.mdx")

		expect(failures).toEqual([])
	})

	it("does not require verified-with/source-of-truth/audience for roles that don't need them", () => {
		for (const role of PAGE_ROLES) {
			if (role === "tutorial" || role === "guide" || role === "reference" || role === "landing") continue

			expect(validatePage({ role }, `${role}/example.mdx`)).toEqual([])
		}
	})
})
