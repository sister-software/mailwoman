/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The metadata reads, pinned against the published fields they parse.
 *
 *   THE LICENCE CHECK IS THE ONE THAT MATTERS. The item's `licenseInfo` carries two statements that
 *   contradict each other — an aspiration to publish under CC-BY, and an all-rights-reserved clause naming
 *   Tailte Éireann as an upstream licensor — and the second is the reason this layer is built locally rather
 *   than shipped. A build that absorbed its disappearance would ship the artifact under terms nobody checked,
 *   so the guard reads it separately from the credit line and refuses on either.
 *
 *   THE FIXTURE TEXT IS THE REAL FIELD, markup and all, because the parse is a markup strip and a fixture in
 *   plain text would test nothing.
 */

import { htmlToText } from "@mailwoman/core/html/text"
import { assertAttributionUnchanged } from "@mailwoman/zoning/sdk/client"
import { GZT_ATTRIBUTION, GZT_DECLARED_CODE_SET, GZT_DECLARED_CODES, GZT_LICENSE } from "@mailwoman/zoning/vocabulary"
import { describe, expect, it } from "vitest"

/**
 * The clause the published `licenseInfo` ends with, verbatim including its inline markup.
 */
const PUBLISHED_LICENSE_TAIL =
	"<p style='margin:0cm'><font color='#050505'><span style='font-size:14.6667px;'>Copyright in this site and the " +
	"information set out on it belonging to our licensors (Tailte &#233;ireann) may not be copied, transmitted or " +
	"reproduced without their prior consent.</span></font></p><p><span>&#169; Copyright 2011 DHLGH. All rights " +
	"reserved. </span></p><p><span>&#169; Tailte Éireann. All rights reserved. Licence No. 2023/OSi_NMA_073</span></p>"

/**
 * The credit line the item's `accessInformation` carries, verbatim.
 */
const PUBLISHED_ACCESS_INFORMATION = "Department of Housing, Local Government, and Heritage"

describe("htmlToText over the published license field", () => {
	it("returns the publisher's own words with the markup gone", () => {
		expect(htmlToText(PUBLISHED_LICENSE_TAIL)).toContain("Tailte Éireann. All rights reserved.")
		expect(htmlToText(PUBLISHED_LICENSE_TAIL)).not.toContain("<")
		expect(htmlToText(PUBLISHED_LICENSE_TAIL)).not.toContain("style=")
	})

	it("collapses the whitespace the field's paragraph markup leaves behind", () => {
		expect(htmlToText("<p>a</p>\n\n<p>  b  </p>")).toBe("a b")
	})

	it("decodes the entities the field ships", () => {
		expect(htmlToText("<p>a&nbsp;&amp;&nbsp;b</p>")).toBe("a & b")
	})

	it("leaves plain text alone", () => {
		expect(htmlToText("Generalised Zoning Types")).toBe("Generalised Zoning Types")
	})
})

describe("assertAttributionUnchanged", () => {
	it("passes the published fields this build ships", () => {
		expect(() =>
			assertAttributionUnchanged({
				accessInformation: PUBLISHED_ACCESS_INFORMATION,
				licenseInfo: htmlToText(PUBLISHED_LICENSE_TAIL),
			})
		).not.toThrow()
	})

	it("refuses a changed credit line, because it is what a re-user has to publish", () => {
		expect(() =>
			assertAttributionUnchanged({
				accessInformation: "Department of Housing and Local Government",
				licenseInfo: htmlToText(PUBLISHED_LICENSE_TAIL),
			})
		).toThrow(/a change in it is a change in the terms/u)
	})

	it("refuses a licenseInfo that no longer names Tailte Éireann, because that clause is the build-local reason", () => {
		expect(() =>
			assertAttributionUnchanged({
				accessInformation: PUBLISHED_ACCESS_INFORMATION,
				licenseInfo: "The Department encourages the free dissemination of data.",
			})
		).toThrow(/built locally rather than shipped/u)
	})

	it("refuses an empty credit line rather than reading it as unchanged", () => {
		expect(() =>
			assertAttributionUnchanged({ accessInformation: "", licenseInfo: htmlToText(PUBLISHED_LICENSE_TAIL) })
		).toThrow(/a change in it is a change in the terms/u)
	})
})

describe("the shipped constants", () => {
	it("carries BOTH halves of the attribution, including the licensor a re-user would not otherwise see", () => {
		expect(GZT_ATTRIBUTION).toContain(PUBLISHED_ACCESS_INFORMATION)
		expect(GZT_ATTRIBUTION).toContain("Tailte Éireann")
		expect(GZT_ATTRIBUTION).toContain("2023/OSi_NMA_073")
	})

	it("asserts NO licence, because three published statements disagree about the grant", () => {
		// `NOASSERTION` is SPDX's own token for a determination nobody has made. Writing `CC-BY-4.0` here while an
		// all-rights-reserved clause names a licensor would be this program asserting a grant.
		expect(GZT_LICENSE).toBe("NOASSERTION")
		expect(GZT_LICENSE).not.toContain("CC-BY")
	})

	it("declares the publisher's own 54 generic types, and no more", () => {
		// The service's coded-value domain holds 54. The DATA uses 55 — `N/A` on four rows — and that one is recorded as
		// observed rather than added here, because a declaration this package wrote would be indistinguishable from one the
		// Department made.
		expect(GZT_DECLARED_CODES).toHaveLength(54)
		expect(GZT_DECLARED_CODE_SET.size).toBe(54)
		expect(GZT_DECLARED_CODE_SET.has("N/A")).toBe(false)
		expect(GZT_DECLARED_CODE_SET.has("R2")).toBe(true)
	})
})
