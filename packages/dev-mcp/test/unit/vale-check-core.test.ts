/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { renderVerdict, type ValeAlert } from "@mailwoman/dev-mcp/hooks/vale-check-core"
import { describe, expect, it } from "vitest"

describe("Vale reply verdict", () => {
	it("requests replacements only for flagged sentences", () => {
		const alerts: ValeAlert[] = [
			{
				Check: "MailwomanChat.AssertiveFiller",
				Message: "Remove 'plainly' or replace it with the concrete reason for the confidence.",
				Severity: "error",
				Match: "plainly",
				Line: 4,
			},
		]

		const verdict = renderVerdict(alerts)

		expect(verdict?.kind).toBe("block")
		expect(verdict?.text).toContain("Rewrite only the flagged sentences")
		expect(verdict?.text).toContain("Return only replacement text for the flagged sentences")
		expect(verdict?.text).toContain("Do not repeat, summarize, reorder, expand")
		expect(verdict?.text).not.toContain("give the corrected reply")
	})
})
