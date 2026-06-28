/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { COMPONENT_TO_LIBPOSTAL, type ParseMatch, toLibpostalComponents } from "./index.js"

test("toLibpostalComponents: maps our classifications to libpostal labels, in order", () => {
	const matches: ParseMatch[] = [
		{ classification: "house_number", value: "1600" },
		{ classification: "street", value: "Pennsylvania Ave NW" },
		{ classification: "locality", value: "Washington" },
		{ classification: "region", value: "DC" },
		{ classification: "postcode", value: "20500" },
	]
	expect(toLibpostalComponents(matches)).toEqual([
		{ label: "house_number", value: "1600" },
		{ label: "road", value: "Pennsylvania Ave NW" },
		{ label: "city", value: "Washington" },
		{ label: "state", value: "DC" },
		{ label: "postcode", value: "20500" },
	])
})

test("toLibpostalComponents: passes unmapped classifications through unchanged", () => {
	expect(toLibpostalComponents([{ classification: "some_future_tag", value: "x" }])).toEqual([
		{ label: "some_future_tag", value: "x" },
	])
})

test("COMPONENT_TO_LIBPOSTAL: the core US/EU mappings hold", () => {
	expect(COMPONENT_TO_LIBPOSTAL.street).toBe("road")
	expect(COMPONENT_TO_LIBPOSTAL.locality).toBe("city")
	expect(COMPONENT_TO_LIBPOSTAL.region).toBe("state")
	expect(COMPONENT_TO_LIBPOSTAL.postcode).toBe("postcode")
})
