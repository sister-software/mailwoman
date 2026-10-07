/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { makeGeocodeHandler } from "#geocode-handler"
import type { GeocodeAddress } from "#ingest"
import type { SourceRecord } from "#types"

const rec = (raw: Record<string, string>): SourceRecord => ({
	id: "x",
	source: null,
	name: null,
	organization: null,
	address: null,
	phone: null,
	email: null,
	attributes: null,
	raw,
})

describe("makeGeocodeHandler", () => {
	it("recomputes the address from raw+mapping and attaches the geocode", async () => {
		const geocodeForIngest: GeocodeAddress = async (raw) => ({
			components: {},
			canonicalKey: "",
			formatted: raw.toUpperCase(),
			geocode: null,
			raw: null,
		})

		const handle = makeGeocodeHandler(geocodeForIngest, { address: ["addr", "city", "state"] })

		const out = await handle(rec({ addr: "1 Main St", city: "Austin", state: "TX" }))

		expect(out.address?.formatted).toBe("1 MAIN ST, AUSTIN, TX")
	})

	it("leaves a record with no mapped address untouched (no geocode call)", async () => {
		let calls = 0

		const geocodeForIngest: GeocodeAddress = async () => {
			calls++

			return null
		}

		const handle = makeGeocodeHandler(geocodeForIngest, { address: ["addr"] })

		const out = await handle(rec({ addr: "" }))

		expect(out.address).toBeNull()
		expect(calls).toBe(0)
	})

	it("maps a null geocode result to undefined", async () => {
		const geocodeForIngest: GeocodeAddress = async () => null
		const handle = makeGeocodeHandler(geocodeForIngest, { address: ["addr"] })

		expect((await handle(rec({ addr: "nowhere" }))).address).toBeNull()
	})
})
