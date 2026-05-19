/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"
import { InMemoryAdapterRegistry, canonicalDedupKey, stableSourceId, streamingSha256 } from "./adapter.js"
import type { CanonicalRow, CorpusAdapter } from "./types.js"

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

function fixtureAdapter(id: string): CorpusAdapter {
	return {
		id,
		defaultLicense: "CC0-1.0",
		description: `fixture adapter ${id}`,
		async *rows() {
			yield fixtureRow({ source: id, source_id: `${id}-1` })
		},
	}
}

describe("InMemoryAdapterRegistry", () => {
	it("registers and looks up by id", () => {
		const r = new InMemoryAdapterRegistry()
		const a = fixtureAdapter("wof-admin")
		r.register(a)
		expect(r.get("wof-admin")).toBe(a)
		expect(r.get("missing")).toBeUndefined()
		expect(r.ids()).toEqual(["wof-admin"])
		expect(r.list()).toEqual([a])
	})

	it("throws on duplicate id", () => {
		const r = new InMemoryAdapterRegistry()
		r.register(fixtureAdapter("wof-admin"))
		expect(() => r.register(fixtureAdapter("wof-admin"))).toThrow(/already registered/)
	})

	it("preserves insertion order in list/ids", () => {
		const r = new InMemoryAdapterRegistry()
		r.register(fixtureAdapter("a"))
		r.register(fixtureAdapter("c"))
		r.register(fixtureAdapter("b"))
		expect(r.ids()).toEqual(["a", "c", "b"])
	})
})

describe("stableSourceId", () => {
	it("is deterministic across calls", () => {
		const id1 = stableSourceId("wof-admin", { locality: "Paris", country: "France" })
		const id2 = stableSourceId("wof-admin", { locality: "Paris", country: "France" })
		expect(id1).toBe(id2)
	})

	it("is order-independent on component key order", () => {
		const id1 = stableSourceId("wof-admin", { locality: "Paris", country: "France" })
		const id2 = stableSourceId("wof-admin", { country: "France", locality: "Paris" })
		expect(id1).toBe(id2)
	})

	it("namespaces by adapter id", () => {
		const a = stableSourceId("wof-admin", { locality: "Paris" })
		const b = stableSourceId("openaddresses", { locality: "Paris" })
		expect(a).not.toBe(b)
		expect(a.startsWith("wof-admin-")).toBe(true)
		expect(b.startsWith("openaddresses-")).toBe(true)
	})

	it("changes when any component value changes", () => {
		const a = stableSourceId("wof-admin", { locality: "Paris" })
		const b = stableSourceId("wof-admin", { locality: "Paris " })
		expect(a).not.toBe(b)
	})
})

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
		const a = fixtureRow({ synth: { method: "case-upper", base_source_id: "test-1" } })
		const b = fixtureRow({ synth: { method: "accent-strip", base_source_id: "test-1" } })
		const c = fixtureRow()
		expect(canonicalDedupKey(a)).not.toBe(canonicalDedupKey(b))
		expect(canonicalDedupKey(a)).not.toBe(canonicalDedupKey(c))
	})
})

describe("streamingSha256", () => {
	it("matches a one-shot hash of the concatenated chunks", () => {
		const incremental = streamingSha256()
		incremental.update("hello, ")
		incremental.update("world")
		expect(incremental.digest()).toBe("09ca7e4eaa6e8ae9c7d261167129184883644d07dfba7cbfbc4c8a2e08360d5b")
	})

	it("is idempotent on digest()", () => {
		const h = streamingSha256()
		h.update("abc")
		const first = h.digest()
		const second = h.digest()
		expect(first).toBe(second)
	})

	it("rejects update after digest", () => {
		const h = streamingSha256()
		h.update("abc")
		h.digest()
		expect(() => h.update("def")).toThrow(/after digest/)
	})
})
