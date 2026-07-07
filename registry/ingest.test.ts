/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import {
	type GeocodeAddress,
	type RawGeocode,
	delimiterFor,
	geocodeAddressVia,
	inferMapping,
	ingestRows,
	parseCSV,
	streamRows,
} from "./ingest.js"

const CSV = `id,name,org,street,city,state,zip,phone,email
c1,Dr. Robert Smith,Acme Health LLC,123 Main St,Portland,OR,97201,503-555-0100,Bob@Acme.org
c2,Maria Garcia,,50 Elm Ave,Seattle,WA,98101,,maria@example.com`

describe("parseCSV", () => {
	it("parses a header row into keyed objects", () => {
		const rows = parseCSV(CSV)
		expect(rows).toHaveLength(2)
		expect(rows[0]).toMatchObject({ id: "c1", name: "Dr. Robert Smith", state: "OR" })
	})
})

describe("inferMapping", () => {
	it("maps a tidy header to the obvious fields", () => {
		const m = inferMapping(["id", "name", "org", "street", "city", "state", "zip", "phone", "email"])
		expect(m).toMatchObject({ id: "id", organization: "org", phone: "phone", email: "email", name: "name" })
		expect(m.address).toEqual(["street", "city", "state", "zip"])
	})

	it("reads a real bespoke header (TX HHSC facility), id beating org despite 'Facility'", () => {
		const m = inferMapping([
			"Facility ID",
			"Facility Name",
			"Physical Address",
			"Physical Address CITY",
			"Physical Address State",
			"Physical Address Zipcode",
			"Facility Phone Number",
		])
		expect(m.id).toBe("Facility ID")
		expect(m.organization).toBe("Facility Name")
		expect(m.phone).toBe("Facility Phone Number")
		expect(m.address).toEqual([
			"Physical Address",
			"Physical Address CITY",
			"Physical Address State",
			"Physical Address Zipcode",
		])
	})

	it("prefers org over a person name, and a dedicated email over the generic sweep", () => {
		const m = inferMapping(["Organization Name", "Contact First Name", "Contact Last Name", "Contact E-mail"])
		expect(m.organization).toBe("Organization Name")
		expect(m.email).toBe("Contact E-mail")
		expect(m.name).toEqual(["Contact First Name", "Contact Last Name"])
	})

	it("matches whole tokens — 'Statement' is not an address 'state'", () => {
		expect(inferMapping(["Statement", "Notes"])).toEqual({})
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
		const [a, b] = await ingestRows(parseCSV(CSV), mapping, { geocodeAddress: stubGeocode })

		expect(a!.id).toBe("c1")
		expect(a!.name).toEqual({ prefix: "Dr.", given: "Robert", family: "Smith" })
		expect(a!.organization?.canonical).toBe("acme health")
		expect(a!.organization?.designations).toEqual(["llc"])
		expect(a!.phone).toBe("503-555-0100")
		expect(a!.email).toBe("bob@acme.org") // lowercased
		expect(a!.address?.geocode?.tier).toBe("address_point")
		// The address column-join feeds the geocoder (comma-joined by default; #694 flip).
		expect(a!.address?.formatted).toBe("123 Main St, Portland, OR, 97201")

		expect(b!.name).toEqual({ given: "Maria", family: "Garcia" })
		expect(b!.organization).toBeUndefined() // empty org column
		expect(b!.phone).toBeUndefined()
	})

	it("comma-joins a multi-column address by default, space when overridden (#694 flip)", async () => {
		const [dflt] = await ingestRows(parseCSV(CSV), mapping, { geocodeAddress: stubGeocode })
		expect(dflt!.address?.formatted).toBe("123 Main St, Portland, OR, 97201") // default: comma-join (#694, validated)
		const [space] = await ingestRows(parseCSV(CSV), mapping, { geocodeAddress: stubGeocode, addressSeparator: " " })
		expect(space!.address?.formatted).toBe("123 Main St Portland OR 97201") // override → legacy space-join (byte-stable A/B)
	})

	it("falls back to the row index when no id column maps", async () => {
		const [first] = await ingestRows(parseCSV(CSV), { name: "name" })
		expect(first!.id).toBe("0")
	})

	it("leaves the address unresolved when no geocoder is injected", async () => {
		const [first] = await ingestRows(parseCSV(CSV), mapping)
		expect(first!.address).toBeUndefined()
	})
})

