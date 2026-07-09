/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { PostalAddress } from "@mailwoman/record"
import { describe, expect, it } from "vitest"

import { makeGeocodeHandler } from "./geocode-handler.ts"
import type { GeocodeAddress } from "./ingest.ts"
import type { SourceRecord } from "./types.ts"

const rec = (raw: Record<string, string>): SourceRecord => ({ id: "x", raw }) as SourceRecord

describe("makeGeocodeHandler", () => {
	it("recomputes the address from raw+mapping and attaches the geocode", async () => {
		const seam: GeocodeAddress = async (raw) => ({ formatted: raw.toUpperCase() }) as unknown as PostalAddress
		const handle = makeGeocodeHandler(seam, { address: ["addr", "city", "state"] })

		const out = await handle(rec({ addr: "1 Main St", city: "Austin", state: "TX" }))

		expect((out.address as unknown as { formatted: string }).formatted).toBe("1 MAIN ST, AUSTIN, TX")
	})

	it("leaves a record with no mapped address untouched (no geocode call)", async () => {
		let calls = 0
		const seam: GeocodeAddress = async () => {
			calls++

			return null
		}
		const handle = makeGeocodeHandler(seam, { address: ["addr"] })

		const out = await handle(rec({ addr: "" }))

		expect(out.address).toBeUndefined()
		expect(calls).toBe(0)
	})

	it("maps a null geocode result to undefined", async () => {
		const seam: GeocodeAddress = async () => null
		const handle = makeGeocodeHandler(seam, { address: ["addr"] })

		expect((await handle(rec({ addr: "nowhere" }))).address).toBeUndefined()
	})
})
