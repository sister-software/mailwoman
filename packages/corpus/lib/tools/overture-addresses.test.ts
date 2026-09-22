/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { localityOf } from "@mailwoman/corpus/tools/overture-addresses"
import { describe, expect, it } from "vitest"

describe("localityOf", () => {
	it("prefers postal_city when the country populates it", () => {
		const found = localityOf({
			postal_city: "Springfield",
			address_levels: [{ value: "Illinois" }, { value: "Sangamon" }],
		})

		expect(found).toEqual({ value: "Springfield", from: "postal_city" })
	})

	it("reads the last address_levels entry when postal_city is empty", () => {
		// Overture writes Italy's hierarchy coarsest first: regione, provincia, comune.
		// `postal_city` is null on all 25,914,431 rows of `addresses-it.parquet`.
		const found = localityOf({
			postal_city: null,
			address_levels: [{ value: "Sardegna" }, { value: "Sud Sardegna" }, { value: "Calasetta" }],
		})

		expect(found).toEqual({ value: "Calasetta", from: "address_levels" })
	})

	it("skips an empty level rather than returning it as the locality", () => {
		const found = localityOf({ address_levels: [{ value: "Lazio" }, { value: "  " }] })

		expect(found).toEqual({ value: "Lazio", from: "address_levels" })
	})

	it("answers undefined when neither column carries a value", () => {
		// A row with no locality is distinguishable from a row whose locality is the empty string,
		// so a caller counting localities counts rows that have one.
		expect(localityOf({ postal_city: null, address_levels: [] })).toBeUndefined()
		expect(localityOf({})).toBeUndefined()
	})
})