describe("streamRows (lazy delimited ingest)", () => {
	const dirs: string[] = []
	const tmp = (): string => {
		const d = mkdtempSync(join(tmpdir(), "mw-stream-"))
		dirs.push(d)

		return d
	}
	afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

	it("infers the delimiter from the extension", () => {
		expect(delimiterFor("/x/data.tsv")).toBe("tab")
		expect(delimiterFor("/x/DATA.TSV")).toBe("tab")
		expect(delimiterFor("/x/data.csv")).toBe("comma")
		expect(delimiterFor("/x/data")).toBe("comma")
	})

	it("streams a TSV as header-keyed rows, preserving the original header names", async () => {
		const file = join(tmp(), "f.tsv")
		writeFileSync(
			file,
			"Facility Name\tPhysical Address\tCITY\nAVIR\t214 Jones Rd\tElkhart\nFoo Clinic\t1 Main St\tPalestine\n"
		)
		const rows: Record<string, string>[] = []

		for await (const r of streamRows(file)) {
			rows.push(r)
		}
		expect(rows).toHaveLength(2)
		expect(Object.keys(rows[0]!)).toEqual(["Facility Name", "Physical Address", "CITY"])
		expect(rows[0]!["Facility Name"]).toBe("AVIR")
		expect(rows[1]!["CITY"]).toBe("Palestine")
	})

	it("preserves empty fields — consecutive delimiters do not collapse (NPPES-style alignment)", async () => {
		// The regression CSVSpliterator failed: a row with consecutive empties must keep every column,
		// or every value after the empty run shifts left (a 330-col NPPES row collapses to ~40 + misaligns).
		const file = join(tmp(), "f.tsv")
		writeFileSync(file, "npi\torg\tlast\tfirst\tstate\n123\t\t\t\tNE\n")
		const rows: Record<string, string>[] = []

		for await (const r of streamRows(file)) {
			rows.push(r)
		}
		expect(rows).toHaveLength(1)
		expect(rows[0]).toEqual({ npi: "123", org: "", last: "", first: "", state: "NE" })
	})

	it("closes the file handle on an early break (no leaked fd)", async () => {
		const file = join(tmp(), "f.tsv")
		writeFileSync(file, "a\tb\n1\t2\n3\t4\n5\t6\n")
		let count = 0

		for await (const _ of streamRows(file)) {
			count++

			if (count === 1) break // abandon the generator early → finally must close the handle
		}
		expect(count).toBe(1)
		// Re-stream the same file fully — succeeds because the prior handle was released.
		const all: Record<string, string>[] = []

		for await (const r of streamRows(file)) {
			all.push(r)
		}
		expect(all).toHaveLength(3)
	})

	it("threads straight into ingestRows (async-iterable source)", async () => {
		const file = join(tmp(), "f.tsv")
		writeFileSync(file, "name\taddress\nJohn Smith\t123 Main St\nMaria Garcia\t50 Elm Ave\n")
		const records = await ingestRows(streamRows(file), { name: "name", address: "address" })
		expect(records).toHaveLength(2)
		expect(records[0]!.name).toEqual({ given: "John", family: "Smith" })
		expect(records[1]!.name).toEqual({ given: "Maria", family: "Garcia" })
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

	it("parseAndGeocode variant: one combined call wires the same PostalAddress + coordinate", async () => {
		let calls = 0
		const geocoded = geocodeAddressVia({
			parseAndGeocode: async () => {
				calls++

				return { components, geo: { lat: 45.5, lon: -122.6, resolution_tier: "interpolated", uncertainty_m: 120 } }
			},
			country: "US",
		})

		const address = await geocoded("123 Main St, Portland OR 97201")
		expect(calls).toBe(1)
		expect(address?.canonicalKey).toBe("123|main|st|portland|or|97201|us")
		expect(address?.geocode?.coordinate).toEqual({ latitude: 45.5, longitude: -122.6 })
		expect(address?.geocode?.tier).toBe("interpolated")
	})

	it("parseAndGeocode with geo null returns the parsed-but-unlocated address", async () => {
		const geocoded = geocodeAddressVia({ parseAndGeocode: async () => ({ components, geo: null }) })
		const address = await geocoded("123 Main St")
		expect(address?.canonicalKey).toBeTruthy()
		expect(address?.geocode).toBeUndefined()
	})
})
