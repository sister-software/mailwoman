/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { parseClaimResponse } from "@mailwoman/license-worker/claim-contract"
import { describe, expect, it } from "vitest"

describe("the claim contract", () => {
	it("admits each of the three answers and hands back the fields it names", () => {
		const issued = {
			status: "issued",
			token: "mwl1.a.b",
			lid: `lic_${"a".repeat(22)}`,
			licensee: "Example Ltd",
			issued: "2026-10-01",
			expires: "2026-11-15",
		}

		expect(parseClaimResponse({ status: "pending" })).toEqual({ status: "pending" })
		expect(parseClaimResponse({ status: "revoked" })).toEqual({ status: "revoked" })
		expect(parseClaimResponse(issued)).toEqual(issued)

		expect(parseClaimResponse({ ...issued, refresh_secret: "s".repeat(43) })).toMatchObject({
			refresh_secret: "s".repeat(43),
		})
	})

	it("refuses an issued answer with a field missing, an unknown status, and a body that is no object", () => {
		expect(parseClaimResponse({ status: "issued", lid: "lic_x" })).toBeUndefined()
		expect(parseClaimResponse({ status: "granted" })).toBeUndefined()
		expect(parseClaimResponse("issued")).toBeUndefined()
		expect(parseClaimResponse(null)).toBeUndefined()
	})
})
