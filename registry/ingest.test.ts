/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { type GeocodeAddress, type RawGeocode, geocodeAddressVia, ingestRows, parseCsv } from "./ingest.js"

const CSV = `id,name,org,street,city,state,zip,phone,email
c1,Dr. Robert Smith,Acme Health LLC,123 Main St,Portland,OR,97201,503-555-0100,Bob@Acme.org
c2,Maria Garcia,,50 Elm Ave,Seattle,WA,98101,,maria@example.com`

describe("parseCsv", () => {
	it("parses a header row into keyed objects", () => {
		const rows = parseCsv(CSV)
		expect(rows).toHaveLength(2)
		expect(rows[0]).toMatchObject({ id: "c1", name: "Dr. Robert Smith", state: "OR" })
	})
})

describe("ingestRows", () => {
	// A stub geocoder — the real one is injected at the CLI boundary.
	const stubGeocode: GeocodeAddress = (raw) => ({
		components: {},
		canonicalKey: raw
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, " ")
			.trim()
			.replace(/\s+/g, "|"),
		formatted: raw,
		geocode: { coordinate: { latitude: 45.5, longitude: -122.6 }, tier: "address_point", uncertaintyMeters: 1 },
	})

	const mapping = {
		id: "id",
		name: "name",
		organization: "org",
		address: ["street", "city", "state", "zip"],
		phone: "phone",
		email: "email",
	}

	it("normalizes each row: parsed name, canonical org, geocoded address, phone/email", async () => {
		const [a, b] = await ingestRows(parseCsv(CSV), mapping, { geocodeAddress: stubGeocode })

		expect(a!.id).toBe("c1")
		expect(a!.name).toEqual({ prefix: "Dr.", given: "Robert", family: "Smith" })
		expect(a!.organization?.canonical).toBe("acme health")
		expect(a!.organization?.designations).toEqual(["llc"])
		expect(a!.phone).toBe("503-555-0100")
		expect(a!.email).toBe("bob@acme.org") // lowercased
		expect(a!.address?.geocode?.tier).toBe("address_point")
		// The address column-join feeds the geocoder.
		expect(a!.address?.formatted).toBe("123 Main St Portland OR 97201")

		expect(b!.name).toEqual({ given: "Maria", family: "Garcia" })
		expect(b!.organization).toBeUndefined() // empty org column
		expect(b!.phone).toBeUndefined()
	})

	it("falls back to the row index when no id column maps", async () => {
		const [first] = await ingestRows(parseCsv(CSV), { name: "name" })
		expect(first!.id).toBe("0")
	})

	it("leaves the address unresolved when no geocoder is injected", async () => {
		const [first] = await ingestRows(parseCsv(CSV), mapping)
		expect(first!.address).toBeUndefined()
	})
})

describe("geocodeAddressVia", () => {
	const components = {
		house_number: "123",
		street: "Main",
		street_suffix: "St",
		locality: "Portland",
		region: "OR",
		postcode: "97201",
		country: "US",
	}

	it("wires parse + geocode into a PostalAddress with the canonical key and coordinate", async () => {
		const geocoded = geocodeAddressVia({
			parse: () => components,
			geocode: (): RawGeocode => ({ lat: 45.5, lon: -122.6, resolution_tier: "interpolated", uncertainty_m: 120 }),
			country: "US",
		})

		const address = await geocoded("123 Main St, Portland OR 97201")
		expect(address?.canonicalKey).toBe("123|main|st|portland|or|97201|us")
		expect(address?.geocode?.coordinate).toEqual({ latitude: 45.5, longitude: -122.6 })
		expect(address?.geocode?.tier).toBe("interpolated")
		expect(address?.geocode?.uncertaintyMeters).toBe(120)
	})

	it("returns the parsed-but-unlocated address when geocoding can't place it", async () => {
		const geocoded = geocodeAddressVia({ parse: () => components, geocode: () => null })
		const address = await geocoded("123 Main St")
		expect(address?.canonicalKey).toBeTruthy()
		expect(address?.geocode).toBeUndefined()
	})
})
