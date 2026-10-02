/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { stableSourceID, stableSourceIDFromParts } from "#adapters/source-id"

describe("stableSourceID", () => {
	it("is deterministic across calls", () => {
		const id1 = stableSourceID("wof-admin", { locality: "Paris", country: "France" })
		const id2 = stableSourceID("wof-admin", { locality: "Paris", country: "France" })
		expect(id1).toBe(id2)
	})

	it("is order-independent on component key order", () => {
		const id1 = stableSourceID("wof-admin", { locality: "Paris", country: "France" })
		const id2 = stableSourceID("wof-admin", { country: "France", locality: "Paris" })
		expect(id1).toBe(id2)
	})

	it("namespaces by adapter id", () => {
		const a = stableSourceID("wof-admin", { locality: "Paris" })
		const b = stableSourceID("openaddresses", { locality: "Paris" })
		expect(a).not.toBe(b)
		expect(a.startsWith("wof-admin-")).toBe(true)
		expect(b.startsWith("openaddresses-")).toBe(true)
	})

	it("changes when any component value changes", () => {
		const a = stableSourceID("wof-admin", { locality: "Paris" })
		const b = stableSourceID("wof-admin", { locality: "Paris " })
		expect(a).not.toBe(b)
	})
})

describe("stableSourceIDFromParts", () => {
	it("agrees with stableSourceID on the same keys, which share one hashed byte stream", () => {
		expect(stableSourceIDFromParts("wof-admin", { locality: "Paris" })).toBe(
			stableSourceID("wof-admin", { locality: "Paris" })
		)
	})

	it("reads an omitted value and an empty one as the same key", () => {
		expect(stableSourceIDFromParts("test", { slot: undefined })).toBe(stableSourceIDFromParts("test", { slot: "" }))
	})

	it("distinguishes a variant index, which is not a component tag", () => {
		expect(stableSourceIDFromParts("test", { variant: "1" })).not.toBe(
			stableSourceIDFromParts("test", { variant: "2" })
		)
	})
})
