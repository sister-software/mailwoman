/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import {
	createGeonamesPostalAdapter,
	GEONAMES_POSTAL_ADAPTER_ID,
	GEONAMES_POSTAL_DEFAULT_LICENSE,
} from "@mailwoman/corpus/adapters/geonames-postal/adapter"
import { join } from "@mailwoman/platform/path"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import type { CanonicalRow } from "#types"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

let scratch: string

beforeEach(async () => {
	scratch = fixtures.use(await temporaryDirectory("mailwoman-gnpostal-")).path
})

// 12-column GeoNames postal row: country, postcode, place, admin1_name, admin1_code, admin2_*, admin3_*, lat, lon, accuracy.
function row(country: string, postcode: string, place: string, admin1: string): string {
	const cols = Array.from({ length: 12 }).fill("")
	cols[0] = country
	cols[1] = postcode
	cols[2] = place
	cols[3] = admin1
	cols[9] = "42.5"
	cols[10] = "1.6"
	cols[11] = "6"

	return cols.join("\t")
}

async function writeFixture(...rows: string[]): Promise<string> {
	const p = join(scratch, "XX.txt")
	await writeLocalTextFile(rows.join("\n") + "\n", p)

	return p
}

async function collect(p: string, extra?: Record<string, unknown>): Promise<CanonicalRow[]> {
	const out: CanonicalRow[] = []

	for await (const r of createGeonamesPostalAdapter().rows({ inputPath: p, ...extra })) {
		out.push(r)
	}

	return out
}

describe("geonames-postal adapter", () => {
	it("has the expected id and license", () => {
		const a = createGeonamesPostalAdapter()
		expect(a.id).toBe(GEONAMES_POSTAL_ADAPTER_ID)
		expect(a.defaultLicense).toBe(GEONAMES_POSTAL_DEFAULT_LICENSE)
	})

	it("emits postcode-first variants with region when admin1 differs from the place", async () => {
		const rows = await collect(
			await writeFixture(row("DE", "10115", "Berlin", "Berlin"), row("FR", "75001", "Paris", "Île-de-France"))
		)

		const fr = rows.filter((r) => r.country === "FR")
		const byRaw = Object.fromEntries(fr.map((r) => [r.raw, r]))
		expect(byRaw["75001 Paris"]?.components).toEqual({ postcode: "75001", locality: "Paris" })

		expect(byRaw["75001 Paris, Île-de-France"]?.components).toEqual({
			postcode: "75001",
			locality: "Paris",
			region: "Île-de-France",
		})

		for (const r of fr) {
			expect(r.license).toBe(GEONAMES_POSTAL_DEFAULT_LICENSE)
			expect(r.source).toBe(GEONAMES_POSTAL_ADAPTER_ID)
		}
	})

	it("drops the region variant when admin1 just repeats the place (no 'X X' noise)", async () => {
		// Berlin (postcode 10115, admin1 'Berlin') — region == place, so only the {postcode,locality} row.
		const rows = await collect(await writeFixture(row("DE", "10115", "Berlin", "Berlin")))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.components).toEqual({ postcode: "10115", locality: "Berlin" })
		expect(rows[0]?.raw).toBe("10115 Berlin")
	})

	it("skips rows missing postcode or place", async () => {
		const rows = await collect(
			await writeFixture(
				row("DE", "", "Nowhere", "Bayern"),
				row("DE", "80331", "", "Bayern"),
				row("DE", "80331", "München", "Bayern")
			)
		)

		expect(rows.every((r) => r.components.locality === "München")).toBe(true)
	})

	it("honors the country filter and the row limit", async () => {
		const p = await writeFixture(row("DE", "80331", "München", "Bayern"), row("FR", "75001", "Paris", "Île-de-France"))
		expect((await collect(p, { country: "DE" })).every((r) => r.country === "DE")).toBe(true)
		expect(await collect(p, { limit: 1 })).toHaveLength(1)
	})
})
