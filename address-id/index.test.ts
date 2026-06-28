/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { createPostalAddressID, isPostalAddressID, parsePostalAddressID } from "./index.js"

const AUSTIN = { latitude: 30.2672, longitude: -97.7431 }

describe("createPostalAddressID", () => {
	it("produces a well-formed `<state>.<cell>.<hash>` key", () => {
		const id = createPostalAddressID({ coordinate: AUSTIN, address: "100 Congress Ave, Austin, TX 78701" })
		expect(isPostalAddressID(id)).toBe(true)
		const parsed = parsePostalAddressID(id)
		expect(parsed).not.toBeNull()
		expect(parsed!.state).toBe("tx") // plucked from the ZIP
		expect(parsed!.hash).toHaveLength(16)
	})

	it("is deterministic — same inputs, same key", () => {
		const input = { coordinate: AUSTIN, address: "100 Congress Ave, Austin, TX 78701" }
		expect(createPostalAddressID(input)).toBe(createPostalAddressID(input))
	})

	it("canonicalizes case + whitespace so trivially-different strings key identically", () => {
		const a = createPostalAddressID({ coordinate: AUSTIN, address: "100 Congress Ave, Austin, TX 78701" })
		const b = createPostalAddressID({ coordinate: AUSTIN, address: "100  CONGRESS  AVE,  austin,  tx 78701" })
		expect(a).toBe(b)
	})

	it("is jitter-stable — the same address geocoded ~10 m apart yields the same key", () => {
		const a = createPostalAddressID({ coordinate: AUSTIN, address: "100 Congress Ave, Austin, TX 78701" })
		const jittered = { latitude: AUSTIN.latitude + 1e-4, longitude: AUSTIN.longitude + 1e-4 } // ~14 m
		const b = createPostalAddressID({ coordinate: jittered, address: "100 Congress Ave, Austin, TX 78701" })
		expect(a).toBe(b)
	})

	it("distinguishes a different address at the same place (the content hash differs)", () => {
		const a = createPostalAddressID({ coordinate: AUSTIN, address: "100 Congress Ave, Austin, TX 78701" })
		const b = createPostalAddressID({ coordinate: AUSTIN, address: "200 Congress Ave, Austin, TX 78701" })
		expect(a).not.toBe(b)
	})

	it("distinguishes the same address string at a far-apart place (the cell differs)", () => {
		const seattle = { latitude: 47.6062, longitude: -122.3321 }
		const a = createPostalAddressID({ coordinate: AUSTIN, address: "100 Main St" })
		const b = createPostalAddressID({ coordinate: seattle, address: "100 Main St" })
		expect(a).not.toBe(b)
	})

	it("falls back to `xx` when no state can be plucked, and honors an explicit state", () => {
		const noState = createPostalAddressID({ coordinate: AUSTIN, address: "100 Congress Ave" })
		expect(parsePostalAddressID(noState)!.state).toBe("xx")
		const explicit = createPostalAddressID({ coordinate: AUSTIN, address: "100 Congress Ave", state: "TX" })
		expect(parsePostalAddressID(explicit)!.state).toBe("tx")
	})
})

describe("parsePostalAddressID / isPostalAddressID", () => {
	it("rejects malformed strings", () => {
		for (const bad of ["", "not-an-id", "tx.cell", "texas.aabb.0011223344556677", "tx..0011223344556677"]) {
			expect(isPostalAddressID(bad)).toBe(false)
			expect(parsePostalAddressID(bad)).toBeNull()
		}
	})
})
