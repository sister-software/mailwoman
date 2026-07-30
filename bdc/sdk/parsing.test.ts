/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fixture (`../test-fixtures/availability-micro.csv`) is a byte-realistic 12-column FCC BDC
 *   availability CSV: 2 providers × 2 census blocks, technology codes 50 (fiber) and 40 (cable), one row
 *   with a leading-zero `location_id`, one row whose `brand_name` is quoted with an embedded comma (byte
 *   scanner quote-toggle coverage), and one exact duplicate row (reserved for a later task's dedup
 *   coverage — this test only asserts the raw parse yields it unfiltered).
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { expect, test } from "vitest"

import type { ProviderID } from "./common.ts"
import { takeAvailabilityLine, type BDCAvailabilityRow } from "./parsing.ts"

const fixturePath = join(import.meta.dirname, "..", "test-fixtures", "availability-micro.csv")
const fixtureBuffer = readFileSync(fixturePath)

function parseFixture(providerID = 999 as ProviderID): BDCAvailabilityRow[] {
	return Array.from(takeAvailabilityLine(fixtureBuffer, providerID))
}

test("takeAvailabilityLine: yields exactly 6 rows, skipping the header", () => {
	const rows = parseFixture()

	expect(rows).toHaveLength(6)
})

test("takeAvailabilityLine: geoid decodes to a 15-character string (2a decision 3)", () => {
	const rows = parseFixture()

	for (const row of rows) {
		expect(typeof row.geoid).toBe("string")
		expect(row.geoid).toHaveLength(15)
	}

	expect(rows.map((row) => row.geoid)).toEqual([
		"060014001001001",
		"060014001001002",
		"060014001001001",
		"060014001001002",
		"060014001001001",
		"060014001001001",
	])
})

test("takeAvailabilityLine: location_id stays a string, preserving leading zeros (2a decision 1)", () => {
	const rows = parseFixture()
	const leadingZeroRow = rows.find((row) => row.location_id === "0000000456")

	expect(leadingZeroRow).toBeDefined()
	expect(typeof leadingZeroRow!.location_id).toBe("string")
	expect(leadingZeroRow!.location_id).toHaveLength(10)

	// Every location_id is a string, not just the leading-zero one.
	for (const row of rows) {
		expect(typeof row.location_id).toBe("string")
	}
})

test("takeAvailabilityLine: speeds and technology_code parse as numbers", () => {
	const rows = parseFixture()

	for (const row of rows) {
		expect(typeof row.technology_code).toBe("number")
		expect(typeof row.max_advertised_download_speed).toBe("number")
		expect(typeof row.max_advertised_upload_speed).toBe("number")
	}

	expect(rows.map((row) => row.technology_code).toSorted()).toEqual([40, 40, 40, 50, 50, 50])

	const firstRow = rows[0]!
	expect(firstRow.max_advertised_download_speed).toBe(1000)
	expect(firstRow.max_advertised_upload_speed).toBe(1000)
})

test("takeAvailabilityLine: low_latency narrows to the 0|1 literal union", () => {
	const rows = parseFixture()

	expect(rows.map((row) => row.low_latency)).toEqual([1, 0, 1, 0, 1, 1])

	for (const row of rows) {
		expect(row.low_latency === 0 || row.low_latency === 1).toBe(true)
	}
})

test("takeAvailabilityLine: business_residential_code decodes to its ASCII string", () => {
	const rows = parseFixture()

	expect(rows.map((row) => row.business_residential_code)).toEqual(["R", "B", "X", "R", "R", "B"])
})

test("takeAvailabilityLine: provider_id always comes from the function parameter, never the CSV column", () => {
	const rows = parseFixture(555 as ProviderID)

	for (const row of rows) {
		expect(row.provider_id).toBe(555)
	}
})

test("takeAvailabilityLine: a quoted brand_name with an embedded comma doesn't desync column alignment", () => {
	const rows = parseFixture()
	// Row 3 (index 2) has `"Frontera, Inc."` as its quoted brand_name — the comma inside must not be
	// mistaken for a field delimiter, or every subsequent column on that row would shift.
	const quotedRow = rows[2]!

	expect(quotedRow.location_id).toBe("1000000003")
	expect(quotedRow.technology_code).toBe(40)
	expect(quotedRow.geoid).toBe("060014001001001")
})

test("takeAvailabilityLine: the fixture's reserved duplicate row survives the raw parse unfiltered", () => {
	const rows = parseFixture()

	const duplicates = rows.filter(
		(row) => row.location_id === "1000000001" && row.geoid === "060014001001001" && row.technology_code === 50
	)

	expect(duplicates).toHaveLength(2)
})
