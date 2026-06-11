/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	isNzDeliveryService,
	matchNzDeliveryService,
	normalizeNzDeliveryService,
	NZ_DELIVERY_SERVICE_TYPES,
} from "./delivery-service.js"

describe("NZ_DELIVERY_SERVICE_TYPES", () => {
	it("carries exactly the six ADV358 types", () => {
		expect(NZ_DELIVERY_SERVICE_TYPES.map((t) => t.type).sort()).toEqual(
			["CMB", "Counter Delivery", "PO Box", "Poste Restante", "Private Bag", "Response Bag"].sort()
		)
	})

	it("marks the counter services as identifier-less", () => {
		for (const t of NZ_DELIVERY_SERVICE_TYPES) {
			if (t.type === "Counter Delivery" || t.type === "Poste Restante") {
				expect(t.identifier).toBe("not-used")
			}
		}
	})
})

describe("matchNzDeliveryService", () => {
	it("matches the ADV358 examples", () => {
		expect(matchNzDeliveryService("PO Box 24999")).toMatchObject({ type: "PO Box", id: "24999" })
		expect(matchNzDeliveryService("Private Bag 106999")).toMatchObject({ type: "Private Bag", id: "106999" })
		expect(matchNzDeliveryService("Response Bag 500999")).toMatchObject({ type: "Response Bag", id: "500999" })
		expect(matchNzDeliveryService("CMB B99")).toMatchObject({ type: "CMB", id: "B99" })
		expect(matchNzDeliveryService("Counter Delivery")).toMatchObject({ type: "Counter Delivery" })
		expect(matchNzDeliveryService("Poste Restante")).toMatchObject({ type: "Poste Restante" })
	})

	it("allows an identifier-less Private Bag (ADV358: identifier not always allocated)", () => {
		expect(matchNzDeliveryService("Private Bag")).toMatchObject({ type: "Private Bag" })
		expect(matchNzDeliveryService("Private Bag")?.id).toBeUndefined()
	})

	it("recognizes wild punctuated forms while the standard prefers bare PO", () => {
		expect(matchNzDeliveryService("P.O. Box 23226")).toMatchObject({ type: "PO Box", id: "23226" })
		expect(matchNzDeliveryService("Post Box 12")).toMatchObject({ type: "PO Box", id: "12" })
	})

	it("rejects the forms ADV358 names as errors, and types that don't exist", () => {
		expect(matchNzDeliveryService("PB 39990")).toBeNull()
		expect(matchNzDeliveryService("Private Box 102")).toBeNull()
		expect(matchNzDeliveryService("Locked Bag 1797")).toBeNull() // AU-only designator
	})

	it("does not claim counter services with trailing identifiers or other strings", () => {
		expect(matchNzDeliveryService("Counter Delivery 5")).toBeNull()
		expect(matchNzDeliveryService("Wellington 6140")).toBeNull()
		expect(matchNzDeliveryService(42)).toBeNull()
	})
})

describe("normalizeNzDeliveryService", () => {
	it("canonicalizes to the ADV358 form", () => {
		expect(normalizeNzDeliveryService("p.o. box 24999")).toBe("PO Box 24999")
		expect(normalizeNzDeliveryService("private bag 106999")).toBe("Private Bag 106999")
		expect(normalizeNzDeliveryService("community mail box b99")).toBe("CMB B99")
	})

	it("round-trips: every normalized form still matches", () => {
		for (const raw of ["PO Box 24999", "Private Bag", "CMB B99", "Counter Delivery", "Poste Restante"]) {
			expect(isNzDeliveryService(normalizeNzDeliveryService(raw))).toBe(true)
		}
	})

	it("passes through non-matches unchanged", () => {
		expect(normalizeNzDeliveryService("PB 39990")).toBe("PB 39990")
	})
})
