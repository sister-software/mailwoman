/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ArcGISServiceError, assertNoArcGISError, readArcGISError } from "@mailwoman/core/api"
import { describe, expect, it } from "vitest"

const INVALID_TOKEN = {
	error: {
		code: 498,
		message: "Invalid token.",
		details: ["Token would have expired, regenerate token and send the request again."],
	},
}

describe("readArcGISError", () => {
	it("reads the envelope ArcGIS answers under HTTP 200", () => {
		expect(readArcGISError(INVALID_TOKEN)).toEqual({
			code: 498,
			message: "Invalid token.",
			details: ["Token would have expired, regenerate token and send the request again."],
		})
	})

	it("returns nothing for an answer, including one whose data happens to carry an error attribute", () => {
		expect(readArcGISError({ count: 795 })).toBeUndefined()
		expect(readArcGISError({ features: [{ attributes: { error: 3 } }] })).toBeUndefined()
		expect(readArcGISError({ error: "not an envelope" })).toBeUndefined()
		expect(readArcGISError(null)).toBeUndefined()
	})
})

describe("assertNoArcGISError", () => {
	it("throws the typed error, naming the caller, the code and the message", () => {
		expect(() => assertNoArcGISError(INVALID_TOKEN, "zoning client")).toThrow(ArcGISServiceError)
		expect(() => assertNoArcGISError(INVALID_TOKEN, "zoning client")).toThrow(/zoning client: .*498 — Invalid token\./u)
	})

	it("lets an answer through", () => {
		expect(() => assertNoArcGISError({ count: 795 }, "zoning client")).not.toThrow()
	})
})
