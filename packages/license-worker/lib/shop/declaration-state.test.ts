/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { declarationStateStatement } from "#shop/declaration-state"

const LID = "lic_AbCdEfGhIjKlMnOpQrSt-_"
const AT = "2026-11-10T04:30:00.000Z"

describe("declarationStateStatement", () => {
	it("moves one declaration only while it holds the state the operator read", () => {
		expect(declarationStateStatement(LID, "active", "revoked", AT)).toBe(
			`UPDATE declarations SET license_state = 'revoked', updated_at = '${AT}' WHERE lid = '${LID}' AND license_state = 'active'`
		)
	})

	it.each([
		["lic_short", "active", "revoked", AT, /not a license id/u],
		[`${LID}' OR '1'='1`, "active", "revoked", AT, /not a license id/u],
		[LID, "paused", "revoked", AT, /paused is not a license state/u],
		[LID, "active", "revoked'; DROP TABLE declarations; --", AT, /not a license state/u],
		[LID, "active", "revoked", "yesterday", /not an ISO 8601 UTC instant/u],
	])("refuses %s %s → %s at %s", (lid, from, to, at, refusal) => {
		expect(() => declarationStateStatement(lid, from, to, at)).toThrow(refusal)
	})
})
