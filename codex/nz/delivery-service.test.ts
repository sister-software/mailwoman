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
	NZ_PRIVATE_BOX_ALIAS,
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

describe("NZ_PRIVATE_BOX_ALIAS", () => {
	it("is marked officiallyInvalid — not a valid ADV358 Delivery Service Type", () => {
		// ADV358 (Oct 2021) lists exactly six types; 'Private Box' is not among them.
		// Source: nzpost.co.nz/sites/nz/files/2021-10/adv358-address-standards.pdf (accessed 2026-06-11).
		// Operator ruling 2026-06-11: recognize-as-used with this citation.
		expect(NZ_PRIVATE_BOX_ALIAS.officiallyInvalid).toBe(true)
	})

	it("has the same identifier rule as PO Box — required-if-allocated", () => {
		const poBox = NZ_DELIVERY_SERVICE_TYPES.find((t) => t.type === "PO Box")!
		expect(NZ_PRIVATE_BOX_ALIAS.identifier).toBe(poBox.identifier)
	})

	it("is NOT present in NZ_DELIVERY_SERVICE_TYPES (kept separate per operator ruling)", () => {
		const types = NZ_DELIVERY_SERVICE_TYPES.map((t) => t.type)
		expect(types).not.toContain("Private Box")
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

	it("ADV358 types do not carry the colloquial flag", () => {
		expect(matchNzDeliveryService("PO Box 24999")?.colloquial).toBeUndefined()
		expect(matchNzDeliveryService("Private Bag 106999")?.colloquial).toBeUndefined()
		expect(matchNzDeliveryService("Counter Delivery")?.colloquial).toBeUndefined()
	})

	it("recognizes 'Private Box' as the colloquial NZ alias — operator ruling 2026-06-11", () => {
		// 'Private Box' is NOT a valid ADV358 type. NZ Post's live standards pages do not list it.
		// Source: adv358-address-standards.pdf (Oct 2021) + nzpost.co.nz/business/shipping-in-nz/
		//   addressing-standards (accessed 2026-06-11). Operator authorizes recognition with citation.
		expect(matchNzDeliveryService("Private Box 102")).toMatchObject({
			type: "Private Box",
			id: "102",
			colloquial: true,
		})
		expect(matchNzDeliveryService("private box 24999")).toMatchObject({
			type: "Private Box",
			id: "24999",
			colloquial: true,
		})
		expect(isNzDeliveryService("Private Box 102")).toBe(true)
	})

	it("rejects the forms ADV358 names as errors", () => {
		expect(matchNzDeliveryService("PB 39990")).toBeNull()
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

	it("normalizes 'Private Box' to its recognized surface form", () => {
		// The colloquial alias normalizes to 'Private Box <id>' (preserves the label used on real mail).
		expect(normalizeNzDeliveryService("private box 102")).toBe("Private Box 102")
		expect(normalizeNzDeliveryService("Private Box 24999")).toBe("Private Box 24999")
	})

	it("round-trips: every normalized form still matches", () => {
		for (const raw of [
			"PO Box 24999",
			"Private Bag",
			"CMB B99",
			"Counter Delivery",
			"Poste Restante",
			"Private Box 102",
		]) {
			expect(isNzDeliveryService(normalizeNzDeliveryService(raw)), `round-trip for "${raw}"`).toBe(true)
		}
	})

	it("passes through non-matches unchanged", () => {
		expect(normalizeNzDeliveryService("PB 39990")).toBe("PB 39990")
	})
})
