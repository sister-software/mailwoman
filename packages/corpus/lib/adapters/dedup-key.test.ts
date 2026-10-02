/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { canonicalDedupKey } from "#adapters/dedup-key"
import type { CanonicalRow } from "#types"

function fixtureRow(overrides: Partial<CanonicalRow> = {}): CanonicalRow {
	return {
		raw: "Paris",
		components: { locality: "Paris" },
		country: "FR",
		source: "test",
		source_id: "test-1",
		corpus_version: "0.1.0",
		license: "CC0-1.0",
		...overrides,
	}
}

describe("canonicalDedupKey", () => {
	it("treats whitespace-only differences in raw as duplicates", () => {
		const a = fixtureRow({ raw: "1600 Pennsylvania Ave, Washington" })
		const b = fixtureRow({ raw: "  1600   Pennsylvania Ave,  Washington  " })
		expect(canonicalDedupKey(a)).toBe(canonicalDedupKey(b))
	})

	it("treats case differences in raw as duplicates", () => {
		const a = fixtureRow({ raw: "Paris" })
		const b = fixtureRow({ raw: "PARIS" })
		expect(canonicalDedupKey(a)).toBe(canonicalDedupKey(b))
	})

	it("treats different components as non-duplicates", () => {
		const a = fixtureRow({ components: { locality: "Paris" } })
		const b = fixtureRow({ components: { locality: "Lyon" } })
		expect(canonicalDedupKey(a)).not.toBe(canonicalDedupKey(b))
	})

	it("excludes license + provenance: same row from two adapters is a duplicate", () => {
		const a = fixtureRow({ source: "wof-admin", source_id: "1", license: "CC0-1.0" })
		const b = fixtureRow({ source: "osm-places", source_id: "2", license: "ODbL-1.0" })
		expect(canonicalDedupKey(a)).toBe(canonicalDedupKey(b))
	})

	it("distinguishes synthetic rows by augmentation method", () => {
		const a = fixtureRow({ recipe: { recipe: "case-upper", base_source_id: "test-1" } })
		const b = fixtureRow({ recipe: { recipe: "accent-strip", base_source_id: "test-1" } })
		const c = fixtureRow()
		expect(canonicalDedupKey(a)).not.toBe(canonicalDedupKey(b))
		expect(canonicalDedupKey(a)).not.toBe(canonicalDedupKey(c))
	})

	it("separates the same address in two countries", () => {
		const a = fixtureRow({ country: "FR" })
		const b = fixtureRow({ country: "GP" })
		expect(canonicalDedupKey(a)).not.toBe(canonicalDedupKey(b))
	})
})
