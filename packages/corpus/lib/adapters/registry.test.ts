/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { InMemoryAdapterRegistry } from "#adapters/registry"
import { AddressRole, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

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
		addressRole: AddressRole.Premise,
		register: "test-register",
		surface: SurfaceOrigin.Attested,
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
